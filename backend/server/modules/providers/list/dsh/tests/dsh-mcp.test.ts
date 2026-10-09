import assert from 'node:assert/strict';
import test from 'node:test';

import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';

test('listServers returns all three scope buckets, all empty', async () => {
  const servers = await new DshMcpProvider().listServers();
  assert.deepEqual(servers.user, []);
  assert.deepEqual(servers.local, []);
  assert.deepEqual(servers.project, []);
});

test('listServersForScope returns [] for any scope', async () => {
  const provider = new DshMcpProvider();
  assert.deepEqual(await provider.listServersForScope('user'), []);
  assert.deepEqual(await provider.listServersForScope('project'), []);
});

test('upsertServer rejects with a clear unsupported error', async () => {
  await assert.rejects(
    () => new DshMcpProvider().upsertServer({ name: 'x', transport: 'stdio', command: 'echo' }),
    /per session over ACP/,
  );
});

test('removeServer reports nothing removed', async () => {
  const result = await new DshMcpProvider().removeServer({ name: 'x' });
  assert.equal(result.removed, false);
  assert.equal(result.provider, 'dsh');
});
