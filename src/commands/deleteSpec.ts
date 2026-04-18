import * as vscode from 'vscode';
import * as fs from 'fs';
import { loadSpec, deleteSpec as deleteSpecYaml, listSpecs } from '../store';
import { getActiveSpecName, setActiveSpecName } from '../state';
import { removeWorktree } from '../gitOps';
import { removeFoldersFromCurrentWorkspace, deleteWorkspaceFile, getSpecWorktreeRoot } from '../workspaceOps';
import { killAgentTerminal } from '../terminalOps';
import { SpecTreeItem } from '../views/specTreeProvider';

export function registerDeleteSpecCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.deleteSpec', async (item?: SpecTreeItem) => {
    let specName: string | undefined;

    if (item instanceof SpecTreeItem) {
      specName = item.spec.name;
    } else {
      const specs = listSpecs();
      if (specs.length === 0) {
        vscode.window.showInformationMessage('No specs to delete.');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        specs.map(s => ({
          label: s.name,
          description: `${s.featureBranch} · ${s.repos.length} repos · ${s.status}`,
          specName: s.name,
        })),
        { placeHolder: 'Select a spec to delete' },
      );
      if (!selected) { return; }
      specName = selected.specName;
    }

    const spec = loadSpec(specName);
    if (!spec) {
      vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
      return;
    }

    // Confirm deletion
    const confirm = await vscode.window.showWarningMessage(
      `Delete spec "${spec.name}"?\n\nThis will remove all worktrees, workspace file, and spec config.`,
      { modal: true },
      'Delete',
    );

    if (confirm !== 'Delete') { return; }

    try {
      // Remove folders from current workspace if this is the active spec
      const activeSpecName = getActiveSpecName();
      if (activeSpecName === spec.name) {
        removeFoldersFromCurrentWorkspace(spec.repos);
        await setActiveSpecName(undefined);
      }

      // Kill agent terminal
      killAgentTerminal(spec.name);

      // Remove worktrees
      for (const repo of spec.repos) {
        try {
          removeWorktree(repo.originPath, repo.worktreePath);
        } catch {
          // Best effort
        }
      }

      // Remove spec worktree root directory
      const specRoot = getSpecWorktreeRoot(spec.name);
      try {
        if (fs.existsSync(specRoot)) {
          fs.rmSync(specRoot, { recursive: true, force: true });
        }
      } catch {
        // Best effort
      }

      // Delete workspace file and spec YAML
      deleteWorkspaceFile(spec.name);
      deleteSpecYaml(spec.name);

      refreshViews();
      vscode.window.showInformationMessage(`Spec "${spec.name}" deleted.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Failed to delete spec: ${msg}`);
    }
  });
}
