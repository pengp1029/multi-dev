import * as vscode from 'vscode';

let _context: vscode.ExtensionContext | undefined;

export function initState(context: vscode.ExtensionContext): void {
  _context = context;
}

export function getActiveSpecName(): string | undefined {
  return _context?.workspaceState.get<string>('tmuxAgent.activeSpec');
}

export async function setActiveSpecName(name: string | undefined): Promise<void> {
  await _context?.workspaceState.update('tmuxAgent.activeSpec', name);
}
