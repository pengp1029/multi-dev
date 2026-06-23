import * as vscode from 'vscode';
import { loadSpec, saveSpec, deleteSpec } from '../store';
import { getActiveSpecName, setActiveSpecName } from '../state';
import { removeWorktree } from '../gitOps';
import { removeFoldersFromCurrentWorkspace, deleteWorkspaceFile } from '../workspaceOps';
import { killAgentTerminal } from '../terminalOps';
import { SpecTreeItem } from '../views/specTreeProvider';

export function registerCleanupSpecCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.cleanupSpec', async (item?: SpecTreeItem) => {
    let specName: string | undefined;

    if (item instanceof SpecTreeItem) {
      specName = item.spec.name;
    } else {
      specName = getActiveSpecName();
    }

    if (!specName) {
      vscode.window.showErrorMessage('No spec to cleanup.');
      return;
    }

    const spec = loadSpec(specName);
    if (!spec) {
      vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
      return;
    }

    // Confirm cleanup
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to cleanup spec "${spec.name}"?\nThis will remove all worktrees and close the agent terminal.`,
      { modal: true },
      'Cleanup',
      'Cancel',
    );

    if (confirm !== 'Cleanup') { return; }

    const keepSpec = await vscode.window.showQuickPick(
      [
        { label: 'Mark as completed', description: 'Keep the spec config, mark it as completed', keep: true },
        { label: 'Delete entirely', description: 'Remove spec config and workspace file', keep: false },
      ],
      { placeHolder: 'What to do with the spec config?' },
    );

    if (!keepSpec) { return; }

    try {
      // Remove folders from current workspace if active
      const activeSpecName = getActiveSpecName();
      if (activeSpecName === spec.name) {
        removeFoldersFromCurrentWorkspace(spec);
        await setActiveSpecName(undefined);
      }

      // Kill agent terminal
      killAgentTerminal(spec.name);

      // Remove worktrees
      for (const repo of spec.repos) {
        try {
          removeWorktree(repo.originPath, repo.worktreePath);
        } catch {
          // Best effort, continue
        }
      }

      if (keepSpec.keep) {
        spec.status = 'completed';
        saveSpec(spec);
      } else {
        deleteSpec(spec.name);
        deleteWorkspaceFile(spec.name);
      }

      refreshViews();
      vscode.window.showInformationMessage(`Spec "${spec.name}" cleaned up.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Cleanup failed: ${msg}`);
    }
  });
}
