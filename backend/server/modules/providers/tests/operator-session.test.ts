import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { randomUUID } from 'node:crypto';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'operator-session-'));
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

test('createAppSession with isOperator=true sets is_operator=1', async () => {
  await withIsolatedDatabase(() => {
    const sid = randomUUID();
    sessionsDb.createAppSession(sid, 'claude', '/op-proj', true);
    const row = sessionsDb.getSessionById(sid);
    assert.equal(row?.is_operator, 1);
  });
});

test('createAppSession without isOperator defaults is_operator=0', async () => {
  await withIsolatedDatabase(() => {
    const sid = randomUUID();
    sessionsDb.createAppSession(sid, 'claude', '/op-proj');
    const row = sessionsDb.getSessionById(sid);
    assert.equal(row?.is_operator, 0);
  });
});

test('getOperatorSessions returns only operator sessions, not archived', async () => {
  await withIsolatedDatabase(() => {
    const opSid = randomUUID();
    const plainSid = randomUUID();
    sessionsDb.createAppSession(opSid, 'claude', '/op-proj', true);
    sessionsDb.createAppSession(plainSid, 'claude', '/op-proj', false);

    const operatorRows = sessionsDb.getOperatorSessions();
    const ids = operatorRows.map((r) => r.session_id);
    assert.ok(ids.includes(opSid), 'operator session should be listed');
    assert.ok(!ids.includes(plainSid), 'plain session should not be listed');
    for (const r of operatorRows) {
      assert.equal(r.is_operator, 1);
    }
  });
});
