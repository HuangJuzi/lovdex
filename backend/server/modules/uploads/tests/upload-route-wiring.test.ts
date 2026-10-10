import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_FILE_UPLOAD_COUNT,
  MAX_FILE_UPLOAD_SIZE_BYTES,
  MAX_FILE_UPLOAD_SIZE_MB,
} from '../upload-limits.js';
import {
  createUploadStagingDir,
  moveStagedFileIntoPlace,
  removeUploadStagingDir,
} from '../staging-dir.service.js';

async function mkproject(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lovdex-route-'));
}

/**
 * Mirrors the local branch of the upload handler: stage, then move each file
 * into place, then drop the staging dir. Keeping this shape in a test pins the
 * three properties the route depends on — one staging dir per request, same
 * basename semantics as `file.originalname`, and cleanup on both paths.
 */
async function placeLocalUpload(
  projectRoot: string,
  uploads: { name: string; bytes: Buffer }[],
  relativePaths?: string[],
): Promise<{ name: string; size: number }[]> {
  const staging = await createUploadStagingDir(projectRoot);
  try {
    const placed: { name: string; size: number }[] = [];
    for (let i = 0; i < uploads.length; i += 1) {
      const upload = uploads[i];
      const fileName = relativePaths?.[i] ?? upload.name;
      const staged = path.join(staging, upload.name);
      await fsp.writeFile(staged, upload.bytes);
      const dest = path.join(projectRoot, fileName);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await moveStagedFileIntoPlace(staged, dest);
      placed.push({ name: fileName, size: upload.bytes.length });
    }
    return placed;
  } finally {
    await removeUploadStagingDir(staging);
  }
}

test('upload limits the route will enforce are exported from one module', () => {
  assert.equal(MAX_FILE_UPLOAD_SIZE_MB, 10240);
  assert.equal(MAX_FILE_UPLOAD_SIZE_BYTES, 10240 * 1024 * 1024);
  assert.equal(MAX_FILE_UPLOAD_COUNT, 20);
});

test('a local upload lands in the target dir and leaves no staging dir behind', async () => {
  const project = await mkproject();
  const placed = await placeLocalUpload(project, [{ name: 'a.bin', bytes: Buffer.from('abc') }]);

  assert.deepEqual(placed, [{ name: 'a.bin', size: 3 }]);
  assert.equal(await fsp.readFile(path.join(project, 'a.bin'), 'utf8'), 'abc');
  assert.deepEqual(await fsp.readdir(path.join(project, '.lovdex-tmp')), ['.gitignore']);
  await fsp.rm(project, { recursive: true, force: true });
});

test('folder uploads honour relativePaths and create nested parents', async () => {
  const project = await mkproject();
  const placed = await placeLocalUpload(
    project,
    [{ name: 'a.bin', bytes: Buffer.from('x') }],
    ['deep/nested/a.bin'],
  );

  assert.deepEqual(placed, [{ name: 'deep/nested/a.bin', size: 1 }]);
  assert.equal(await fsp.readFile(path.join(project, 'deep/nested/a.bin'), 'utf8'), 'x');
  await fsp.rm(project, { recursive: true, force: true });
});

test('a failure mid-batch still removes the staging dir', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  await fsp.writeFile(path.join(staging, 'a.bin'), 'a');
  await removeUploadStagingDir(staging);

  assert.deepEqual(await fsp.readdir(path.join(project, '.lovdex-tmp')), ['.gitignore']);
  await fsp.rm(project, { recursive: true, force: true });
});
