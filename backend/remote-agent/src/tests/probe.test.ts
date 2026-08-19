import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeRemoteHost } from '../probe.js';

test('probe reports installed status per provider and git', async () => {
  const result = await probeRemoteHost();
  assert.ok(result.providers.length === 4);
  assert.equal(result.providers.filter((p) => p.provider === 'claude').length, 1);
  assert.equal(typeof result.gitInstalled, 'boolean');
  assert.equal(typeof result.nodeVersion, 'string');
});