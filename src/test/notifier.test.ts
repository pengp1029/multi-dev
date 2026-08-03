import { expect } from 'chai';
import { shouldNotify, passNotifyCooldown } from '../notifier';

describe('notifier.shouldNotify', () => {
  it('notifies on transition into waiting_confirm', () => {
    expect(shouldNotify('working', 'waiting_confirm')).to.equal(true);
  });
  it('notifies on transition into done', () => {
    expect(shouldNotify('working', 'done')).to.equal(true);
  });
  it('does not notify for working', () => {
    expect(shouldNotify('idle', 'working')).to.equal(false);
  });
  it('does not notify for idle', () => {
    expect(shouldNotify('done', 'idle')).to.equal(false);
  });
  it('dedupes repeated same status', () => {
    expect(shouldNotify('waiting_confirm', 'waiting_confirm')).to.equal(false);
  });
});

describe('notifier.passNotifyCooldown', () => {
  it('allows the first notification for a spec', () => {
    expect(passNotifyCooldown('cool-a', 1000, 8000)).to.equal(true);
  });
  it('blocks a second notification within the cooldown window', () => {
    passNotifyCooldown('cool-b', 1000, 8000);
    expect(passNotifyCooldown('cool-b', 5000, 8000)).to.equal(false);
  });
  it('allows again once the window has elapsed', () => {
    passNotifyCooldown('cool-c', 1000, 8000);
    expect(passNotifyCooldown('cool-c', 9001, 8000)).to.equal(true);
  });
  it('tracks specs independently', () => {
    passNotifyCooldown('cool-d', 1000, 8000);
    expect(passNotifyCooldown('cool-e', 1000, 8000)).to.equal(true);
  });
});
