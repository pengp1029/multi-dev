import { expect } from 'chai';
import * as fs from 'fs';
import { PROJECTS_DIR, STATE_DIR, ensureDirs } from '../config';

describe('config', () => {
  it('exposes projects and state dirs under ~/.tmux-agent', () => {
    expect(PROJECTS_DIR.endsWith('/.tmux-agent/projects')).to.equal(true);
    expect(STATE_DIR.endsWith('/.tmux-agent/state')).to.equal(true);
  });

  it('ensureDirs creates projects and state dirs', () => {
    ensureDirs();
    expect(fs.existsSync(PROJECTS_DIR)).to.equal(true);
    expect(fs.existsSync(STATE_DIR)).to.equal(true);
  });
});
