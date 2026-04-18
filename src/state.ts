import * as vscode from 'vscode';

let _context: vscode.ExtensionContext | undefined;

export function initState(context: vscode.ExtensionContext): void {
  _context = context;
}

export function getActiveSpecName(): string | undefined {
  // Try workspaceState first (set during this session)
  const fromState = _context?.workspaceState.get<string>('tmuxAgent.activeSpec');
  if (fromState) { return fromState; }
  // Fall back to workspace settings (written into .code-workspace file by generateWorkspaceFile)
  return vscode.workspace.getConfiguration().get<string>('tmuxAgent.activeSpec');
}

export async function setActiveSpecName(name: string | undefined): Promise<void> {
  await _context?.workspaceState.update('tmuxAgent.activeSpec', name);
}
