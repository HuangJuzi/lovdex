import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/index.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';

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
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-sync-lovdex-'));
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

async function createOpencodeDb(tempRoot: string, schema: string, rows: string): Promise<void> {
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(schema);
  db.exec(rows);
  db.close();
}

test('opencode synchronizer upserts sessions from opencode.db', async () => {
  await withIsolatedLovdexDb(async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    await createOpencodeDb(
      tempRoot,
      `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, path TEXT, time_archived INTEGER, time_created INTEGER, time_updated INTEGER);`,
      `INSERT INTO session (id, title, directory, path, time_archived, time_created, time_updated) VALUES
        ('ses_active', 'My OpenCode Chat', '/tmp', '', NULL, 1720000000000, 1720000000000),
        ('ses_archived', 'Archived', '/tmp', '', 1720000000000, 1720000000000, 1720000000000);`,
    );

    const restore = patchHomeDir(tempRoot);
    try {
      const synchronizer = new OpenCodeSessionSynchronizer();
      const count = await synchronizer.synchronize();
      // Only the non-archived row is scanned.
      assert.equal(count, 1);
    } finally {
      restore();
    }
  });
});

test('opencode synchronizer prefers the directory column over path (new opencode schema)', async () => {
  await withIsolatedLovdexDb(async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    // opencode v0.3.0 stores the real working directory in `directory`; `path`
    // is the git-relative subpath, which is empty at a repo root.
    await createOpencodeDb(
      tempRoot,
      `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, path TEXT, time_archived INTEGER, time_created INTEGER, time_updated INTEGER);`,
      `INSERT INTO session (id, title, directory, path, time_archived, time_created, time_updated) VALUES
        ('ses_1', 'Greeting', '/mnt/b/workdir/gitlab/moltbot', '', NULL, 1720000000000, 1720000000000),
        ('ses_2', 'Subdir', '/mnt/b/workdir/gitlab/backend', 'apps/api', NULL, 1720000000000, 1720000000000);`,
    );

    const restore = patchHomeDir(tempRoot);
    try {
      const synchronizer = new OpenCodeSessionSynchronizer();
      await synchronizer.synchronize();

      const row1 = sessionsDb.getSessionByProviderSessionId('ses_1');
      assert.ok(row1, 'ses_1 should be upserted');
      assert.equal(row1.project_path, '/mnt/b/workdir/gitlab/moltbot');

      // When path holds a real subpath it is still the fallback.
      const row2 = sessionsDb.getSessionByProviderSessionId('ses_2');
      assert.ok(row2, 'ses_2 should be upserted');
      assert.equal(row2.project_path, '/mnt/b/workdir/gitlab/backend');
    } finally {
      restore();
    }
  });
});

test('opencode synchronizer returns 0 when opencode.db is absent', async () => {
  await withIsolatedLovdexDb(async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-sync-'));
    const restore = patchHomeDir(tempRoot);
    try {
      const count = await new OpenCodeSessionSynchronizer().synchronize();
      assert.equal(count, 0);
    } finally {
      restore();
    }
  });
});
