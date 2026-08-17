import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-summary-'));
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

test('createSession stores custom_name and summary separately', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'sess-1', 'claude', '/proj', 'My Rename', undefined, undefined, undefined, 'Auto Title'
    );
    const row = sessionsDb.getSessionById('sess-1');
    assert.equal(row?.custom_name, 'My Rename');
    assert.equal(row?.summary, 'Auto Title');
  });
});

test('createSession preserves existing custom_name when only summary is re-derived', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('sess-2', 'claude', '/proj', 'User Name', undefined, undefined, undefined, 'Old Auto');
    sessionsDb.createSession('sess-2', 'claude', '/proj', undefined, undefined, undefined, undefined, 'New Auto');
    const row = sessionsDb.getSessionById('sess-2');
    assert.equal(row?.custom_name, 'User Name');
    assert.equal(row?.summary, 'New Auto');
  });
});

test('updateSessionSummary only updates the summary column', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('sess-3', 'claude', '/proj', 'User Name', undefined, undefined, undefined, 'Auto');
    sessionsDb.updateSessionSummary('sess-3', 'New Auto');
    const row = sessionsDb.getSessionById('sess-3');
    assert.equal(row?.custom_name, 'User Name');
    assert.equal(row?.summary, 'New Auto');
  });
});
