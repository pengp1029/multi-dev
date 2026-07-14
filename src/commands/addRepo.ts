import * as vscode from 'vscode';
import * as path from 'path';
import { loadSpec, saveSpec } from '../store';
import { getActiveSpecName } from '../state';
import { isGitRepo, getRepoRoot, createWorktree } from '../gitOps';
import { WORKTREES_DIR } from '../config';
import { updateWorkspaceFile, addFolderToCurrentWorkspace } from '../workspaceOps';
import { RepoEntry } from '../types';

export function registerAddRepoCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.addRepo', async () => {
    const activeSpecName = getActiveSpecName();
    if (!activeSpecName) {
      vscode.window.showErrorMessage('No active spec. Please start or switch to a spec first.');
      return;
    }

    const spec = loadSpec(activeSpecName);
    if (!spec) {
      vscode.window.showErrorMessage(`Spec "${activeSpecName}" not found.`);
      return;
    }

    // Select repo folder
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Git Repository',
    });

    if (!uris || uris.length === 0) { return; }

    const repoPath = uris[0].fsPath;

    // Validate it's a git repo
    if (!isGitRepo(repoPath)) {
      vscode.window.showErrorMessage(`"${repoPath}" is not a git repository.`);
      return;
    }

    // Resolve to repo root
    const repoRoot = getRepoRoot(repoPath);

    const repoName = path.basename(repoRoot);

    // Check if already added
    if (spec.repos.some(r => r.originPath === repoRoot)) {
      vscode.window.showWarningMessage(`"${repoName}" is already in this spec.`);
      return;
    }

    // Ask for branch name
    const branch = await vscode.window.showInputBox({
      prompt: 'Branch name for this repo',
      value: spec.featureBranch,
      placeHolder: spec.featureBranch,
    });

    if (!branch) { return; }

    try {
      const worktreePath = path.join(WORKTREES_DIR, spec.name, repoName);

      // Create worktree
      await createWorktree(repoRoot, worktreePath, branch);

      // Update spec
      const newRepo: RepoEntry = {
        name: repoName,
        originPath: repoRoot,
        worktreePath,
        branch,
      };
      spec.repos.push(newRepo);
      saveSpec(spec);

      // Update .code-workspace file
      updateWorkspaceFile(spec);

      // Dynamically add to current VSCode workspace (no restart needed!)
      addFolderToCurrentWorkspace(newRepo);

      refreshViews();
      vscode.window.showInformationMessage(`Added "${repoName}" to spec "${spec.name}".`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Failed to add repo: ${msg}`);
    }
  });
}
