import * as vscode from 'vscode';
import * as path from 'path';
import { Spec, RepoEntry } from '../types';
import { WORKTREES_DIR } from '../config';
import { saveSpec } from '../store';
import { setActiveSpecName } from '../state';
import { isGitRepo, getRepoRoot, hasCommits, createWorktree } from '../gitOps';
import { generateWorkspaceFile, addSpecFoldersToWorkspace, applyGitIsolationSettings } from '../workspaceOps';
import { launchAgentTerminal } from '../terminalOps';
import { SpecWebviewProvider, CreateSpecData } from '../views/specWebview';

export function registerCreateSpecCommand(
  context: vscode.ExtensionContext,
  refreshViews: () => void,
): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.createSpec', () => {
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

  // Save spec YAML
  saveSpec(spec);

  // Generate .code-workspace file (for persistence)
  generateWorkspaceFile(spec);

  // Apply git isolation settings BEFORE modifying workspace folders
  // (updateWorkspaceFolders marks the config file dirty, blocking subsequent writes)
  await applyGitIsolationSettings();

  // Add spec folders to workspace (no VSCode reload!)
  addSpecFoldersToWorkspace(spec);

  // Set as active spec
  await setActiveSpecName(spec.name);

  // Launch agent terminal
  launchAgentTerminal(spec);

  refreshViews();
}
