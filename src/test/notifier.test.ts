import { expect } from 'chai';
import { shouldNotify } from '../notifier';

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
