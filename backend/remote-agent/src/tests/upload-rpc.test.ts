import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleRpc, abortUploadSessionsFor } from '../rpc-dispatch.js';
import type { RemoteAgentConfig } from '../config.js';

async function mkroot(): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-uprpc-')));
}

function cfgFor(root: string): RemoteAgentConfig {
  return {
    serverUrl: 'ws://localhost:3000/agent',
    token: 'a-long-enough-token',
    hostId: 'host-1',
    roots: [root],
    skillRoots: [],
    agentVersion: '0.1.0',
  };
}

test('fs/uploadBegin → fs/uploadChunk → fs/uploadEnd through the dispatcher', async () => {
  const root = await mkroot();
  const cfg = cfgFor(root);
  const target = path.join(root, 'big.bin');

  const { uploadId } = (await handleRpc('fs/uploadBegin', { path: target }, cfg)) as {
    uploadId: string;
  };
  await handleRpc(
    'fs/uploadChunk',
    { uploadId, index: 0, data: Buffer.from('aa').toString('base64') },
    cfg,
  );
  const done = (await handleRpc('fs/uploadEnd', { uploadId }, cfg)) as { size: number };

  assert.equal(done.size, 2);
  assert.equal(await fsp.readFile(target, 'utf8'), 'aa');
  await fsp.rm(root, { recursive: true, force: true });
});

test('fs/uploadChunk rejects an out-of-order index through the dispatcher', async () => {
  const root = await mkroot();
  const cfg = cfgFor(root);
  const target = path.join(root, 'big.bin');
  const { uploadId } = (await handleRpc('fs/uploadBegin', { path: target }, cfg)) as {
    uploadId: string;
  };

  await assert.rejects(
    () => handleRpc('fs/uploadChunk', { uploadId, index: 5, data: 'AAAA' }, cfg),
    /out of order/,
  );
  await fsp.rm(root, { recursive: true, force: true });
});

test('abortUploadSessionsFor drops an in-flight upload for the given roots', async () => {
  const root = await mkroot();
  const cfg = cfgFor(root);
  const target = path.join(root, 'big.bin');
  const { uploadId } = (await handleRpc('fs/uploadBegin', { path: target }, cfg)) as {
    uploadId: string;
  };
  await handleRpc(
    'fs/uploadChunk',
    { uploadId, index: 0, data: Buffer.from('a').toString('base64') },
    cfg,
  );

  await abortUploadSessionsFor(cfg);

  // The session is gone: a late chunk for it is now an unknown session.
  await assert.rejects(
    () => handleRpc('fs/uploadChunk', { uploadId, index: 1, data: 'AAAA' }, cfg),
    /unknown upload/,
  );
  await fsp.rm(root, { recursive: true, force: true });
});

test('fs/uploadChunk rejects an absurdly large frame before decoding it', async () => {
  const root = await mkroot();
  const cfg = cfgFor(root);
  const target = path.join(root, 'big.bin');
  const { uploadId } = (await handleRpc('fs/uploadBegin', { path: target }, cfg)) as {
    uploadId: string;
  };

  // 16MiB encoded cap + 1 byte; main slices at 4MiB so this is never legitimate.
  const oversized = 'A'.repeat(16 * 1024 * 1024 + 1);
  await assert.rejects(
    () => handleRpc('fs/uploadChunk', { uploadId, index: 0, data: oversized }, cfg),
    /chunk too large/,
  );
  // The session must survive a rejected frame (nothing was written).
  await handleRpc('fs/uploadChunk', { uploadId, index: 0, data: 'AAAA' }, cfg);
  await handleRpc('fs/uploadEnd', { uploadId }, cfg);
  assert.equal(await fsp.readFile(target, 'utf8'), Buffer.from('AAAA', 'base64').toString('utf8'));
  await fsp.rm(root, { recursive: true, force: true });
});
