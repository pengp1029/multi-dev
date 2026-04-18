import * as vscode from 'vscode';
import { Spec } from './types';
import { getSpecWorktreeRoot } from './workspaceOps';

// Track terminals by spec name
const agentTerminals = new Map<string, vscode.Terminal>();

/**
 * Launch an agent terminal for the spec.
 * CWD is set to the spec's worktree root (e.g. ~/.tmux-agent/worktrees/user-auth/)
 * so the agent sees all repos under that feature directory.
 */
export function launchAgentTerminal(spec: Spec): vscode.Terminal {
  // Kill existing terminal for this spec if any
  killAgentTerminal(spec.name);

  // Use the spec-level worktree root as cwd, not a specific repo
  const cwd = getSpecWorktreeRoot(spec.name);

  const terminal = vscode.window.createTerminal({
    name: `Agent: ${spec.name}`,
    cwd,
  });
  terminal.show();
  terminal.sendText(`${spec.agentCommand}`);

  agentTerminals.set(spec.name, terminal);

  return terminal;
}

export function killAgentTerminal(specName: string): void {
  const terminal = agentTerminals.get(specName);
  if (terminal) {
    terminal.dispose();
    agentTerminals.delete(specName);
  }
}

export function hasAgentTerminal(specName: string): boolean {
  return agentTerminals.has(specName);
}

// Clean up tracking when terminals are closed externally
export function registerTerminalCloseHandler(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(closed => {
      for (const [name, terminal] of agentTerminals) {
        if (terminal === closed) {
          agentTerminals.delete(name);
          break;
        }
      }
    })
  );
}
