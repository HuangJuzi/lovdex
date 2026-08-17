import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROJECT_TMP_DIR,
  buildStoredFileRecords,
  ensureProjectTempDir,
} from '@/modules/assets/services/file-assets.service.js';

async function withTempProject(t: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lovdex-files-test-'));
  try {
    await t(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('ensureProjectTempDir creates <project>/.lovdex-tmp with an ignore file', async () => {
  await withTempProject(async (dir) => {
    const tmpDir = await ensureProjectTempDir(dir);
    assert.equal(tmpDir, path.join(dir, PROJECT_TMP_DIR));
    assert.equal((await fs.stat(tmpDir)).isDirectory(), true);
    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\*$/m); // 含/`*/`
    assert.match(gitignore, /^!.gitignore$/m); // 且 !.gitignore
  });
});

test('ensureProjectTempDir is idempotent', async () => {
  await withTempProject(async (dir) => {
    await ensureProjectTempDir(dir);
    await ensureProjectTempDir(dir); // 不抛错
    assert.equal((await fs.stat(path.join(dir, PROJECT_TMP_DIR))).isDirectory(), true);
  });
});

test('buildStoredFileRecords maps multer files to absolute posix paths', async () => {
  await withTempProject(async (dir) => {
    const records = buildStoredFileRecords(dir, [
      { originalname: 'app.log', filename: '123-foo.log', size: 42, mimetype: 'text/plain' },
      { originalname: 'cfg.yaml', filename: '456-bar.yaml', size: 7, mimetype: 'application/x-yaml' },
    ]);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      name: 'app.log',
      path: path.join(dir, PROJECT_TMP_DIR, '123-foo.log').split(path.sep).join('/'),
      size: 42,
      mimeType: 'text/plain',
    });
    assert.equal(records[1].name, 'cfg.yaml');
    assert.equal(records[1].path, path.join(dir, PROJECT_TMP_DIR, '456-bar.yaml').split(path.sep).join('/'));
  });
});
