import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

export function createWorktree(originPath: string, worktreePath: string, branch: string): void {
  // Resolve to actual repo root
  const repoRoot = getRepoRoot(originPath);

  // Check if repo has any commits
  if (!hasCommits(repoRoot)) {
    throw new Error(
      `Repository "${repoRoot}" has no commits yet (HEAD is invalid). ` +
      `Please make at least one initial commit before creating a worktree.`
    );
  }

  // Skip if worktree already exists at this path
  if (worktreeExists(repoRoot, worktreePath)) {
    return;
  }

  // If the worktree directory already exists on disk (stale), clean up first
  if (fs.existsSync(worktreePath)) {
    try {
      execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' });
    } catch {
      // best effort
    }
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (branchExists(repoRoot, branch)) {
    // Branch exists — check if it's already checked out in another worktree
    try {
      execSync(`git worktree add "${worktreePath}" "${branch}"`, {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already checked out')) {
        // Branch is checked out in main worktree or another worktree,
        // create with a detached HEAD then checkout
        execSync(`git worktree add --detach "${worktreePath}"`, {
          cwd: repoRoot,
          stdio: 'pipe',
        });
        execSync(`git checkout "${branch}"`, {
          cwd: worktreePath,
          stdio: 'pipe',
        });
      } else {
        throw e;
      }
    }
  } else {
    // Create new branch based on current HEAD
    execSync(`git worktree add -b "${branch}" "${worktreePath}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
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
