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
