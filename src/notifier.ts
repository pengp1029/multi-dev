import { execFile } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import { SpecStatus } from './types';

const NOTIFY_STATUSES: SpecStatus[] = ['waiting_confirm', 'done'];

/**
 * Pure: decide whether a status transition warrants an intrusive notification.
 * Only waiting_confirm/done notify, and only when the status actually changed.
 */
export function shouldNotify(prev: SpecStatus, next: SpecStatus): boolean {
  if (!NOTIFY_STATUSES.includes(next)) { return false; }
  return prev !== next;
}

// Per-spec cooldown so a spec cannot produce more than one intrusive
// notification per window. ducc's Stop and Notification hooks interleave
// (each turn ends Stop→done then Notification→waiting_confirm), and idle
// re-notifications re-fire the hook; without a cooldown that oscillation
// spams the user with toasts while they haven't replied.
const NOTIFY_COOLDOWN_MS = 8000;
const _lastNotify = new Map<string, number>();

/**
 * Stateful dedup gate: returns true at most once per spec per cooldown window,
 * recording the timestamp when it allows. Kept separate from the pure
 * `shouldNotify` so the transition logic stays unit-testable.
 */
export function passNotifyCooldown(specName: string, now: number = Date.now(), cooldownMs: number = NOTIFY_COOLDOWN_MS): boolean {
  const last = _lastNotify.get(specName);
  if (last !== undefined && now - last < cooldownMs) { return false; }
  _lastNotify.set(specName, now);
  return true;
}

function label(status: SpecStatus): string {
  return status === 'waiting_confirm' ? '等待你确认' : status === 'done' ? '任务完成' : status;
}

/** Fire system notification + optional webhook + VSCode toast, then jump on click. */
export function notify(specName: string, status: SpecStatus, message: string | undefined, onJump: () => void): void {
  const vscode = require('vscode');
  const cfg = vscode.workspace.getConfiguration('tmuxAgent');
  const title = `ducc · ${specName}`;
  const body = `${label(status)}${message ? ' · ' + message : ''}`;

  if (cfg.get('notify.system', true)) {
    sendSystemNotification(title, body);
  }
  const webhook = cfg.get('notify.webhookUrl', '');
  if (webhook) { postWebhook(webhook, { spec: specName, status, message, updatedAt: new Date().toISOString() }); }

  vscode.window.showInformationMessage(`${title}: ${body}`, '进入').then((choice: string | undefined) => {
    if (choice === '进入') { onJump(); }
  });
}

function sendSystemNotification(title: string, body: string): void {
  const platform = process.platform;
  const done = (_e: unknown) => { /* fall back silently to the VSCode toast */ };
  if (platform === 'darwin') {
    execFile('terminal-notifier', ['-title', title, '-message', body, '-sound', 'default'], done);
  } else if (platform === 'linux') {
    execFile('notify-send', [title, body], done);
  } else if (platform === 'win32') {
    const ps = `New-BurntToastNotification -Text '${title}','${body}'`;
    execFile('powershell', ['-NoProfile', '-Command', ps], done);
  }
}

function postWebhook(url: string, payload: Record<string, unknown>): void {
  try {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    });
    req.on('error', () => { /* log-and-ignore */ });
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  } catch { /* invalid URL — ignore */ }
}
