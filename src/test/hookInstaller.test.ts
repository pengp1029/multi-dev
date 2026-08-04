import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildHookSettings, installHooks } from '../hookInstaller';
import { WORKTREES_DIR } from '../config';
import { Spec } from '../types';

describe('hookInstaller', () => {
  it('buildHookSettings registers Notification→waiting_confirm and Stop→done', () => {
    const s = buildHookSettings('login-flow', '/ext/scripts/report-state.js');
    const notif = s.hooks.Notification[0].hooks[0].command;
    const stop = s.hooks.Stop[0].hooks[0].command;
    expect(notif).to.contain('report-state.js');
    expect(notif).to.contain('waiting_confirm');
    expect(notif).to.contain('login-flow');
    expect(stop).to.contain('done');
    expect(stop).to.contain('login-flow');
  });

  it('installHooks writes .claude/settings.json under spec worktree root', () => {
    const name = 'test-hook-spec';
    const spec: Spec = { name, description: '', featureBranch: 'f', status: 'active', agentCommand: 'ducc', repos: [], createdAt: '' };
    const root = path.join(WORKTREES_DIR, name);
    fs.mkdirSync(root, { recursive: true });
    try {
      installHooks(spec, '/ext/scripts/report-state.js');
      const settingsPath = path.join(root, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).to.equal(true);
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(parsed.hooks.Stop[0].hooks[0].command).to.contain('done');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
