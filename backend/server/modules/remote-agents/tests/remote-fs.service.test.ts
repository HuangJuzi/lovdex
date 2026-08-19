import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteFsClient } from '../remote-fs.service.js';
import type { RemoteAgentsRegistry } from '../remote-agents.registry.js';
import type { RemoteStat } from '@/shared/agent-runtime/protocol.js';

type RpcCall = { hostId: string; method: string; params: unknown };

function fakeRegistry(reply: (call: RpcCall) => unknown): {
  reg: RemoteAgentsRegistry;
  calls: RpcCall[];
  timeouts: number[];
} {
  const calls: RpcCall[] = [];
  const timeouts: number[] = [];
  const reg = {
    async rpc<T = unknown>(
      hostId: string,
      method: string,
      params: unknown,
      timeoutMs = 60_000,
    ): Promise<T> {
      const call = { hostId, method, params };
      calls.push(call);
      timeouts.push(timeoutMs);
      return reply(call) as T;
    },
  } as unknown as RemoteAgentsRegistry;
  return { reg, calls, timeouts };
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

test('read delegates to rpc fs/read with default maxBytes and encoding', async () => {
  const payload = { content: 'hi', truncated: false };
  const { reg, calls } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.read('h3', '/srv/app/file.txt');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    {
      hostId: 'h3',
      method: 'fs/read',
      params: { path: '/srv/app/file.txt', maxBytes: 32 * 1024 * 1024, encoding: 'utf8' },
    },
  ]);
});

test('read forwards an explicit maxBytes and base64 encoding', async () => {
  const payload = { content: 'AQIDBA==', truncated: false };
  const { reg, calls } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.read('h10', '/tmp/a.bin', 1024, 'base64');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    { hostId: 'h10', method: 'fs/read', params: { path: '/tmp/a.bin', maxBytes: 1024, encoding: 'base64' } },
  ]);
});

test('write delegates to rpc fs/write with utf8 default and 120s timeout', async () => {
  const payload = { success: true, size: 11 };
  const { reg, calls, timeouts } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.write('h4', '/srv/app/new.txt', 'hello world');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    {
      hostId: 'h4',
      method: 'fs/write',
      params: { path: '/srv/app/new.txt', content: 'hello world', encoding: 'utf8' },
    },
  ]);
  assert.deepEqual(timeouts, [120_000]);
});

test('write forwards base64 content with 120s timeout', async () => {
  const { reg, calls, timeouts } = fakeRegistry(() => ({ success: true, size: 4 }));
  const client = createRemoteFsClient(() => reg);

  const bin = Buffer.from([1, 2, 3, 4]);
  const result = await client.write('h5', '/tmp/a.bin', bin.toString('base64'), 'base64');

  assert.equal(result.success, true);
  assert.equal((calls[0].params as { encoding: string }).encoding, 'base64');
  assert.equal(timeouts[0], 120_000);
});

test('tree delegates to rpc fs/tree with defaults', async () => {
  const payload = { path: '/srv/app', nodes: [] };
  const { reg, calls } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.tree('h6', '/srv/app');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    { hostId: 'h6', method: 'fs/tree', params: { path: '/srv/app', maxDepth: 10, showHidden: true } },
  ]);
});

test('tree forwards a custom maxDepth and showHidden', async () => {
  const { reg, calls } = fakeRegistry(() => []);
  const client = createRemoteFsClient(() => reg);

  await client.tree('h6', '/srv/app', 3, false);

  assert.deepEqual(calls[0].params, { path: '/srv/app', maxDepth: 3, showHidden: false });
});

test('create delegates to rpc fs/create', async () => {
  const payload = { success: true, path: '/srv/app/sub' };
  const { reg, calls } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.create('h7', '/srv/app', 'directory', 'sub');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    { hostId: 'h7', method: 'fs/create', params: { parentPath: '/srv/app', type: 'directory', name: 'sub' } },
  ]);
});

test('rename delegates to rpc fs/rename', async () => {
  const payload = { success: true, newPath: '/srv/app/renamed.txt' };
  const { reg, calls } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.rename('h8', '/srv/app/old.txt', 'renamed.txt');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    { hostId: 'h8', method: 'fs/rename', params: { oldPath: '/srv/app/old.txt', newName: 'renamed.txt' } },
  ]);
});

test('delete delegates to rpc fs/delete', async () => {
  const payload = { success: true };
  const { reg, calls } = fakeRegistry(() => payload);
  const client = createRemoteFsClient(() => reg);

  const result = await client.delete('h9', '/srv/app/old.txt', 'file');

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    { hostId: 'h9', method: 'fs/delete', params: { path: '/srv/app/old.txt', type: 'file' } },
  ]);
});

test('errors from rpc propagate', async () => {
  const { reg } = fakeRegistry(() => {
    throw new Error('remote host offline: h9');
  });
  const client = createRemoteFsClient(() => reg);

  await assert.rejects(() => client.stat('h9', '/srv/app'), /remote host offline: h9/);
});
