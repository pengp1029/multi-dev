import * as vscode from 'vscode';
import { ensureDirs } from './config';
import { initState, getActiveSpecName } from './state';
import { loadSpec } from './store';
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

  // --- Auto-launch agent terminal if active spec exists ---
  const activeSpecName = getActiveSpecName();
  if (activeSpecName) {
    const spec = loadSpec(activeSpecName);
    if (spec && spec.status === 'active') {
      setTimeout(() => {
        launchAgentTerminal(spec);
      }, 2000);
    }
  }
}

export function deactivate() {
  // Cleanup handled by VSCode disposables
}
