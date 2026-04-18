import * as vscode from 'vscode';
import { ensureDirs } from './config';
import { initState, getActiveSpecName } from './state';
import { loadSpec } from './store';
import { switchWorkspaceFolders, applyGitIsolationSettings } from './workspaceOps';
import { refreshGitRepositories } from './gitScm';
import { launchAgentTerminal, registerTerminalCloseHandler } from './terminalOps';
import { CurrentSpecTreeProvider, AllSpecsTreeProvider } from './views/specTreeProvider';
import { registerCreateSpecCommand } from './commands/createSpec';
import { registerStartSpecCommand } from './commands/startSpec';
import { registerSwitchSpecCommand } from './commands/switchSpec';
import { registerAddRepoCommand } from './commands/addRepo';
import { registerCommitSpecCommand } from './commands/commitSpec';
import { registerCleanupSpecCommand } from './commands/cleanupSpec';
import { registerDeleteSpecCommand } from './commands/deleteSpec';

export function activate(context: vscode.ExtensionContext) {
  // Initialize global state
  initState(context);

  // Ensure storage directories exist
  ensureDirs();

  // --- TreeView Providers ---
  const currentSpecProvider = new CurrentSpecTreeProvider();
  const allSpecsProvider = new AllSpecsTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('tmuxAgentCurrentSpec', currentSpecProvider),
    vscode.window.registerTreeDataProvider('tmuxAgentAllSpecs', allSpecsProvider),
  );

  // Shared refresh function
  const refreshViews = () => {
    currentSpecProvider.refresh();
    allSpecsProvider.refresh();
  };

  // --- Register Commands ---
  context.subscriptions.push(
    registerCreateSpecCommand(context, refreshViews),
    registerStartSpecCommand(refreshViews),
    registerSwitchSpecCommand(refreshViews),
    registerAddRepoCommand(refreshViews),
    registerCommitSpecCommand(refreshViews),
    registerCleanupSpecCommand(refreshViews),
    registerDeleteSpecCommand(refreshViews),
    vscode.commands.registerCommand('tmuxAgent.refreshSpecs', refreshViews),
  );

  // --- Terminal lifecycle ---
  registerTerminalCloseHandler(context);

  // --- Auto-sync workspace folders and Git SCM for active spec ---
  const activeSpecName = getActiveSpecName();
  if (activeSpecName) {
    const spec = loadSpec(activeSpecName);
    if (spec && spec.status === 'active') {
      // Ensure workspace folders match current spec (clean up stale folders from other specs)
      applyGitIsolationSettings().then(() => {
        switchWorkspaceFolders(spec);
      });

      // Sync Git SCM view after Git extension is ready
      setTimeout(async () => {
        await refreshGitRepositories(spec.repos.map(r => r.worktreePath));
        try {
          launchAgentTerminal(spec);
        } catch (e) {
          console.error('[tmux-agent] launchAgentTerminal failed on activation:', e);
        }
      }, 2000);
    }
  }
}

export function deactivate() {
  // Cleanup handled by VSCode disposables
}
