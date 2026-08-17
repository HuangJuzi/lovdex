import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/index.js';
import { QoderSessionSynchronizer } from '@/modules/providers/list/qoder/qoder-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

/**
 * Points the lovdex sessions DB at a throwaway file so synchronizer tests don't
 * write test rows into the user's real auth.db.
 */
async function withIsolatedLovdexDb(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-sync-lovdex-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

test('qoder synchronizer indexes only top-level session jsonl (skips agent-*)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-sync-'));
  const restoreHome = patchHomeDir(home);
  await withIsolatedLovdexDb(async () => {
    const projectsRoot = path.join(home, '.qoder', 'projects');
    const cwdDir = path.join(projectsRoot, '-mnt-app');
    await fs.mkdir(path.join(cwdDir, 'agent-sub'), { recursive: true });
    const sessionFile = path.join(cwdDir, 'abc-123.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({ cwd: '/mnt/app' }) + '\n' + JSON.stringify({ message: { role: 'user', content: 'hello' } }) + '\n');
    await fs.writeFile(path.join(cwdDir, 'agent-x.jsonl'), JSON.stringify({ type: 'text' }) + '\n');
    await fs.writeFile(path.join(cwdDir, 'agent-sub', 'nested.jsonl'), '{"type":"text"}\n');

    const sync = new QoderSessionSynchronizer();
    assert.equal(await sync.synchronizeFile(sessionFile), 'abc-123');
    assert.equal(await sync.synchronizeFile(path.join(cwdDir, 'agent-x.jsonl')), null);
    assert.equal(await sync.synchronizeFile(path.join(cwdDir, 'agent-sub', 'nested.jsonl')), null);
  });
  restoreHome();
});

test('qoder synchronizer records provider=qoder and decodes project path (cwd field wins)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-sync-'));
  const restoreHome = patchHomeDir(home);
  await withIsolatedLovdexDb(async () => {
    const projectsRoot = path.join(home, '.qoder', 'projects');

    // No `cwd` field in the transcript: the lossy directory decode is used.
    const decodedDir = path.join(projectsRoot, '-mnt-b-workdir-project');
    await fs.mkdir(decodedDir, { recursive: true });
    const decodedFile = path.join(decodedDir, 'xyz-789.jsonl');
    await fs.writeFile(decodedFile, JSON.stringify({ message: { role: 'user', content: 'hi' } }) + '\n');

    // With a `cwd` field, the exact recorded path wins over the decode.
    const cwdDir = path.join(projectsRoot, '-mnt-app');
    await fs.mkdir(cwdDir, { recursive: true });
    const cwdFile = path.join(cwdDir, 'xyz-790.jsonl');
    await fs.writeFile(cwdFile, JSON.stringify({ cwd: '/mnt/app' }) + '\n' + JSON.stringify({ message: { role: 'user', content: 'yo' } }) + '\n');

    const sync = new QoderSessionSynchronizer();
    assert.equal(await sync.synchronizeFile(decodedFile), 'xyz-789');
    assert.equal(await sync.synchronizeFile(cwdFile), 'xyz-790');

    const decodedRow = sessionsDb.getSessionByProviderSessionId('xyz-789');
    assert.ok(decodedRow, 'decoded session should be upserted');
    assert.equal(decodedRow.provider, 'qoder');
    assert.equal(decodedRow.project_path, '/mnt/b/workdir/project');

    const cwdRow = sessionsDb.getSessionByProviderSessionId('xyz-790');
    assert.ok(cwdRow, 'cwd session should be upserted');
    assert.equal(cwdRow.provider, 'qoder');
    assert.equal(cwdRow.project_path, '/mnt/app');
  });
  restoreHome();
});
