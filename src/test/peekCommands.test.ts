import { expect } from 'chai';
import { buildCaptureArgs, buildSendKeysArgs } from '../terminalOps';

describe('peek tmux command builders', () => {
  it('capture args target session and print last N lines', () => {
    const args = buildCaptureArgs('ta-login-flow', 200);
    expect(args).to.deep.equal(['capture-pane', '-p', '-t', 'ta-login-flow', '-S', '-200']);
  });
  it('send-keys args send literal text then Enter', () => {
    const args = buildSendKeysArgs('ta-login-flow', 'yes');
    expect(args).to.deep.equal(['send-keys', '-t', 'ta-login-flow', 'yes', 'Enter']);
  });
});
