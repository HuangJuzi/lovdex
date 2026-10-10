import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUploadSessions } from '../upload-session.js';
import { createAllowlistedFs } from '../fs.js';

async function mkroot(): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-upload-')));
}

function makeSessions(root: string) {
  return createUploadSessions({ fs: createAllowlistedFs({ roots: [root] }), idleMs: 60_000 });
}

test('begin → chunk → end writes the reassembled bytes to the target path', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('hello ').toString('base64'));
  await s.chunk(uploadId, 1, Buffer.from('world').toString('base64'));
  const done = await s.end(uploadId);

  assert.equal(done.size, 11);
  assert.equal(await fsp.readFile(target, 'utf8'), 'hello world');
  await fsp.rm(root, { recursive: true, force: true });
});

test('end over an existing target replaces it', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');
  await fsp.writeFile(target, 'old');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('new').toString('base64'));
  await s.end(uploadId);

  assert.equal(await fsp.readFile(target, 'utf8'), 'new');
  await fsp.rm(root, { recursive: true, force: true });
});

test('an out-of-order chunk index is rejected and the session is torn down', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  await assert.rejects(() => s.chunk(uploadId, 2, Buffer.from('b').toString('base64')), /out of order/);

  // The session is gone and its .part file with it.
  assert.equal(s.size(), 0);
  assert.equal(await fsp.stat(target).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('a replayed chunk index is rejected', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  await assert.rejects(() => s.chunk(uploadId, 0, Buffer.from('a').toString('base64')), /out of order/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('an unknown uploadId is rejected on chunk and end', async () => {
  const root = await mkroot();
  const s = makeSessions(root);

  await assert.rejects(() => s.chunk('nope', 0, 'AAAA'), /unknown upload/);
  await assert.rejects(() => s.end('nope'), /unknown upload/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('abortAll drops sessions and their .part files', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  const partPath = s.partPathForTest(uploadId);
  assert.ok(partPath);

  await s.abortAll();

  assert.equal(s.size(), 0);
  assert.equal(await fsp.stat(partPath as string).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('an idle session is dropped and its .part removed', async () => {
  const root = await mkroot();
  const s = createUploadSessions({
    fs: createAllowlistedFs({ roots: [root] }),
    idleMs: 20,
  });
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  const partPath = s.partPathForTest(uploadId) as string;

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(s.size(), 0);
  assert.equal(await fsp.stat(partPath).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('begin outside the allowed roots is rejected', async () => {
  const root = await mkroot();
  const s = makeSessions(root);

  await assert.rejects(() => s.begin('/etc/pwned'), /allowed root/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('begin over a dangling symlink leaf is rejected (no write-through)', async () => {
  const root = await mkroot();
  const outside = await mkroot();
  const victim = path.join(outside, 'victim.bin');
  await fsp.symlink(victim, path.join(root, 'evil'));
  const s = makeSessions(root);

  await assert.rejects(() => s.begin(path.join(root, 'evil')), /allowed root|symlink/);
  assert.equal(await fsp.stat(victim).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});
