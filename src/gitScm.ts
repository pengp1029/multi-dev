import * as vscode from 'vscode';
import { getActiveSpecName } from './state';
import { loadSpec } from './store';

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
 * Get the VSCode built-in Git extension API (lazy, cached).
 * If the extension isn't active yet, activate it first.
 */
async function getGitAPI(): Promise<GitAPI | undefined> {
  if (cachedApi) { return cachedApi; }

  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) { return undefined; }

  if (!gitExtension.isActive) {
    await gitExtension.activate();
  }

  cachedApi = gitExtension.exports.getAPI(1);
  return cachedApi;
}

/**
 * Get the set of allowed worktree paths for the current active spec.
 */
function getAllowedPaths(): Set<string> {
  const specName = getActiveSpecName();
  if (!specName) { return new Set(); }
  const spec = loadSpec(specName);
  if (!spec) { return new Set(); }
  return new Set(spec.repos.map(r => r.worktreePath));
}

/**
 * Start a background guard that closes any repository NOT belonging to the
 * current active spec. This replaces `openRepositoryInParentFolders: "never"`
 * which doesn't work with git worktrees (their .git files point to the
 * original repo, causing the Git extension to classify them as parent-folder
 * repos and refusing to open them).
 */
export function startRepoGuard(context: vscode.ExtensionContext): void {
  // Dispose previous guard if any
  repoGuardDisposable?.dispose();

  getGitAPI().then(api => {
    if (!api) { return; }

    repoGuardDisposable = api.onDidOpenRepository(async (repo) => {
      const allowed = getAllowedPaths();
      const repoPath = repo.rootUri.fsPath;

      if (allowed.size > 0 && !allowed.has(repoPath)) {
        console.log('[tmux-agent:gitScm] guard closing unauthorized repo:', repoPath);
        try {
          await vscode.commands.executeCommand('git.close', repo.rootUri);
        } catch {
          // ignore
        }
      }
    });

    context.subscriptions.push({ dispose: () => repoGuardDisposable?.dispose() });
  });
}

/**
 * Refresh SCM repositories to match the given worktree paths.
 * Closes repositories not in newPaths, opens ones that are missing.
 */
export async function refreshGitRepositories(newPaths: string[]): Promise<void> {
  const api = await getGitAPI();
  if (!api) { return; }

  const newPathSet = new Set(newPaths);

  // 1. Close repositories that are no longer in the new spec
  for (const repo of [...api.repositories]) {
    if (!newPathSet.has(repo.rootUri.fsPath)) {
      try {
        await vscode.commands.executeCommand('git.close', repo.rootUri);
      } catch {
        // Silently ignore — the repo may already be gone
      }
    }
  }

  // 2. Wait a tick for VSCode to process closures
  await new Promise(resolve => setTimeout(resolve, 300));

  // 3. Open repositories for the new spec's worktree paths
  const openPaths = new Set(api.repositories.map(r => r.rootUri.fsPath));
  for (const p of newPaths) {
    if (!openPaths.has(p)) {
      try {
        await api.openRepository(vscode.Uri.file(p));
      } catch {
        // Fallback: try the command-based approach
        try {
          await vscode.commands.executeCommand('git.openRepository', p);
        } catch {
          // Silently ignore
        }
      }
    }
  }
}
