import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Spec } from './types';

/**
 * Run a git command asynchronously via `spawn` (does NOT block the extension
 * host event loop, unlike `execSync`). This matters for `git worktree add`,
 * which checks out the whole tree — for large repos (tens of GB) a synchronous
 * checkout freezes VSCode for minutes and can get the extension host killed
 * mid-checkout, leaving orphaned half-checked-out directories with no `.git`.
 */
function runGitAsync(cwd: string, args: string[], timeoutMs = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    // Force the C locale so git's stderr messages are always English. Callers
    // match on substrings like "already checked out" to decide fallbacks; a
    // localized git (e.g. zh_CN emitting "已经检出") would break that matching.
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    let stderr = '';
    child.stderr?.on('data', d => { stderr += d.toString(); });
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.on('error', err => { if (timer) { clearTimeout(timer); } reject(err); });
    child.on('close', code => {
      if (timer) { clearTimeout(timer); }
      if (code === 0) { resolve(); }
      else { reject(new Error(stderr.trim() || `git ${args.join(' ')} exited with code ${code}`)); }
    });
  });
}

export function isGitRepo(repoPath: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve to the actual git repo root directory.
 * Handles the case where user selects a subdirectory of a repo.
 */
export function getRepoRoot(repoPath: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return repoPath;
  }
}

/**
 * Check if the repo has at least one commit (HEAD is valid).
 */
export function hasCommits(repoPath: string): boolean {
  try {
    execSync('git rev-parse HEAD', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the repo has at least one commit.
 *
 * An empty repo (no commits) has an unborn HEAD, so `git worktree add` cannot
 * base a worktree on it and fails with "has no commits yet". Rather than block
 * the user, create an empty initial commit — this is exactly what the old error
 * message instructed the user to do by hand.
 *
 * A fallback identity is injected only when user.name/user.email are not
 * configured (fresh machine / CI), otherwise `git commit` would abort with
 * "Please tell me who you are". Existing user config is never overridden.
 */
export function ensureInitialCommit(repoPath: string): void {
  if (hasCommits(repoPath)) { return; }

  let identityArgs = '';
  try {
    const email = execSync('git config user.email', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (!email) { throw new Error('no committer identity configured'); }
  } catch {
    identityArgs = '-c user.name="tmux-agent" -c user.email="tmux-agent@localhost"';
  }

  const cmd = `git ${identityArgs} commit --allow-empty -m "Initial commit"`.replace(/\s+/g, ' ').trim();
  execSync(cmd, { cwd: repoPath, stdio: 'pipe' });
}

export function branchExists(repoPath: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify "${branch}"`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a branch exists on any remote (e.g. origin/<branch>).
 * Returns the full remote ref (e.g. "origin/feat/foo") or undefined.
 */
export function remoteBranchExists(repoPath: string, branch: string): string | undefined {
  try {
    const output = execSync(`git branch -r --list "*/${branch}"`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (output) {
      // Return the first matching remote ref (e.g. "origin/feat/foo")
      return output.split('\n')[0].trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch a specific branch from its remote.
 */
export function fetchBranch(repoPath: string, branch: string): void {
  try {
    execSync(`git fetch origin "${branch}"`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {
    // Try fetching from all remotes if origin fails
    try {
      execSync(`git fetch --all`, {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch {
      // best effort
    }
  }
}

/**
 * Check if a worktree already exists at the given path.
 */
export function worktreeExists(originPath: string, worktreePath: string): boolean {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: originPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return output.includes(worktreePath);
  } catch {
    return false;
  }
}

export async function createWorktree(originPath: string, worktreePath: string, branch: string): Promise<void> {
  // Resolve to actual repo root
  const repoRoot = getRepoRoot(originPath);

  // An empty repo has an unborn HEAD, so `git worktree add` cannot base a
  // worktree on it. Auto-create an empty initial commit instead of failing.
  ensureInitialCommit(repoRoot);

  // Skip if worktree already exists at this path
  if (worktreeExists(repoRoot, worktreePath)) {
    return;
  }

  // If the worktree directory already exists on disk (stale/orphaned — e.g. a
  // previous checkout was interrupted and left a half-populated dir with no
  // `.git`), clean it up first. Use async fs.rm so a huge orphaned tree
  // (tens of GB) does NOT freeze the extension host the way fs.rmSync would.
  if (fs.existsSync(worktreePath)) {
    try {
      execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' });
    } catch {
      // best effort
    }
    if (fs.existsSync(worktreePath)) {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
    }
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (branchExists(repoRoot, branch)) {
    // Branch exists locally — check if it's already checked out in another worktree
    try {
      await runGitAsync(repoRoot, ['worktree', 'add', worktreePath, branch]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already checked out')) {
        // Branch is already checked out in the main repo or another worktree.
        // Create the worktree with a DETACHED HEAD pointing at that branch's
        // tip. We must NOT `git checkout <branch>` afterwards — that fails with
        // the same "already checked out" error and leaves the worktree missing.
        await runGitAsync(repoRoot, ['worktree', 'add', '--detach', worktreePath, branch]);
      } else {
        throw e;
      }
    }
  } else {
    // Branch doesn't exist locally — check if it exists on a remote
    const remoteRef = remoteBranchExists(repoRoot, branch);
    if (remoteRef) {
      // Fetch the branch from remote, then create worktree tracking it
      fetchBranch(repoRoot, branch);
      // After fetch, the local tracking branch should be creatable
      try {
        await runGitAsync(repoRoot, ['worktree', 'add', '--track', '-b', branch, worktreePath, remoteRef]);
      } catch {
        // Fallback: if --track fails, try creating from the remote ref directly
        await runGitAsync(repoRoot, ['worktree', 'add', worktreePath, remoteRef]);
        // Create local branch tracking the remote
        await runGitAsync(worktreePath, ['checkout', '-b', branch, '--track', remoteRef]);
      }
    } else {
      // Branch doesn't exist anywhere — create new branch based on current HEAD
      await runGitAsync(repoRoot, ['worktree', 'add', '-b', branch, worktreePath]);
    }
  }
}

/**
 * Ensure every repo in a spec has its worktree present on disk.
 *
 * A spec may have been created in another window where the worktree checkout
 * failed, was aborted, or the directory was later deleted. Switching to such a
 * spec would point the workspace folder and the agent terminal at a
 * nonexistent cwd ("Starting directory (cwd) ... does not exist"). Re-run
 * createWorktree for any repo whose worktree dir is missing so switch/start is
 * self-healing.
 */
export async function ensureSpecWorktrees(spec: Spec): Promise<void> {
  for (const repo of spec.repos) {
    if (fs.existsSync(repo.worktreePath)) { continue; }
    await createWorktree(repo.originPath, repo.worktreePath, repo.branch);
  }
}

export function removeWorktree(originPath: string, worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) {
    return;
  }
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: originPath,
      stdio: 'pipe',
    });
  } catch {
    // If git worktree remove fails, try manual cleanup
    execSync(`git worktree prune`, {
      cwd: originPath,
      stdio: 'pipe',
    });
  }
}

export interface WorktreeStatus {
  staged: number;
  modified: number;
  untracked: number;
  total: number;
  clean: boolean;
}

export function getWorktreeStatus(worktreePath: string): WorktreeStatus {
  if (!fs.existsSync(worktreePath)) {
    return { staged: 0, modified: 0, untracked: 0, total: 0, clean: true };
  }
  try {
    const output = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000, // 5 second timeout
    });
    const lines = output.trim().split('\n').filter(l => l.length > 0);
    let staged = 0;
    let modified = 0;
    let untracked = 0;
    for (const line of lines) {
      const x = line[0];
      const y = line[1];
      if (x === '?' && y === '?') {
        untracked++;
      } else {
        if (x !== ' ' && x !== '?') { staged++; }
        if (y !== ' ' && y !== '?') { modified++; }
      }
    }
    const total = lines.length;
    return { staged, modified, untracked, total, clean: total === 0 };
  } catch {
    return { staged: 0, modified: 0, untracked: 0, total: 0, clean: true };
  }
}

export function commitWorktree(worktreePath: string, message: string, amend: boolean = false): string {
  execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });

  const amendFlag = amend ? '--amend --no-edit' : '';
  const msgFlag = amend ? '' : `-m "${message.replace(/"/g, '\\"')}"`;
  const cmd = `git commit ${amendFlag} ${msgFlag}`.trim();

  try {
    const output = execSync(cmd, {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    return output;
  } catch (e: unknown) {
    const error = e as { stderr?: string; stdout?: string };
    // "nothing to commit" is not a real error
    if (error.stdout?.includes('nothing to commit') || error.stderr?.includes('nothing to commit')) {
      return 'nothing to commit';
    }
    throw e;
  }
}

export function getCurrentBranch(worktreePath: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}
