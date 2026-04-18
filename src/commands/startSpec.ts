import * as vscode from 'vscode';
import { loadSpec, saveSpec } from '../store';
import { setActiveSpecName } from '../state';
import { createWorktree } from '../gitOps';
import { generateWorkspaceFile, addSpecFoldersToWorkspace, applyGitIsolationSettings } from '../workspaceOps';
import { launchAgentTerminal } from '../terminalOps';
import { refreshGitRepositories } from '../gitScm';
import { SpecTreeItem } from '../views/specTreeProvider';

export function registerStartSpecCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.startSpec', async (item?: SpecTreeItem) => {
    let specName: string | undefined;

    if (item instanceof SpecTreeItem) {
      specName = item.spec.name;
    } else {
      specName = await vscode.window.showInputBox({
        prompt: 'Enter spec name to start',
        placeHolder: 'spec-name',
      });
    }

    if (!specName) { return; }

    const spec = loadSpec(specName);
    if (!spec) {
      vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
      return;
    }

    try {
      // Create worktrees if they don't exist
      for (const repo of spec.repos) {
        try {
          createWorktree(repo.originPath, repo.worktreePath, repo.branch);
        } catch {
          // Worktree may already exist, skip
        }
      }

      // Update status
      spec.status = 'active';
      saveSpec(spec);

      // Generate workspace file (for external use / persistence)
      generateWorkspaceFile(spec);

      // Apply git isolation settings BEFORE modifying workspace folders
      await applyGitIsolationSettings();

      // Add spec folders to workspace (no reload!)
      addSpecFoldersToWorkspace(spec);

      // Refresh Git SCM view to show new spec's worktrees
      await refreshGitRepositories(spec.repos.map(r => r.worktreePath));

      // Update active spec state
      await setActiveSpecName(spec.name);

      // Launch agent terminal
      launchAgentTerminal(spec);

      refreshViews();
      vscode.window.showInformationMessage(`Spec "${spec.name}" started.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Failed to start spec: ${msg}`);
    }
  });
}
