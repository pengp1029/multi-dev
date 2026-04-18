import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Spec, RepoEntry } from './types';
import { WORKSPACES_DIR, WORKTREES_DIR, ensureDirs } from './config';

function getWorkspacePath(specName: string): string {
  return path.join(WORKSPACES_DIR, `${specName}.code-workspace`);
}

export function getSpecWorktreeRoot(specName: string): string {
  return path.join(WORKTREES_DIR, specName);
}

/**
 * Check if a workspace folder is managed by tmux-agent (i.e. lives under WORKTREES_DIR).
 */
function isManagedFolder(folder: vscode.WorkspaceFolder): boolean {
  return folder.uri.fsPath.startsWith(WORKTREES_DIR);
}

export function generateWorkspaceFile(spec: Spec): string {
  ensureDirs();
  const wsPath = getWorkspacePath(spec.name);
  const content = {
    folders: spec.repos.map(r => ({
      name: `${r.name} (${r.branch})`,
      path: r.worktreePath,
    })),
    settings: {
      'tmuxAgent.activeSpec': spec.name,
    },
  };
  fs.writeFileSync(wsPath, JSON.stringify(content, null, 2), 'utf-8');
  return wsPath;
}

export function updateWorkspaceFile(spec: Spec): string {
  return generateWorkspaceFile(spec);
}

/**
 * Switch to a different spec's workspace folders WITHOUT reloading VSCode.
 *
 * Strategy: only touch folders that live under ~/.tmux-agent/worktrees/.
 * 1. Remove all managed (old spec's) folders
 * 2. Add new spec's folders
 * User's own folders (e.g. the extension dev folder) are left untouched.
 */
export function switchWorkspaceFolders(spec: Spec): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];

  // Find indices of managed folders
  const managedIndices: number[] = [];
  for (let i = 0; i < folders.length; i++) {
    if (isManagedFolder(folders[i])) {
      managedIndices.push(i);
    }
  }

  // New folders to add
  const newFolders = spec.repos.map(r => ({
    uri: vscode.Uri.file(r.worktreePath),
    name: `${r.name} (${r.branch})`,
  }));

  if (managedIndices.length > 0) {
    // Managed folders are contiguous (always appended together at end).
    // Use a SINGLE atomic updateWorkspaceFolders call — the API does not
    // allow multiple successive calls without waiting for the event.
    const start = managedIndices[0];
    const deleteCount = managedIndices.length;
    return vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...newFolders);
  }

  // No managed folders to remove, just add new ones at end
  const currentCount = vscode.workspace.workspaceFolders?.length ?? 0;
  if (newFolders.length > 0) {
    return vscode.workspace.updateWorkspaceFolders(currentCount, null, ...newFolders);
  }

  return true;
}

/**
 * Add a single spec's worktree folders to workspace (for first-time start/create).
 */
export function addSpecFoldersToWorkspace(spec: Spec): boolean {
  const currentCount = vscode.workspace.workspaceFolders?.length ?? 0;
  const newFolders = spec.repos.map(r => ({
    uri: vscode.Uri.file(r.worktreePath),
    name: `${r.name} (${r.branch})`,
  }));

  if (newFolders.length === 0) { return true; }

  return vscode.workspace.updateWorkspaceFolders(currentCount, null, ...newFolders);
}

export async function applyGitIsolationSettings(): Promise<void> {
  // No workspace open → nothing to configure (avoids "no workspace" error on first spec creation)
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return;
  }
  // Remove the "never" setting — it blocks git worktree repos from being
  // opened because their .git files point to parent repos.
  // Instead, isolation is handled by the repo guard in gitScm.ts which
  // closes any repo not belonging to the current spec via onDidOpenRepository.
  const gitConfig = vscode.workspace.getConfiguration('git');
  await gitConfig.update('openRepositoryInParentFolders', undefined, vscode.ConfigurationTarget.Workspace);
  await gitConfig.update('repositoryScanMaxDepth', undefined, vscode.ConfigurationTarget.Workspace);
}

export function addFolderToCurrentWorkspace(repo: RepoEntry): boolean {
  const currentCount = vscode.workspace.workspaceFolders?.length ?? 0;
  return vscode.workspace.updateWorkspaceFolders(currentCount, null, {
    uri: vscode.Uri.file(repo.worktreePath),
    name: `${repo.name} (${repo.branch})`,
  });
}

export function removeFoldersFromCurrentWorkspace(repos: RepoEntry[]): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) { return; }

  const indicesToRemove: number[] = [];
  for (const repo of repos) {
    const idx = folders.findIndex(f => f.uri.fsPath === repo.worktreePath);
    if (idx >= 0) {
      indicesToRemove.push(idx);
    }
  }

  if (indicesToRemove.length === 0) { return; }

  // Sort ascending to find contiguous range; use single atomic call
  indicesToRemove.sort((a, b) => a - b);
  const start = indicesToRemove[0];
  const deleteCount = indicesToRemove.length;
  vscode.workspace.updateWorkspaceFolders(start, deleteCount);
}

export function workspaceFileExists(specName: string): boolean {
  return fs.existsSync(getWorkspacePath(specName));
}

export function deleteWorkspaceFile(specName: string): void {
  const wsPath = getWorkspacePath(specName);
  if (fs.existsSync(wsPath)) {
    fs.unlinkSync(wsPath);
  }
}
