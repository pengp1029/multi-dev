import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR } from '../config';
import { saveSpec, loadSpec, deleteSpec } from '../store';
import { Spec } from '../types';

function makeSpec(over: Partial<Spec> = {}): Spec {
  return {
    name: 'test-spec-store',
    description: 'd',
    featureBranch: 'feat/x',
    status: 'active',
    agentCommand: 'ducc',
    repos: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('store projectName', () => {
  afterEach(() => {
    const f = path.join(SPECS_DIR, 'test-spec-store.yaml');
    if (fs.existsSync(f)) { fs.unlinkSync(f); }
  });

  it('persists and reloads projectName', () => {
    saveSpec(makeSpec({ projectName: 'user-auth' }));
    const loaded = loadSpec('test-spec-store');
    expect(loaded?.projectName).to.equal('user-auth');
  });

  it('loads legacy spec without projectName as undefined', () => {
    const f = path.join(SPECS_DIR, 'test-spec-store.yaml');
    fs.writeFileSync(f, 'name: test-spec-store\nfeature_branch: feat/x\nstatus: active\n', 'utf-8');
    const loaded = loadSpec('test-spec-store');
    expect(loaded?.projectName).to.equal(undefined);
  });
});
