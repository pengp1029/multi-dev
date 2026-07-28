import * as vscode from 'vscode';
import { loadSpec, saveSpec } from '../store';
import { setActiveSpecName } from '../state';
import { ensureSpecWorktrees } from '../gitOps';
import { generateWorkspaceFile, openWorkspaceFile } from '../workspaceOps';
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
      // Create worktrees if they don't exist (self-healing: re-checkout any
      // missing worktree dir). Surface failures instead of swallowing them —
      // a silent failure here left the spec pointing at a nonexistent cwd.
      await ensureSpecWorktrees(spec);

      // Update status
      spec.status = 'active';
      saveSpec(spec);

      // Generate workspace file
      generateWorkspaceFile(spec);

      // Set as active spec BEFORE opening workspace (window will reload)
      await setActiveSpecName(spec.name);

      // Open the .code-workspace file — gives a named workspace instead of
      // "Untitled (Workspace)". This reloads the window; terminal, Git SCM,
      // and views will be restored by the activation path in extension.ts.
      await openWorkspaceFile(spec.name);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Failed to start spec: ${msg}`);
    }
  });
}
