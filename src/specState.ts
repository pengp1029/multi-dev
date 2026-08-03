import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR, ensureDirs } from './config';
import { SpecState, SpecStatus } from './types';

const VALID: SpecStatus[] = ['working', 'waiting_confirm', 'done', 'idle'];

export function stateFilePath(specName: string): string {
  return path.join(STATE_DIR, `${specName}.json`);
}

/** Read a spec's AI state. Missing/corrupt/unknown → idle (never throws). */
export function readSpecState(specName: string): SpecState {
  const idle: SpecState = { status: 'idle', updatedAt: '' };
  const f = stateFilePath(specName);
  if (!fs.existsSync(f)) { return idle; }
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>;
    const status = raw['status'] as SpecStatus;
    if (!VALID.includes(status)) { return idle; }
    return {
      status,
      message: typeof raw['message'] === 'string' ? (raw['message'] as string) : undefined,
      updatedAt: typeof raw['updatedAt'] === 'string' ? (raw['updatedAt'] as string) : '',
    };
  } catch {
    return idle;
  }
}

/** Write a spec's AI state (dumb — used by the report-state script's TS twin and tests). */
export function writeSpecState(specName: string, status: SpecStatus, message?: string): void {
  ensureDirs();
  const state: SpecState = { status, message, updatedAt: new Date().toISOString() };
  fs.writeFileSync(stateFilePath(specName), JSON.stringify(state), 'utf-8');
}
