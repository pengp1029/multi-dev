import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export const TMUX_AGENT_HOME = path.join(os.homedir(), '.tmux-agent');
export const SPECS_DIR = path.join(TMUX_AGENT_HOME, 'specs');
export const WORKTREES_DIR = path.join(TMUX_AGENT_HOME, 'worktrees');
export const WORKSPACES_DIR = path.join(TMUX_AGENT_HOME, 'workspaces');

export function ensureDirs(): void {
  for (const dir of [TMUX_AGENT_HOME, SPECS_DIR, WORKTREES_DIR, WORKSPACES_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
