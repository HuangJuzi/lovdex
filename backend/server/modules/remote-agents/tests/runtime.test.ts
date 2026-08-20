import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getRemoteAgentsRuntime, setRemoteAgentsRuntime } from '../runtime.js';
import type { RemoteAgentsRegistry } from '../remote-agents.registry.js';
import type { RemoteFsClient } from '../remote-fs.service.js';

function fakeRuntime(): Parameters<typeof setRemoteAgentsRuntime>[0] {
  return {
    registry: {} as unknown as RemoteAgentsRegistry,
    fsClient: {} as unknown as RemoteFsClient,
    historyClient: {} as never,
  };
}

test('get before set throws not configured', () => {
  assert.throws(() => getRemoteAgentsRuntime(), /not configured/);
});

test('set then get returns the same object', () => {
  const runtime = fakeRuntime();
  setRemoteAgentsRuntime(runtime);
  assert.equal(getRemoteAgentsRuntime(), runtime);
});