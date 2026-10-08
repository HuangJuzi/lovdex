import assert from 'node:assert/strict';
import test from 'node:test';

import { DshProviderAuth } from '@/modules/providers/list/dsh/dsh-auth.provider.js';

test('getStatus returns the shared shape and never throws', async () => {
  const status = await new DshProviderAuth().getStatus();
  assert.equal(status.provider, 'dsh');
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(typeof status.authenticated, 'boolean');
});
