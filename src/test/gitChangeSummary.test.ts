import { expect } from 'chai';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getChangeSummary } from '../gitOps';
import { Spec } from '../types';

describe('getChangeSummary', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-gcs-'));
    execSync('git init -q', { cwd: tmp });
    execSync('git config user.email t@t && git config user.name t', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hi');
    execSync('git add -A && git commit -q -m init', { cwd: tmp });
    // introduce changes: modify a.txt, add untracked b.txt
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'new');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function specWith(worktree: string): Spec {
    return { name: 'x', description: '', featureBranch: 'f', status: 'active', agentCommand: 'ducc',
      repos: [{ name: 'r1', originPath: worktree, worktreePath: worktree, branch: 'f' }], createdAt: '' };
  }

  it('aggregates changed file count across repos', () => {
    const sum = getChangeSummary(specWith(tmp));
    expect(sum.totalChanged).to.equal(2);
    expect(sum.repos[0].name).to.equal('r1');
    expect(sum.repos[0].files.map(f => f.path).sort()).to.deep.equal(['a.txt', 'b.txt']);
  });

  it('missing worktree contributes zero, no throw', () => {
    const sum = getChangeSummary(specWith(path.join(tmp, 'ghost')));
    expect(sum.totalChanged).to.equal(0);
    expect(sum.repos[0].files).to.deep.equal([]);
  });
});
