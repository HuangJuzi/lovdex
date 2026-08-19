import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteFsClient } from '../remote-fs.service.js';
import type { RemoteAgentsRegistry } from '../remote-agents.registry.js';
import type { RemoteStat } from '@/shared/agent-runtime/protocol.js';

type RpcCall = { hostId: string; method: string; params: unknown };

function fakeRegistry(reply: (call: RpcCall) => unknown): {
  reg: RemoteAgentsRegistry;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const reg = {
    async rpc<T = unknown>(hostId: string, method: string, params: unknown): Promise<T> {
      const call = { hostId, method, params };
      calls.push(call);
      return reply(call) as T;
    },
  } as unknown as RemoteAgentsRegistry;
  return { reg, calls };
}

test('stat delegates to rpc fs/stat with the path', async () => {
  const stat: RemoteStat = { exists: true, isDirectory: true, isFile: false, size: 0, mtimeMs: 1 };
  const { reg, calls } = fakeRegistry(() => stat);
  const client = createRemoteFsClient(() => reg);

  const result = await client.stat('h1', '/srv/app');

  assert.deepEqual(result, stat);
  assert.deepEqual(calls, [{ hostId: 'h1', method: 'fs/stat', params: { path: '/srv/app' } }]);
});

test('list delegates to rpc fs/list with default maxEntries', async () => {
  const listing = { path: '/srv/app', entries: [{ name: 'a', type: 'file' as const, size: 3 }] };
  const { reg, calls } = fakeRegistry(() => listing);
  const client = createRemoteFsClient(() => reg);

  const result = await client.list('h2', '/srv/app');

  assert.deepEqual(result, listing);
  assert.deepEqual(calls, [{ hostId: 'h2', method: 'fs/list', params: { path: '/srv/app', maxEntries: 200 } }]);
});

test('list forwards a custom maxEntries', async () => {
  const { reg, calls } = fakeRegistry(() => []);
  const client = createRemoteFsClient(() => reg);

  await client.list('h2', '/srv/app', 5);

  assert.deepEqual(calls[0].params, { path: '/srv/app', maxEntries: 5 });
});

test('read delegates to rpc fs/read with default maxBytes', async () => {
  const payload = { content: 'hi', truncated: false };
  const { reg, calls } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.read('h3', '/srv/app/file.txt');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    { hostId: 'h3', method: 'fs/read', params: { path: '/srv/app/file.txt', maxBytes: 1024 * 1024 } },
  ]);
});

test('errors from rpc propagate', async () => {
  const { reg } = fakeRegistry(() => {
    throw new Error('remote host offline: h9');
  });
  const client = createRemoteFsClient(() => reg);

  await assert.rejects(() => client.stat('h9', '/srv/app'), /remote host offline: h9/);
});
