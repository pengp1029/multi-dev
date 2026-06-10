import * as vscode from 'vscode';
import * as path from 'path';
import { getActiveSpecName } from './state';
import { loadSpec } from './store';
import { WORKTREES_DIR } from './config';

/**
 * VSCode Git extension API types (subset we need).
 * See https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
interface GitExtension {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  state: 'initialized' | 'uninitialized';
  onDidChangeState: vscode.Event<'initialized' | 'uninitialized'>;
  repositories: Repository[];
  openRepository(path: vscode.Uri): Promise<Repository | null>;
  onDidOpenRepository: vscode.Event<Repository>;
  onDidCloseRepository: vscode.Event<Repository>;
}

interface Repository {
  rootUri: vscode.Uri;
}

let cachedApi: GitAPI | undefined;
let repoGuardDisposable: vscode.Disposable | undefined;

/**
 * Get the VSCode built-in Git extension API.
 *
 * Crucially, also wait for `state === 'initialized'`. `getAPI(1)` returns
 * immediately even when state is `'uninitialized'`, in which case
 * `repositories` is empty and `openRepository()` is a no-op — that's the
 * source of the "spec re-open loses GitHub repo info" symptom: our 2-second
 * activation timer would fire while Git was still booting, see no repos,
 * skip everything, and never recover.
 */
async function getGitAPI(): Promise<GitAPI | undefined> {
  if (cachedApi && cachedApi.state === 'initialized') { return cachedApi; }

  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) { return undefined; }

  if (!gitExtension.isActive) {
    await gitExtension.activate();
  }

  const api = gitExtension.exports.getAPI(1);
  cachedApi = api;

  if (api.state !== 'initialized') {
    await new Promise<void>(resolve => {
      const d = api.onDidChangeState(s => {
        if (s === 'initialized') { d.dispose(); resolve(); }
      });
      // Hard cap to avoid hanging forever if Git never initializes.
      setTimeout(() => { d.dispose(); resolve(); }, 5000);
    });
  }
  return api;
}

/**
 * Normalize a filesystem path for stable comparison: resolve `.`/`..`,
 * trim trailing separators, etc. We deliberately do NOT resolve symlinks —
 * VSCode emits paths verbatim, so realpath-ing here would create *new*
 * mismatches against the spec's stored worktree paths.
 */
function normalizePath(p: string): string {
  return path.resolve(p);
}

/**
 * Whether `candidate` is under `WORKTREES_DIR` (i.e. owned by tmux-agent).
 * The guard's job is to close OTHER specs' worktrees that VSCode auto-
 * discovered — not user's regular repos, not parent repos, not the plugin's
 * own repo. Restricting to this directory is what prevents the open/close
 * loop with the Git extension when the parent repo of a worktree gets
 * opened (the worktree's `.git` file points into the parent's
 * `.git/worktrees/<name>`, so closing the parent just causes Git to
 * re-discover and re-open it on the next tick).
 */
function isUnderWorktreesDir(candidate: string): boolean {
  const c = normalizePath(candidate);
  const root = normalizePath(WORKTREES_DIR);
  if (c === root) { return false; }
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  return c.startsWith(rootSep);
}

/**
 * Set of worktree paths owned by the active spec, normalized for comparison.
 */
function getActiveSpecWorktreePaths(): Set<string> {
  const specName = getActiveSpecName();
  if (!specName) { return new Set(); }
  const spec = loadSpec(specName);
  if (!spec) { return new Set(); }
  return new Set(spec.repos.map(r => normalizePath(r.worktreePath)));
}

// Anti-loop bookkeeping. Some VSCode/Git extension versions repeatedly
// re-open a repo immediately after `git.close` (notably parent repos that
// linked worktrees keep a pointer into). Without a cooldown the guard
// fights the Git extension forever, which is exactly what the user sees as
// the GitHub extension's tree "疯狂刷新".
const recentlyClosed = new Map<string, number>();
const CLOSE_COOLDOWN_MS = 5000;

function shouldThrottleClose(p: string): boolean {
  const now = Date.now();
  const last = recentlyClosed.get(p);
  if (last !== undefined && now - last < CLOSE_COOLDOWN_MS) { return true; }
  recentlyClosed.set(p, now);
  if (recentlyClosed.size > 64) {
    for (const [k, t] of recentlyClosed) {
      if (now - t > CLOSE_COOLDOWN_MS * 4) { recentlyClosed.delete(k); }
    }
  }
  return false;
}

/**
 * Start a background guard that closes any repository the Git extension
 * auto-discovered that belongs to **another spec's worktree directory**.
 *
 * Scope rules (the previous implementation closed everything not in the
 * active spec, which caused the loop):
 *   - Only repos under `WORKTREES_DIR` are subject to closing.
 *   - Repos in the active spec are tolerated.
 *   - Anything outside `WORKTREES_DIR` (parent repos, user's regular
 *     project repos, the plugin's own repo) is tolerated unconditionally.
 *   - Repeat closes on the same path are throttled (CLOSE_COOLDOWN_MS).
 */
export function startRepoGuard(context: vscode.ExtensionContext): void {
  repoGuardDisposable?.dispose();

  getGitAPI().then(api => {
    if (!api) { return; }

    repoGuardDisposable = api.onDidOpenRepository(async (repo) => {
      const repoPath = normalizePath(repo.rootUri.fsPath);

      // Out of scope — never touch repos outside our worktrees dir.
      if (!isUnderWorktreesDir(repoPath)) { return; }

      const allowed = getActiveSpecWorktreePaths();
      if (allowed.has(repoPath)) { return; }

      // No active spec → don't aggressively close, just leave it.
      if (allowed.size === 0) { return; }

      if (shouldThrottleClose(repoPath)) {
        console.log('[tmux-agent:gitScm] guard skipping (cooldown):', repoPath);
        return;
      }

      console.log('[tmux-agent:gitScm] guard closing other-spec repo:', repoPath);
      try {
        await vscode.commands.executeCommand('git.close', repo.rootUri);
      } catch {
        // ignore
      }
    });

    context.subscriptions.push({ dispose: () => repoGuardDisposable?.dispose() });
  });
}

/**
 * Wait until every path in `paths` is reported by the Git extension, or
 * until `timeoutMs` elapses. Returns the set of paths still missing.
 */
async function waitForReposOpened(
  api: GitAPI,
  paths: string[],
  timeoutMs: number,
): Promise<Set<string>> {
  const remaining = new Set(paths.map(normalizePath));
  for (const repo of api.repositories) {
    remaining.delete(normalizePath(repo.rootUri.fsPath));
  }
  if (remaining.size === 0) { return remaining; }

  return await new Promise<Set<string>>(resolve => {
    const sub = api.onDidOpenRepository(repo => {
      remaining.delete(normalizePath(repo.rootUri.fsPath));
      if (remaining.size === 0) {
        sub.dispose();
        clearTimeout(timer);
        resolve(remaining);
      }
    });
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(remaining);
    }, timeoutMs);
  });
}

/**
 * Refresh SCM repositories to match the given worktree paths.
 *
 * Apply the same scoping the guard uses: never close a repo outside
 * `WORKTREES_DIR`. Use event-driven waiting (`onDidOpenRepository`) for
 * auto-discovery instead of fixed sleeps, then fall back to manual
 * `openRepository` for anything that didn't show up in time.
 */
export async function refreshGitRepositories(newPaths: string[]): Promise<void> {
  const api = await getGitAPI();
  if (!api) { return; }

  const newPathSet = new Set(newPaths.map(normalizePath));

  // 1. Close repos that are no longer in the new spec — but only ones
  //    actually owned by tmux-agent (under WORKTREES_DIR).
  for (const repo of [...api.repositories]) {
    const p = normalizePath(repo.rootUri.fsPath);
    if (newPathSet.has(p)) { continue; }
    if (!isUnderWorktreesDir(p)) { continue; }
    try {
      await vscode.commands.executeCommand('git.close', repo.rootUri);
    } catch {
      // Silently ignore — the repo may already be gone
    }
  }

  // 2. Wait for the Git extension to auto-discover the new spec's worktrees
  //    via the workspace folder change. Anything still missing after the
  //    timeout we open manually.
  const stillMissing = await waitForReposOpened(api, newPaths, 1500);

  for (const p of stillMissing) {
    try {
      const opened = await api.openRepository(vscode.Uri.file(p));
      if (!opened) {
        await vscode.commands.executeCommand('git.openRepository', p);
      }
    } catch {
      try {
        await vscode.commands.executeCommand('git.openRepository', p);
      } catch {
        // best effort
      }
    }
  }
}
