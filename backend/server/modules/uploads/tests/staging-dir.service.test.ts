import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createUploadStagingDir,
  moveStagedFileIntoPlace,
  removeUploadStagingDir,
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
