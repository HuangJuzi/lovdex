import assert from 'node:assert/strict';
import test from 'node:test';

import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';

test('synchronizeFile ignores non-dsh paths and never throws', async () => {
  const sync = new DshSessionSynchronizer();
  const result = await sync.synchronizeFile('/nonexistent/not-a-session.jsonl');
  assert.equal(result, null);
});

test('synchronize is a no-op when no dsh home is configured', async () => {
  const count = await new DshSessionSynchronizer().synchronize();
  assert.equal(typeof count, 'number');
});
