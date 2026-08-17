import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'operator-columns-'));
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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('tasks table has operator verdict columns', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    // The legacy `verdict` column was folded into `sub_status` (T3/T4); the AI
    // verdict now lives there. The summary/reason/timestamp columns remain.
    for (const c of ['ai_summary', 'sub_status', 'verdict_reason', 'verdict_at']) {
      assert.ok(names.includes(c), `tasks missing ${c}`);
    }
    assert.ok(!names.includes('verdict'), 'legacy verdict column should be dropped');
  });
});

test('sessions table has is_operator', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    assert.ok(cols.map((c) => c.name).includes('is_operator'));
  });
});
