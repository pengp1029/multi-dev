import * as vscode from 'vscode';
import { listSpecs, loadSpec } from '../store';
import { getActiveSpecName, setActiveSpecName } from '../state';
import { switchWorkspaceFolders, applyGitIsolationSettings } from '../workspaceOps';
import { launchAgentTerminal } from '../terminalOps';
import { refreshGitRepositories } from '../gitScm';
import { SpecTreeItem } from '../views/specTreeProvider';

export function registerSwitchSpecCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.switchSpec', async (item?: SpecTreeItem) => {
    let specName: string | undefined;

    if (item instanceof SpecTreeItem) {
      specName = item.spec.name;
    } else {
      const currentSpecName = getActiveSpecName();
      const specs = listSpecs();
      const items = specs
        .filter(s => s.name !== currentSpecName && s.status === 'active')
        .map(s => ({
          label: s.name,
          description: `${s.featureBranch} · ${s.repos.length} repos`,
          specName: s.name,
        }));

      if (items.length === 0) {
        vscode.window.showInformationMessage('No other active specs to switch to.');
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a spec to switch to',
      });

      if (!selected) { return; }
      specName = selected.specName;
    }

    const spec = loadSpec(specName);
    if (!spec) {
      vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
      return;
    }

    // Apply git isolation settings BEFORE modifying workspace folders
    await applyGitIsolationSettings();

    // Switch workspace folders in-place (no reload, terminals stay alive!)
    const success = switchWorkspaceFolders(spec);
    if (!success) {
      vscode.window.showErrorMessage('Failed to switch workspace folders.');
      return;
    }

    // Refresh Git SCM view to match new spec's worktrees
    await refreshGitRepositories(spec.repos.map(r => r.worktreePath));

    // Update active spec in state
    await setActiveSpecName(spec.name);

    // Launch agent terminal for the new spec
    launchAgentTerminal(spec);

    refreshViews();
    vscode.window.showInformationMessage(`Switched to spec "${spec.name}".`);
  });
}
