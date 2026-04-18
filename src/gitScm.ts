import * as vscode from 'vscode';

/**
 * VSCode Git extension API types (subset we need).
 * See https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
interface GitExtension {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
  openRepository(path: vscode.Uri): Promise<Repository | null>;
}

interface Repository {
  rootUri: vscode.Uri;
}

let cachedApi: GitAPI | undefined;

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
        // git.close accepts a Uri to identify the repository to close
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
