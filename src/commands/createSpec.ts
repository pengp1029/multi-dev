import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Spec, RepoEntry } from '../types';
import { WORKTREES_DIR } from '../config';
import { saveSpec } from '../store';
import { setActiveSpecName } from '../state';
import { isGitRepo, getRepoRoot, hasCommits, createWorktree } from '../gitOps';
import { generateWorkspaceFile, openWorkspaceFile, getSpecWorktreeRoot } from '../workspaceOps';
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
    if (!hasCommits(root)) {
      throw new Error(
        `"${repo.name}" (${root}) has no commits yet. ` +
        `Please make at least one initial commit before adding to a spec.`
      );
    }
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

  // Create worktrees
  for (const repo of repos) {
    createWorktree(repo.originPath, repo.worktreePath, repo.branch);
  }

  // Ensure worktree root directory exists (even for specs with no repos)
  const worktreeRoot = getSpecWorktreeRoot(data.name);
  if (!fs.existsSync(worktreeRoot)) {
    fs.mkdirSync(worktreeRoot, { recursive: true });
  }

  // Save spec YAML
  saveSpec(spec);

  // Generate .code-workspace file (for persistence)
  generateWorkspaceFile(spec);

  // Set as active spec BEFORE opening workspace (window will reload)
  await setActiveSpecName(spec.name);

  // Open the .code-workspace file — gives a named workspace instead of
  // "Untitled (Workspace)". This reloads the window; terminal and views
  // will be restored by the activation path in extension.ts.
  await openWorkspaceFile(spec.name);
}
