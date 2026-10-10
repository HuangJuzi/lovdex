import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pushFileToRemote, UPLOAD_CHUNK_BYTES } from '../remote-upload.service.js';
import type { RemoteFsClient } from '@/modules/remote-agents/remote-fs.service.js';

type Call = { method: string; args: unknown[] };

function fakeFsClient(): { client: RemoteFsClient; calls: Call[]; received: Buffer[] } {
  const calls: Call[] = [];
  const received: Buffer[] = [];
  let size = 0;
  const client = {
    uploadBegin: async (...args: unknown[]) => {
      calls.push({ method: 'begin', args });
      return { uploadId: 'u1' };
    },
    uploadChunk: async (_h: string, _id: string, index: number, data: string) => {
      calls.push({ method: 'chunk', args: [index] });
      const buf = Buffer.from(data, 'base64');
      received.push(buf);
      size += buf.length;
      return { received: size };
    },
    uploadEnd: async (...args: unknown[]) => {
      calls.push({ method: 'end', args });
      return { success: true, size };
    },
  } as unknown as RemoteFsClient;
  return { client, calls, received };
}

async function mktmpfile(bytes: number): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lovdex-push-'));
  const file = path.join(dir, 'payload.bin');
  await fsp.writeFile(file, Buffer.alloc(bytes, 7));
  return file;
}

test('a small file is pushed as exactly one chunk and reassembles byte-for-byte', async () => {
  const file = await mktmpfile(1024);
  const { client, calls, received } = fakeFsClient();

  const result = await pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/big.bin');

  assert.equal(result.size, 1024);
  assert.deepEqual(calls.map((c) => c.method), ['begin', 'chunk', 'end']);
  assert.deepEqual(calls[0].args, ['h1', '/srv/big.bin']);
  assert.deepEqual(received[0], Buffer.alloc(1024, 7));
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('a file larger than one chunk is split at UPLOAD_CHUNK_BYTES with ordered indices', async () => {
  const bytes = UPLOAD_CHUNK_BYTES * 2 + 100;
  const file = await mktmpfile(bytes);
  const { client, calls, received } = fakeFsClient();

  const result = await pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/big.bin');

  assert.equal(result.size, bytes);
  const chunkCalls = calls.filter((c) => c.method === 'chunk');
  assert.equal(chunkCalls.length, 3);
  assert.deepEqual(chunkCalls.map((c) => c.args[0]), [0, 1, 2]);
  assert.deepEqual(
    received.map((b) => b.length),
    [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 100],
  );
  assert.equal(Buffer.concat(received).equals(Buffer.alloc(bytes, 7)), true);
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('a zero-byte file still begins and ends (one empty chunk)', async () => {
  const file = await mktmpfile(0);
  const { client, calls } = fakeFsClient();

  const result = await pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/empty.bin');

  assert.equal(result.size, 0);
  assert.deepEqual(calls.map((c) => c.method), ['begin', 'chunk', 'end']);
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('a mid-stream chunk failure propagates and does not call end', async () => {
  const bytes = UPLOAD_CHUNK_BYTES * 2;
  const file = await mktmpfile(bytes);
  const { client, calls } = fakeFsClient();
  let n = 0;
  (client as { uploadChunk: unknown }).uploadChunk = async () => {
    n += 1;
    if (n === 2) throw new Error('remote rpc timeout: fs/uploadChunk');
    return { received: 0 };
  };

  await assert.rejects(
    () => pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/big.bin'),
    /timeout/,
  );
  assert.equal(calls.some((c) => c.method === 'end'), false);
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});
