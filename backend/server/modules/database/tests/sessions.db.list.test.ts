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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-list-'));
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

test('listSessions filters by projectPath and defaults to active (non-archived) rows', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('s-a', 'claude', '/workspace/proj-a', 'A');
    sessionsDb.createSession('s-b', 'claude', '/workspace/proj-b', 'B');

    const onlyA = sessionsDb.listSessions({ projectPath: '/workspace/proj-a' });
    assert.deepEqual(onlyA.map((s) => s.session_id), ['s-a']);

    const all = sessionsDb.listSessions({});
    assert.deepEqual(all.map((s) => s.session_id).sort(), ['s-a', 's-b']);
  });
});

test('listSessions includeDeleted surfaces archived rows that are hidden by default', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('s-active', 'claude', '/workspace/proj', 'Active');
    sessionsDb.createSession('s-archived', 'claude', '/workspace/proj', 'Archived');
    sessionsDb.updateSessionIsArchived('s-archived', true);

    assert.deepEqual(
      sessionsDb.listSessions({}).map((s) => s.session_id),
      ['s-active'],
    );
    assert.deepEqual(
      sessionsDb.listSessions({ includeDeleted: true }).map((s) => s.session_id).sort(),
      ['s-active', 's-archived'],
    );
  });
});

test('listSessions filters by lastActive range and orders by lastActiveAt', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('s-old', 'claude', '/workspace/proj', 'Old', undefined, '2026-01-01T00:00:00Z');
    sessionsDb.createSession('s-mid', 'claude', '/workspace/proj', 'Mid', undefined, '2026-06-01T00:00:00Z');
    sessionsDb.createSession('s-new', 'claude', '/workspace/proj', 'New', undefined, '2026-12-01T00:00:00Z');

    const before = sessionsDb.listSessions({ lastActiveBefore: '2026-07-01T00:00:00Z' });
    assert.deepEqual(before.map((s) => s.session_id), ['s-mid', 's-old']);

    const after = sessionsDb.listSessions({ lastActiveAfter: '2026-07-01T00:00:00Z' });
    assert.deepEqual(after.map((s) => s.session_id), ['s-new']);

    const ascending = sessionsDb.listSessions({ orderBy: 'asc' });
    assert.deepEqual(ascending.map((s) => s.session_id), ['s-old', 's-mid', 's-new']);
  });
});

test('listSessions is read-only: filtering never mutates rows', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('s-keep', 'claude', '/workspace/proj', 'Keep');

    const before = sessionsDb.getSessionById('s-keep');
    sessionsDb.listSessions({ projectPath: '/workspace/proj' });
    sessionsDb.listSessions({ lastActiveBefore: '2026-07-01T00:00:00Z' });
    sessionsDb.listSessions({ includeDeleted: true });
    const after = sessionsDb.getSessionById('s-keep');

    assert.equal(before?.isArchived, after?.isArchived);
    assert.equal(before?.updated_at, after?.updated_at);
    assert.equal(before?.custom_name, after?.custom_name);
  });
});
