import * as fs from 'fs';
import * as path from 'path';
import { Spec } from './types';
import { WORKTREES_DIR } from './config';

interface HookEntry { type: 'command'; command: string; }
interface HookMatcher { matcher: string; hooks: HookEntry[]; }
export interface HookSettings {
  hooks: { Notification: HookMatcher[]; Stop: HookMatcher[]; };
}

/** Pure: build the Claude Code settings object that reports AI state. */
export function buildHookSettings(specName: string, scriptPath: string): HookSettings {
  const cmd = (status: string) => `node "${scriptPath}" ${status} "${specName}"`;
  return {
    hooks: {
      Notification: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('waiting_confirm') }] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('done') }] }],
    },
  };
}

/**
 * Write .claude/settings.json into the spec's worktree root so ducc, when
 * started in that directory, reports its state only for this managed worktree.
 * Best-effort: failure must never block spec creation.
 */
export function installHooks(spec: Spec, scriptPath: string): void {
  const root = path.join(WORKTREES_DIR, spec.name);
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settings = buildHookSettings(spec.name, scriptPath);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
}
