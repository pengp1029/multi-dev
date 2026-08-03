import * as vscode from 'vscode';
import { ensureDirs } from './config';
import { initState, getActiveSpecName, setActiveSpecName } from './state';
import { loadSpec } from './store';
import { switchWorkspaceFolders, applyGitIsolationSettings, isInManagedWorkspaceFile } from './workspaceOps';
import { refreshGitRepositories, startRepoGuard } from './gitScm';
import { launchAgentTerminal, registerTerminalCloseHandler } from './terminalOps';
import { CurrentSpecTreeProvider, AllSpecsTreeProvider } from './views/specTreeProvider';
import { registerCreateSpecCommand } from './commands/createSpec';
import { registerStartSpecCommand } from './commands/startSpec';
import { registerSwitchSpecCommand } from './commands/switchSpec';
import { registerAddRepoCommand } from './commands/addRepo';
import { registerCommitSpecCommand } from './commands/commitSpec';
import { registerCleanupSpecCommand } from './commands/cleanupSpec';
import { registerDeleteSpecCommand } from './commands/deleteSpec';
import { DashboardPanel } from './views/dashboardWebview';
import { StateWatcher } from './stateWatcher';
import { shouldNotify, notify } from './notifier';
import { readSpecState } from './specState';

export function activate(context: vscode.ExtensionContext) {
  console.log('[tmux-agent] Extension activating...');
  console.log('[tmux-agent] Extension path:', context.extensionPath);

  // Initialize global state
  initState(context);

  // Ensure storage directories exist
  ensureDirs();
  console.log('[tmux-agent] Directories ensured');

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
  console.log('[tmux-agent] Registering commands...');
  context.subscriptions.push(
    registerCreateSpecCommand(context, refreshViews),
    registerStartSpecCommand(refreshViews),
    registerSwitchSpecCommand(refreshViews),
    registerAddRepoCommand(refreshViews),
    registerCommitSpecCommand(refreshViews),
    registerCleanupSpecCommand(refreshViews),
    registerDeleteSpecCommand(refreshViews),
    vscode.commands.registerCommand('tmuxAgent.refreshSpecs', refreshViews),
    vscode.commands.registerCommand('tmuxAgent.openDashboard', () => {
      DashboardPanel.createOrShow(refreshViews);
    }),
  );
  console.log('[tmux-agent] Commands registered successfully');

  // --- Terminal lifecycle ---
  registerTerminalCloseHandler(context);

  // --- AI status watcher: badge refresh + notifications ---
  const stateWatcher = new StateWatcher();
  context.subscriptions.push(stateWatcher);
  const stateSub = stateWatcher.onDidChangeState(({ specName, prev, next }) => {
    // Refresh sidebar badges and dashboard cards on every change.
    refreshViews();
    DashboardPanel.current?.render();
    // Intrusive notification only for waiting_confirm/done transitions.
    if (shouldNotify(prev, next)) {
      notify(specName, next, readSpecState(specName).message, () => {
        vscode.commands.executeCommand('tmuxAgent.switchSpec', { spec: loadSpec(specName) });
      });
    }
  });
  context.subscriptions.push({ dispose: () => stateSub.dispose() });
  stateWatcher.start();

  // --- Start repo guard: closes any git repo not belonging to active spec ---
  startRepoGuard(context);

  // --- Auto-sync workspace folders and Git SCM for active spec ---
  // Only restore spec state when inside a managed .code-workspace file.
  // If the user opened a different folder/workspace, do NOT override it.
  const activeSpecName = getActiveSpecName();
  if (activeSpecName && isInManagedWorkspaceFile()) {
    const spec = loadSpec(activeSpecName);
    if (spec && spec.status === 'active') {
      // Sync workspace folders in-place for the active spec.
      // Do NOT open workspace files here — only explicit user actions
      // (create/start/switch) should trigger window reloads.
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
        refreshViews();
      }, 2000);
    }
  } else if (activeSpecName && !isInManagedWorkspaceFile()) {
    // User opened a different folder/workspace — clear stale active spec
    // from workspaceState so the repo guard doesn't block repos.
    setActiveSpecName(undefined);
  }
}

export function deactivate() {
  // Cleanup handled by VSCode disposables
}
