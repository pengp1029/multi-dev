import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR } from '../config';
import { readSpecState, writeSpecState, stateFilePath } from '../specState';

describe('specState', () => {
  const name = 'test-state-spec';
  afterEach(() => {
    const f = stateFilePath(name);
    if (fs.existsSync(f)) { fs.unlinkSync(f); }
  });

  it('missing file → idle', () => {
    expect(readSpecState(name).status).to.equal('idle');
  });

  it('writes then reads back status/message', () => {
    writeSpecState(name, 'waiting_confirm', 'need input');
    const s = readSpecState(name);
    expect(s.status).to.equal('waiting_confirm');
    expect(s.message).to.equal('need input');
    expect(typeof s.updatedAt).to.equal('string');
  });

  it('corrupt json → idle', () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFilePath(name), '{not json', 'utf-8');
    expect(readSpecState(name).status).to.equal('idle');
  });

  it('unknown status value → idle', () => {
    fs.writeFileSync(stateFilePath(name), JSON.stringify({ status: 'bogus', updatedAt: 'x' }), 'utf-8');
    expect(readSpecState(name).status).to.equal('idle');
  });
});
