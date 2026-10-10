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

test('the .part file is created inside the roots, never beside them', async () => {
  const root = await mkroot();
  // The target's own directory must exist — `begin` never creates it.
  await fsp.mkdir(path.join(root, 'sub'));
  const s = makeSessions(root);
  const { uploadId } = await s.begin(path.join(root, 'sub', 'a.bin'));
  void uploadId;
  const partPath = s.partPathForTest(uploadId) as string;

  // Inside the root (a bare `${target}.part` concat would put it at root+'.part-…').
  assert.equal(path.dirname(partPath), path.join(root, 'sub'));
  await fsp.rm(root, { recursive: true, force: true });
});

test('begin when the target IS a root is rejected (its .part would fall outside)', async () => {
  const root = await mkroot();
  const s = makeSessions(root);

  // `root` IS a root and a directory, so the pre-existing directory-target
  // guard fires before the part-dir resolve; either way `begin` must refuse.
  await assert.rejects(() => s.begin(root), /allowed root|cannot upload over a directory/);
  // Nothing was created beside the root either.
  assert.equal(await fsp.stat(`${root}.part-x`).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('a symlink planted at a guessable part name cannot be written through', async () => {
  const root = await mkroot();
  const outside = await mkroot();
  const victim = path.join(outside, 'authorized_keys');
  await fsp.writeFile(victim, 'REAL KEY');
  const s = makeSessions(root);

  // The old naming scheme was `up-<pid>-<counter>`; plant links for the first
  // few counters a fresh process would hand out.
  for (const n of [1, 2, 3]) {
    await fsp.symlink(victim, path.join(root, `.a.bin.part-up-${process.pid}-${n}`));
    await fsp.symlink(victim, path.join(root, `a.bin.part-up-${process.pid}-${n}`));
  }

  const { uploadId } = await s.begin(path.join(root, 'a.bin'));
  await s.chunk(uploadId, 0, Buffer.from('PWNED').toString('base64'));
  await s.end(uploadId);

  assert.equal(await fsp.readFile(victim, 'utf8'), 'REAL KEY', 'the outside file must be untouched');
  assert.equal(await fsp.readFile(path.join(root, 'a.bin'), 'utf8'), 'PWNED');
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

test('upload ids are not guessable across sessions', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const a = await s.begin(path.join(root, 'a.bin'));
  const b = await s.begin(path.join(root, 'b.bin'));

  assert.notEqual(a.uploadId, b.uploadId);
  // No counter/pid spelling to predict.
  assert.equal(/\d+-\d+$/.test(a.uploadId), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('begin rejects a directory target instead of failing at end', async () => {
  const root = await mkroot();
  const dir = path.join(root, 'adir');
  await fsp.mkdir(dir);
  const s = makeSessions(root);

  await assert.rejects(() => s.begin(dir), /cannot upload over a directory/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('a failed end removes the .part file instead of orphaning it', async () => {
  const root = await mkroot();
  const s = createUploadSessions({
    fs: createAllowlistedFs({ roots: [root] }),
    idleMs: 60_000,
    rename: async () => {
      throw Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' });
    },
  });
  const target = path.join(root, 'a.bin');
  const { uploadId } = await s.begin(target);
  const partPath = s.partPathForTest(uploadId) as string;
  await s.chunk(uploadId, 0, Buffer.from('data').toString('base64'));

  await assert.rejects(() => s.end(uploadId), /EISDIR/);

  assert.equal(s.size(), 0);
  assert.equal(await fsp.stat(partPath).then(() => true, () => false), false, 'no .part left behind');
  await fsp.rm(root, { recursive: true, force: true });
});

test('createUploadSessions rejects a non-positive or non-finite idleMs', async () => {
  const root = await mkroot();
  const fsApi = createAllowlistedFs({ roots: [root] });

  assert.throws(() => createUploadSessions({ fs: fsApi, idleMs: 0 }), /positive finite/);
  assert.throws(() => createUploadSessions({ fs: fsApi, idleMs: Number.POSITIVE_INFINITY }), /positive finite/);
  await fsp.rm(root, { recursive: true, force: true });
});
