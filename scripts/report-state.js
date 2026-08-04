#!/usr/bin/env node
// Dumb state reporter invoked by Claude Code hooks inside a managed worktree.
// Usage: node report-state.js <status> <specName>
// Writes ~/.tmux-agent/state/<specName>.json = { status, updatedAt }.
const fs = require('fs');
const os = require('os');
const path = require('path');

const [, , status, specName] = process.argv;
if (!status || !specName) { process.exit(0); } // dumb: never fail the hook

const stateDir = path.join(os.homedir(), '.tmux-agent', 'state');
try {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `${specName}.json`),
    JSON.stringify({ status, updatedAt: new Date().toISOString() }),
    'utf-8',
  );
} catch {
  // best effort — a failed state write must not disrupt the agent
}
