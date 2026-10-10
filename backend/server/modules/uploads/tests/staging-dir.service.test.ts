import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createUploadStagingDir,
  moveStagedFileIntoPlace,
  removeUploadStagingDir,
  resolveUploadStagingDir,
} from '../staging-dir.service.js';
import { MAX_FILE_UPLOAD_SIZE_MB, MAX_FILE_UPLOAD_SIZE_BYTES } from '../upload-limits.js';

async function mkproject(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lovdex-upload-'));
}

test('upload limits are 10GB and internally consistent', () => {
  assert.equal(MAX_FILE_UPLOAD_SIZE_MB, 10240);
  assert.equal(MAX_FILE_UPLOAD_SIZE_BYTES, 10240 * 1024 * 1024);
});

test('createUploadStagingDir lives under <project>/.lovdex-tmp and is unique per call', async () => {
  const project = await mkproject();
  const a = await createUploadStagingDir(project);
  const b = await createUploadStagingDir(project);

  assert.equal(path.dirname(a), path.join(project, '.lovdex-tmp'));
  assert.notEqual(a, b);
  assert.ok((await fsp.stat(a)).isDirectory());
  assert.ok((await fsp.stat(b)).isDirectory());
  // .lovdex-tmp carries a .gitignore so staged bytes never show up in git status.
  const ignore = await fsp.readFile(path.join(project, '.lovdex-tmp', '.gitignore'), 'utf8');
  assert.equal(ignore, '*\n!.gitignore\n');

  await removeUploadStagingDir(a);
  await removeUploadStagingDir(b);
  assert.equal(await fsp.stat(path.join(project, '.lovdex-tmp')).then(() => true, () => false), true);
  await fsp.rm(project, { recursive: true, force: true });
});

test('moveStagedFileIntoPlace renames within the same project', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  const staged = path.join(staging, 'a.bin');
  await fsp.writeFile(staged, 'payload');
  const target = path.join(project, 'sub', 'a.bin');
  await fsp.mkdir(path.dirname(target), { recursive: true });

  await moveStagedFileIntoPlace(staged, target);

  assert.equal(await fsp.readFile(target, 'utf8'), 'payload');
  assert.equal(await fsp.stat(staged).then(() => true, () => false), false);
  await removeUploadStagingDir(staging);
  await fsp.rm(project, { recursive: true, force: true });
});

test('moveStagedFileIntoPlace overwrites an existing target', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  const staged = path.join(staging, 'a.bin');
  await fsp.writeFile(staged, 'new');
  const target = path.join(project, 'a.bin');
  await fsp.writeFile(target, 'old');

  await moveStagedFileIntoPlace(staged, target);

  assert.equal(await fsp.readFile(target, 'utf8'), 'new');
  await removeUploadStagingDir(staging);
  await fsp.rm(project, { recursive: true, force: true });
});

test('moveStagedFileIntoPlace falls back to a copy across devices', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  const staged = path.join(staging, 'a.bin');
  await fsp.writeFile(staged, 'cross-device');
  const target = path.join(project, 'a.bin');

  // Simulate EXDEV (staging on another filesystem than the target).
  await moveStagedFileIntoPlace(staged, target, async () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  });

  assert.equal(await fsp.readFile(target, 'utf8'), 'cross-device');
  assert.equal(await fsp.stat(staged).then(() => true, () => false), false);
  await removeUploadStagingDir(staging);
  await fsp.rm(project, { recursive: true, force: true });
});

test('removeUploadStagingDir is idempotent and never removes the parent .lovdex-tmp', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  await removeUploadStagingDir(staging);
  await removeUploadStagingDir(staging); // second call must not throw
  assert.equal(await fsp.stat(path.join(project, '.lovdex-tmp')).then(() => true, () => false), true);
  await fsp.rm(project, { recursive: true, force: true });
});

test('a LOCAL project stages inside itself (so the final move is a rename)', async () => {
  const project = await mkproject();
  const staging = await resolveUploadStagingDir({ projectRoot: project, isRemote: false });

  assert.equal(path.dirname(staging), path.join(project, '.lovdex-tmp'));
  await removeUploadStagingDir(staging);
  await fsp.rm(project, { recursive: true, force: true });
});

test('a REMOTE project never stages under its (other-host) project path', async () => {
  // A remote project's path names a directory on ANOTHER machine. Staging under
  // it would either EACCES on that mkdir or silently create the directory on
  // the wrong host — so the staging dir must live in the local OS temp dir.
  //
  // The remote path is a fresh temp dir (not a hard-coded '/srv/...') so the
  // test proves nothing was created THERE without depending on the machine's
  // /srv being absent or unwritable.
  const remoteHostRoot = path.join(await mkproject(), 'app-on-the-other-host');
  const staging = await resolveUploadStagingDir({ projectRoot: remoteHostRoot, isRemote: true });

  try {
    // realpath both sides: os.tmpdir() may itself be a symlink (macOS /var).
    const tempReal = await fsp.realpath(os.tmpdir());
    const stagingReal = await fsp.realpath(staging);
    assert.equal(
      path.dirname(stagingReal),
      tempReal,
      `remote staging must be a child of the local temp dir, got ${staging}`,
    );
    assert.ok((await fsp.stat(stagingReal)).isDirectory());
    // And crucially: nothing was created on the main machine for that path.
    assert.equal(
      await fsp.stat(path.join(remoteHostRoot, '.lovdex-tmp')).then(() => true, () => false),
      false,
      'a remote project must not get a .lovdex-tmp on the MAIN machine',
    );
  } finally {
    await removeUploadStagingDir(staging);
  }
});
