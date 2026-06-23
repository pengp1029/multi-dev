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

/**
 * Build the ordered list of workspace folders for a spec:
 *   [<spec worktree root>, <repo1>, <repo2>, ...]
 *
 * The spec root folder exposes any non-repo files the user drops under
 * `~/.tmux-agent/worktrees/<spec>/` (specs, design docs, scratch files)
 * directly in the VSCode explorer, while each repo retains its branch-tagged
 * top-level folder for SCM scoping.
 *
 * The root directory is created on disk if missing, so `vscode.openFolder`
 * never fails on a freshly-started spec that has no repos yet.
 */
function buildSpecWorkspaceFolders(
  spec: Spec,
): { name: string; uri: vscode.Uri; path: string }[] {
  const root = getSpecWorktreeRoot(spec.name);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  const folders: { name: string; uri: vscode.Uri; path: string }[] = [
    { name: spec.name, uri: vscode.Uri.file(root), path: root },
  ];
  for (const r of spec.repos) {
    folders.push({
      name: `${r.name} (${r.branch})`,
      uri: vscode.Uri.file(r.worktreePath),
      path: r.worktreePath,
    });
  }
  return folders;
}

export function generateWorkspaceFile(spec: Spec): string {
  ensureDirs();
  const wsPath = getWorkspacePath(spec.name);
  const content = {
    folders: buildSpecWorkspaceFolders(spec).map(f => ({
      name: f.name,
      path: f.path,
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
 * Update only the activeSpec setting in the current workspace file, without
 * triggering a VSCode reload (because we're not modifying the folders).
 * Call this when switching specs within a managed workspace file.
 */
export function updateCurrentWorkspaceFileActiveSpec(specName: string): void {
  const wsFile = vscode.workspace.workspaceFile;
  if (!wsFile) { return; }
  const content = JSON.parse(fs.readFileSync(wsFile.fsPath, 'utf-8'));
  content.settings = content.settings || {};
  content.settings['tmuxAgent.activeSpec'] = specName;
  fs.writeFileSync(wsFile.fsPath, JSON.stringify(content, null, 2), 'utf-8');
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

  // New folders to add — spec root first, then each repo worktree.
  const newFolders = buildSpecWorkspaceFolders(spec).map(f => ({
    uri: f.uri,
    name: f.name,
  }));

  if (managedIndices.length > 0) {
    // Managed folders are contiguous (always appended together at end).
    // Use a SINGLE atomic updateWorkspaceFolders call — the API does not
    // allow multiple successive calls without waiting for the event.
    const start = managedIndices[0];
    const deleteCount = managedIndices.length;

    // If the managed folders already match the target, skip the no-op call —
    // updateWorkspaceFolders returns false when nothing changes.
    if (deleteCount === newFolders.length) {
      const managedFolders = managedIndices.map(i => folders[i]);
      const alreadyMatch = newFolders.every((nf, idx) =>
        managedFolders[idx].uri.fsPath === nf.uri.fsPath,
      );
      if (alreadyMatch) { return true; }
    }

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
  const newFolders = buildSpecWorkspaceFolders(spec).map(f => ({
    uri: f.uri,
    name: f.name,
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

export function removeFoldersFromCurrentWorkspace(spec: Spec): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) { return; }

  // Remove both the spec root folder and each repo worktree folder.
  const targets = new Set<string>([
    getSpecWorktreeRoot(spec.name),
    ...spec.repos.map(r => r.worktreePath),
  ]);

  const indicesToRemove: number[] = [];
  for (let i = 0; i < folders.length; i++) {
    if (targets.has(folders[i].uri.fsPath)) {
      indicesToRemove.push(i);
    }
  }

  if (indicesToRemove.length === 0) { return; }

  // Sort ascending to find contiguous range; use single atomic call
  indicesToRemove.sort((a, b) => a - b);
  const start = indicesToRemove[0];
  const deleteCount = indicesToRemove.length;
  vscode.workspace.updateWorkspaceFolders(start, deleteCount);
}

/**
 * Open the .code-workspace file for a spec, giving VSCode a named workspace
 * instead of an "Untitled (Workspace)".
 *
 * This triggers a window reload. Pass `forceNewWindow: true` to open in a
 * separate window instead.
 */
export async function openWorkspaceFile(specName: string, forceNewWindow = false): Promise<void> {
  const wsPath = getWorkspacePath(specName);
  if (!fs.existsSync(wsPath)) {
    throw new Error(`Workspace file not found: ${wsPath}`);
  }
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(wsPath),
    { forceNewWindow },
  );
}

/**
 * Check if the current VSCode window is already using a specific spec's
 * .code-workspace file.
 */
export function isInWorkspaceFile(specName: string): boolean {
  const wsFile = vscode.workspace.workspaceFile;
  if (!wsFile) { return false; }
  return wsFile.fsPath === getWorkspacePath(specName);
}

/**
 * Check if the current VSCode window is using any tmux-agent managed
 * .code-workspace file.
 */
export function isInManagedWorkspaceFile(): boolean {
  const wsFile = vscode.workspace.workspaceFile;
  if (!wsFile) { return false; }
  return wsFile.fsPath.startsWith(WORKSPACES_DIR) && wsFile.fsPath.endsWith('.code-workspace');
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
