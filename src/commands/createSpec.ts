import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Spec, RepoEntry } from '../types';
import { WORKTREES_DIR } from '../config';
import { saveSpec, deleteSpec } from '../store';
import { isGitRepo, getRepoRoot, createWorktree, removeWorktree } from '../gitOps';
import { generateWorkspaceFile, getSpecWorktreeRoot, deleteWorkspaceFile } from '../workspaceOps';
import { SpecWebviewProvider, CreateSpecData } from '../views/specWebview';

export function registerCreateSpecCommand(
  context: vscode.ExtensionContext,
  refreshViews: () => void,
): vscode.Disposable {
  console.log('[tmux-agent] Registering command: tmuxAgent.createSpec');
  const disposable = vscode.commands.registerCommand('tmuxAgent.createSpec', () => {
    console.log('[tmux-agent] Command tmuxAgent.createSpec executed');
    const webview = new SpecWebviewProvider(
      context.extensionUri,
      async (data: CreateSpecData) => {
        try {
          await createSpecFromData(data, refreshViews);
          vscode.window.showInformationMessage(`Spec "${data.name}" created successfully!`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Failed to create spec: ${msg}`);
        }
      },
    );
    webview.showCreateSpecForm();
  });
  return disposable;
}

async function createSpecFromData(data: CreateSpecData, refreshViews: () => void): Promise<void> {
  // Validate and resolve repos
  const resolvedRepos: Array<{ path: string; name: string; root: string }> = [];
  for (const repo of data.repos) {
    if (!isGitRepo(repo.path)) {
      throw new Error(`"${repo.path}" is not a git repository`);
    }
    const root = getRepoRoot(repo.path);
    resolvedRepos.push({ path: repo.path, name: repo.name, root });
  }

  // Build spec object
  const repos: RepoEntry[] = resolvedRepos.map(r => ({
    name: r.name,
    originPath: r.root,
    worktreePath: path.join(WORKTREES_DIR, data.name, r.name),
    branch: data.featureBranch,
  }));

  const spec: Spec = {
    name: data.name,
    description: data.description,
    featureBranch: data.featureBranch,
    status: 'active',
    agentCommand: data.agentCommand,
    repos,
    createdAt: new Date().toISOString(),
  };

  // Ensure worktree root directory exists (even for specs with no repos)
  const worktreeRoot = getSpecWorktreeRoot(data.name);
  if (!fs.existsSync(worktreeRoot)) {
    fs.mkdirSync(worktreeRoot, { recursive: true });
  }

  // Persist the spec and refresh the sidebar BEFORE creating worktrees.
  // Worktree checkout can take minutes for large repos; if it froze/crashed
  // the extension host, the old ordering (save+refresh AFTER the loop) left
  // the spec invisible in the sidebar even though directories were created.
  // Save-first guarantees the spec shows up immediately and survives a
  // mid-checkout crash (user can retry checkout via Start).
  saveSpec(spec);
  generateWorkspaceFile(spec);
  refreshViews();

  // Create worktrees with a progress notification (async — does NOT block the
  // extension host event loop). If any worktree fails, roll back the spec we
  // just persisted so we don't leave a half-created spec whose folders/terminal
  // point at nonexistent directories.
  if (repos.length > 0) {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating worktrees for spec "${data.name}"`,
          cancellable: false,
        },
        async progress => {
          for (const repo of repos) {
            progress.report({ message: `${repo.name} (${repo.branch})` });
            await createWorktree(repo.originPath, repo.worktreePath, repo.branch);
          }
        },
      );
    } catch (e) {
      // Roll back everything we created before rethrowing so the caller's
      // catch surfaces the error WITHOUT a lingering broken spec.
      for (const repo of repos) {
        try { removeWorktree(repo.originPath, repo.worktreePath); } catch { /* best effort */ }
      }
      try {
        const root = getSpecWorktreeRoot(data.name);
        if (fs.existsSync(root)) { fs.rmSync(root, { recursive: true, force: true }); }
      } catch { /* best effort */ }
      deleteWorkspaceFile(data.name);
      deleteSpec(data.name);
      refreshViews();
      throw e;
    }
  }

  refreshViews();
}
