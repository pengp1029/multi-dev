import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { Spec } from './types';
import { getSpecWorktreeRoot } from './workspaceOps';

/**
 * Build the system prompt that describes the workspace to the agent.
 */
function buildSystemPrompt(spec: Spec, cwd: string): string {
  const lines: string[] = [
    'You are working in a tmux-agent managed workspace.',
    '',
    `Spec: ${spec.name}`,
    `Description: ${spec.description}`,
    `Feature Branch: ${spec.featureBranch}`,
    `Working Directory: ${cwd}`,
  ];

  if (spec.repos.length > 0) {
    lines.push('', 'Repositories in this workspace:');
    for (const repo of spec.repos) {
      lines.push(`- ${repo.name}: ${repo.worktreePath}`);
      lines.push(`  (origin: ${repo.originPath}, branch: ${repo.branch})`);
    }
    lines.push('', 'Please search for code within this worktree folder. Do NOT look outside of these paths.');
  } else {
    lines.push(
      '',
      'No code repositories are configured in this workspace. If you need to work with code, remind the user to add repositories to this spec.',
    );
  }

  return lines.join('\n');
}

/**
 * Build the full agent command with --system-prompt appended.
 */
function buildAgentCommandWithPrompt(spec: Spec, cwd: string): string {
  const prompt = buildSystemPrompt(spec, cwd);
  // Escape single quotes for shell: replace ' with '\''
  const escaped = prompt.replace(/'/g, "'\\''");
  return `${spec.agentCommand} --system-prompt $'${escaped.replace(/\n/g, '\\n')}'`;
}

// Cache tmux availability check
let _tmuxAvailable: boolean | null = null;

// Single agent terminal — reused across spec switches via tmux switch-client
let agentTerminal: vscode.Terminal | undefined;
let currentTmuxSession: string | undefined;

const LOG_PREFIX = '[tmux-agent:terminal]';
const outputChannel = vscode.window.createOutputChannel('tmux-agent');

function log(msg: string): void {
  const line = `${LOG_PREFIX} ${msg}`;
  outputChannel.appendLine(line);
  console.log(line);
}

function isTmuxAvailable(): boolean {
  if (_tmuxAvailable === null) {
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
      _tmuxAvailable = true;
    } catch {
      _tmuxAvailable = false;
    }
  }
  return _tmuxAvailable;
}

/**
 * Sanitized tmux session name for a spec.
 * Prefix "ta-" (tmux-agent) to avoid conflicts with user sessions.
 */
export function getTmuxSessionName(specName: string): string {
  return `ta-${specName.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function tmuxSessionExists(sessionName: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createTmuxSession(sessionName: string, cwd: string, spec: Spec): void {
  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd]);
  const fullCommand = buildAgentCommandWithPrompt(spec, cwd);
  execFileSync('tmux', ['send-keys', '-t', sessionName, fullCommand, 'Enter']);
}

function killTmuxSession(sessionName: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  } catch {
    // Session might not exist, ignore
  }
}

function isTerminalAlive(terminal: vscode.Terminal): boolean {
  return vscode.window.terminals.includes(terminal);
}

/** Check if a terminal name belongs to an agent terminal we manage. */
function isAgentTerminalName(name: string): boolean {
  return name === 'Agent' || name.startsWith('Agent: ');
}

/**
 * Try to recover the agent terminal reference from vscode.window.terminals.
 * Handles the case where the extension was reloaded but the terminal survived.
 */
function recoverAgentTerminal(): void {
  if (agentTerminal && isTerminalAlive(agentTerminal)) { return; }
  agentTerminal = undefined;
  currentTmuxSession = undefined;

  const found = vscode.window.terminals.find(t => isAgentTerminalName(t.name));
  if (found) {
    agentTerminal = found;
    log(`recovered existing terminal: "${found.name}"`);
  }
}

/**
 * Dispose all stale Agent terminals (from previous extension loads).
 * Keeps only the one we're about to create.
 */
function disposeStaleAgentTerminals(): void {
  for (const t of vscode.window.terminals) {
    if (isAgentTerminalName(t.name) && t !== agentTerminal) {
      t.dispose();
      log(`disposed stale terminal: "${t.name}"`);
    }
  }
}

/**
 * Launch or reuse the agent terminal for the spec.
 *
 * With tmux — single terminal, switch via tmux switch-client:
 * 1. Already showing this spec's session → just show()
 * 2. Terminal alive + different session → switch-client (no new terminal!)
 * 3. No live terminal → create one and attach to the tmux session
 *
 * Without tmux (fallback):
 * - Disposes old terminal, creates new one with the agent command
 */
export function launchAgentTerminal(spec: Spec): vscode.Terminal {
  log(`launchAgentTerminal called for spec="${spec.name}"`);
  const cwd = getSpecWorktreeRoot(spec.name);

  if (!isTmuxAvailable()) {
    log('tmux not available, using plain terminal');
    return launchWithoutTmux(spec, cwd);
  }

  try {
    return launchWithTmux(spec, cwd);
  } catch (e) {
    console.error(`${LOG_PREFIX} tmux launch failed, falling back:`, e);
    log(`tmux launch failed: ${e}, falling back to plain terminal`);
    return launchWithoutTmux(spec, cwd);
  }
}

function launchWithTmux(spec: Spec, cwd: string): vscode.Terminal {
  const sessionName = getTmuxSessionName(spec.name);

  // Check if session exists and recreate if directory is gone (e.g., after spec delete)
  if (tmuxSessionExists(sessionName) && !fs.existsSync(cwd)) {
    log(`tmux session ${sessionName} exists but cwd ${cwd} gone, recreating session`);
    killTmuxSession(sessionName);
  }

  // Ensure tmux session exists for the target spec
  if (!tmuxSessionExists(sessionName)) {
    createTmuxSession(sessionName, cwd, spec);
    log(`created tmux session ${sessionName}`);
  }

  // Recover terminal reference after extension reload
  recoverAgentTerminal();

  // Already showing this session? Just focus it.
  if (agentTerminal && isTerminalAlive(agentTerminal) && currentTmuxSession === sessionName) {
    log(`already on ${sessionName}, showing terminal`);
    agentTerminal.show();
    return agentTerminal;
  }

  // Need to show a DIFFERENT session. We deliberately do NOT use
  // `tmux switch-client` here: when more than one client is attached to the
  // source session (e.g. an external terminal, or a previous VSCode window,
  // also attached), there is no reliable way to identify the client that
  // belongs to *this* VSCode terminal — switch-client would move the wrong
  // client and leave the VSCode view stuck on the old session. Instead dispose
  // the current agent terminal and recreate one attached to the target session.
  // The tmux session itself persists, so the running agent is unaffected.
  if (agentTerminal && isTerminalAlive(agentTerminal)) {
    log(`disposing terminal on ${currentTmuxSession} to re-attach to ${sessionName}`);
    agentTerminal.dispose();
    agentTerminal = undefined;
    currentTmuxSession = undefined;
  }

  // Clean up any stale Agent terminals before creating a new one
  disposeStaleAgentTerminals();

  // Create fresh terminal attached to the target session.
  // `-d` detaches any other client already attached to this session, so this
  // VSCode terminal becomes the sole client. Without it, tmux sizes the window
  // to the SMALLEST attached client (a leftover VSCode/external client), which
  // shrinks the pane and leaves blank columns on the right.
  agentTerminal = vscode.window.createTerminal({
    name: 'Agent',
    shellPath: 'tmux',
    shellArgs: ['attach-session', '-d', '-t', sessionName],
  });
  agentTerminal.show();
  currentTmuxSession = sessionName;
  log(`created new terminal, attached to ${sessionName}`);
  return agentTerminal;
}

function launchWithoutTmux(spec: Spec, cwd: string): vscode.Terminal {
  if (agentTerminal && isTerminalAlive(agentTerminal)) {
    agentTerminal.dispose();
  }
  agentTerminal = vscode.window.createTerminal({
    name: `Agent: ${spec.name}`,
    cwd,
  });
  agentTerminal.show();
  agentTerminal.sendText(buildAgentCommandWithPrompt(spec, cwd));
  currentTmuxSession = undefined;
  return agentTerminal;
}

export function killAgentTerminal(specName: string): void {
  const sessionName = getTmuxSessionName(specName);

  // If the current terminal is showing this spec's session, dispose it
  if (agentTerminal && currentTmuxSession === sessionName) {
    if (isTerminalAlive(agentTerminal)) {
      agentTerminal.dispose();
    }
    agentTerminal = undefined;
    currentTmuxSession = undefined;
  }

  // Kill the tmux session so it doesn't linger after delete/cleanup
  if (isTmuxAvailable()) {
    killTmuxSession(sessionName);
  }
}

export function hasAgentTerminal(specName: string): boolean {
  if (agentTerminal && isTerminalAlive(agentTerminal) && currentTmuxSession === getTmuxSessionName(specName)) {
    return true;
  }
  if (isTmuxAvailable()) {
    return tmuxSessionExists(getTmuxSessionName(specName));
  }
  return false;
}

// Clean up tracking when the terminal is closed externally.
// tmux sessions are NOT killed — the session stays alive for later reattach.
export function registerTerminalCloseHandler(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(closed => {
      if (agentTerminal === closed) {
        agentTerminal = undefined;
        currentTmuxSession = undefined;
      }
    })
  );
}

/** Pure: tmux args to print the last `lines` rows of a session's pane. */
export function buildCaptureArgs(sessionName: string, lines: number): string[] {
  return ['capture-pane', '-p', '-t', sessionName, '-S', `-${lines}`];
}

/** Pure: tmux args to send a literal line + Enter into a session. */
export function buildSendKeysArgs(sessionName: string, text: string): string[] {
  return ['send-keys', '-t', sessionName, text, 'Enter'];
}

/**
 * Capture the tail of a spec's tmux session pane for the Peek panel.
 * Returns undefined when tmux is unavailable or the session doesn't exist.
 */
export function capturePane(specName: string, lines = 200): string | undefined {
  if (!isTmuxAvailable()) { return undefined; }
  const session = getTmuxSessionName(specName);
  if (!tmuxSessionExists(session)) { return undefined; }
  try {
    return execFileSync('tmux', buildCaptureArgs(session, lines), { encoding: 'utf-8' });
  } catch {
    return undefined;
  }
}

/**
 * Send a reply line into a spec's tmux session (Peek reply / approve).
 * Returns false when tmux is unavailable or the session doesn't exist.
 */
export function sendReply(specName: string, text: string): boolean {
  if (!isTmuxAvailable()) { return false; }
  const session = getTmuxSessionName(specName);
  if (!tmuxSessionExists(session)) { return false; }
  try {
    execFileSync('tmux', buildSendKeysArgs(session, text));
    return true;
  } catch {
    return false;
  }
}
