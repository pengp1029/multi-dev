import { expect } from 'chai';
import { StateWatcher } from '../stateWatcher';
import { writeSpecState, stateFilePath } from '../specState';
import * as fs from 'fs';

describe('StateWatcher.handleChange', () => {
  const name = 'test-watch-spec';
  afterEach(() => {
    const f = stateFilePath(name);
    if (fs.existsSync(f)) { fs.unlinkSync(f); }
  });

  it('emits prev+next on status change', () => {
    const w = new StateWatcher();
    const events: Array<{ specName: string; prev: string; next: string }> = [];
    w.onDidChangeState(e => events.push(e));

    writeSpecState(name, 'waiting_confirm');
    w.handleChange(name);
    expect(events).to.have.length(1);
    expect(events[0].prev).to.equal('idle');
    expect(events[0].next).to.equal('waiting_confirm');
  });

  it('does not emit when status is unchanged', () => {
    const w = new StateWatcher();
    const events: unknown[] = [];
    w.onDidChangeState(() => events.push(1));
    writeSpecState(name, 'done');
    w.handleChange(name);
    w.handleChange(name); // second time: same status, no emit
    expect(events).to.have.length(1);
  });
});
