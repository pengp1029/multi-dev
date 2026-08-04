import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR, ensureDirs } from './config';
import { readSpecState } from './specState';
import { SpecStatus } from './types';

export interface StateChange {
  specName: string;
  prev: SpecStatus;
  next: SpecStatus;
}

type Listener = (e: StateChange) => void;
interface Disposable { dispose(): void; }

export class StateWatcher {
  private _listeners: Listener[] = [];
  private _last = new Map<string, SpecStatus>();
  private _watcher: fs.FSWatcher | undefined;
  private _debounce = new Map<string, NodeJS.Timeout>();

  /**
   * Subscribe to state changes. Mirrors the vscode.Event calling convention
   * (invoke with a listener, get back a Disposable) so extension.ts can wire it
   * the same way, but without importing vscode (keeps this unit-testable).
   */
  readonly onDidChangeState = (listener: Listener): Disposable => {
    this._listeners.push(listener);
    return {
      dispose: () => {
        const i = this._listeners.indexOf(listener);
        if (i >= 0) { this._listeners.splice(i, 1); }
      },
    };
  };

  private fire(e: StateChange): void {
    for (const l of this._listeners) { l(e); }
  }

  /** Begin watching STATE_DIR. Safe to call once at activation. */
  start(): void {
    ensureDirs();
    try {
      this._watcher = fs.watch(STATE_DIR, (_event, filename) => {
        if (!filename || !filename.toString().endsWith('.json')) { return; }
        const specName = path.basename(filename.toString(), '.json');
        const existing = this._debounce.get(specName);
        if (existing) { clearTimeout(existing); }
        this._debounce.set(specName, setTimeout(() => this.handleChange(specName), 100));
      });
    } catch {
      // STATE_DIR unavailable — watcher simply inactive
    }
  }

  /** Read current state for a spec, compare to cache, emit if changed. */
  handleChange(specName: string): void {
    const prev = this._last.get(specName) ?? 'idle';
    const next = readSpecState(specName).status;
    if (prev === next) { return; }
    this._last.set(specName, next);
    this.fire({ specName, prev, next });
  }

  dispose(): void {
    this._watcher?.close();
    for (const t of this._debounce.values()) { clearTimeout(t); }
    this._listeners = [];
  }
}
