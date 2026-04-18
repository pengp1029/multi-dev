import * as vscode from 'vscode';
import { listSpecs, loadSpec } from '../store';
import { getActiveSpecName, setActiveSpecName } from '../state';
import { switchWorkspaceFolders, applyGitIsolationSettings, generateWorkspaceFile, openWorkspaceFile, isInManagedWorkspaceFile, updateCurrentWorkspaceFileActiveSpec } from '../workspaceOps';
import { launchAgentTerminal } from '../terminalOps';
import { refreshGitRepositories } from '../gitScm';
import { SpecTreeItem } from '../views/specTreeProvider';

export function registerSwitchSpecCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.switchSpec', async (item?: SpecTreeItem) => {
    console.log('[tmux-agent:switchSpec] command triggered, item:', item instanceof SpecTreeItem ? item.spec.name : typeof item);
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

    console.log(`[tmux-agent:switchSpec] specName="${specName}"`);
    const spec = loadSpec(specName);
    if (!spec) {
      vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
      return;
    }

    // Persist active spec FIRST — if the extension host restarts after
    // workspace folder changes, the activation code must see the new spec.
    await setActiveSpecName(spec.name);
    console.log('[tmux-agent:switchSpec] active spec set');

    // Apply git isolation settings BEFORE modifying workspace folders
    await applyGitIsolationSettings();
    console.log('[tmux-agent:switchSpec] git isolation applied');

    if (isInManagedWorkspaceFile()) {
      // Already in a tmux-agent managed workspace file — update folders in-place (no reload).
      // Update the .code-workspace file's activeSpec setting for persistence
      updateCurrentWorkspaceFileActiveSpec(spec.name);

      // Do NOT call generateWorkspaceFile here — writing to the active
      // .code-workspace triggers a VSCode reload.
      // Refresh views BEFORE switchWorkspaceFolders — the API call triggers an
      // async workspace-change event that may cause VS Code to re-render the
      // sidebar, and subsequent code may not execute if the extension host
      // restarts.  Refreshing first ensures the tree providers re-query
      // getActiveSpecName() which was already persisted above.
      refreshViews();

      const success = switchWorkspaceFolders(spec);
      console.log(`[tmux-agent:switchSpec] switchWorkspaceFolders=${success}`);
      if (!success) {
        vscode.window.showErrorMessage('Failed to switch workspace folders.');
        return;
      }

      // Refresh Git SCM view to match new spec's worktrees
      await refreshGitRepositories(spec.repos.map(r => r.worktreePath));
      console.log('[tmux-agent:switchSpec] git repos refreshed');

      // Launch agent terminal for the new spec
      try {
        launchAgentTerminal(spec);
      } catch (e) {
        console.error('[tmux-agent] launchAgentTerminal failed in switchSpec:', e);
      }

      // Refresh again after all operations complete
      refreshViews();
      vscode.window.showInformationMessage(`Switched to spec "${spec.name}".`);
      console.log('[tmux-agent:switchSpec] done');
    } else {
      // Not in a .code-workspace file (or in a different spec's workspace) —
      // generate the target workspace file and open it. This reloads the
      // window; terminal, Git SCM, and views will be restored by activation.
      generateWorkspaceFile(spec);
      console.log('[tmux-agent:switchSpec] opening workspace file (will reload)');
      await openWorkspaceFile(spec.name);
    }
  });
}
