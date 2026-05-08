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
function getTmuxSessionName(specName: string): string {
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
 * Switch an existing tmux client from one session to another.
 * Finds the client TTY attached to fromSession and switches it to toSession.
 */
function switchTmuxClient(fromSession: string, toSession: string): boolean {
  try {
    const output = execFileSync(
      'tmux',
      ['list-clients', '-t', fromSession, '-F', '#{client_tty}'],
      { encoding: 'utf-8' },
    );
    const clientTty = output.trim().split('\n')[0];
    if (!clientTty) {
      log(`switchTmuxClient: no client found for session ${fromSession}`);
      return false;
    }
    execFileSync('tmux', ['switch-client', '-c', clientTty, '-t', toSession]);
    log(`switchTmuxClient: switched ${clientTty} from ${fromSession} to ${toSession}`);
    return true;
  } catch (e) {
    log(`switchTmuxClient failed: ${e}`);
    return false;
  }
}

/**
 * Scan all tmux clients to find one attached to any ta-* session,
 * then switch it to the target session. Used as fallback when
 * currentTmuxSession is unknown (e.g. after extension reload).
 */
function switchAnyTaClient(toSession: string): boolean {
  try {
    const output = execFileSync(
      'tmux',
      ['list-clients', '-F', '#{client_tty} #{session_name}'],
      { encoding: 'utf-8' },
    );
    for (const line of output.trim().split('\n')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx < 0) { continue; }
      const tty = line.substring(0, spaceIdx);
      const session = line.substring(spaceIdx + 1);
      if (session.startsWith('ta-')) {
        execFileSync('tmux', ['switch-client', '-c', tty, '-t', toSession]);
        log(`switchAnyTaClient: switched ${tty} (was ${session}) to ${toSession}`);
        return true;
      }
    }
    log('switchAnyTaClient: no ta-* client found');
    return false;
  } catch (e) {
    log(`switchAnyTaClient failed: ${e}`);
    return false;
  }
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

  // Terminal alive — try to switch its tmux client in-place
  if (agentTerminal && isTerminalAlive(agentTerminal)) {
    log(`attempting switch from ${currentTmuxSession} to ${sessionName}`);
    const switched = currentTmuxSession
      ? switchTmuxClient(currentTmuxSession, sessionName)
      : switchAnyTaClient(sessionName);

    if (switched) {
      currentTmuxSession = sessionName;
      agentTerminal.show();
      return agentTerminal;
    }

    // Switch failed — dispose this terminal
    log('switch failed, disposing terminal');
    agentTerminal.dispose();
    agentTerminal = undefined;
    currentTmuxSession = undefined;
  }

  // Clean up any stale Agent terminals before creating a new one
  disposeStaleAgentTerminals();

  // Create fresh terminal
  agentTerminal = vscode.window.createTerminal({
    name: 'Agent',
    shellPath: 'tmux',
    shellArgs: ['attach-session', '-t', sessionName],
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
