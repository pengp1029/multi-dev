import * as vscode from 'vscode';
import { loadSpec } from '../store';
import { getActiveSpecName } from '../state';
import { getWorktreeStatus, commitWorktree } from '../gitOps';

export function registerCommitSpecCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.commitSpec', async () => {
    const activeSpecName = getActiveSpecName();
    if (!activeSpecName) {
      vscode.window.showErrorMessage('No active spec.');
      return;
    }

    const spec = loadSpec(activeSpecName);
    if (!spec) {
      vscode.window.showErrorMessage(`Spec "${activeSpecName}" not found.`);
      return;
    }

    // Ask for commit message
    const message = await vscode.window.showInputBox({
      prompt: 'Commit message for all repos',
      value: `feat: ${spec.name} - ${spec.description}`,
      placeHolder: 'Enter commit message',
    });

    if (!message) { return; }

    // Ask if should amend existing commits
    const amendChoice = await vscode.window.showQuickPick(
      [
        { label: 'New Commit', description: 'Create a new commit', amend: false },
        { label: 'Amend', description: 'Amend the last commit (squash into existing)', amend: true },
      ],
      { placeHolder: 'Create new commit or amend?' },
    );

    if (!amendChoice) { return; }

    const results: string[] = [];
    for (const repo of spec.repos) {
      const status = getWorktreeStatus(repo.worktreePath);
      if (status.clean && !amendChoice.amend) {
        results.push(`${repo.name}: nothing to commit`);
        continue;
      }
      try {
        const output = commitWorktree(repo.worktreePath, message, amendChoice.amend);
        if (output.includes('nothing to commit')) {
          results.push(`${repo.name}: nothing to commit`);
        } else {
          results.push(`${repo.name}: committed`);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push(`${repo.name}: FAILED - ${msg}`);
      }
    }

    refreshViews();
    vscode.window.showInformationMessage(
      `Commit results:\n${results.join('\n')}`,
      { modal: true },
    );
  });
}
