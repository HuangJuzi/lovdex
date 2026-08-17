import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

async function withIsolatedDb(fn: () => void | Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'operator-dedup-'));
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  closeConnection();
  await initializeDatabase();
  try {
    await fn();
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

const WORKSPACE = '/home/zhijuhuang/.lovdex/operator-workspace';

test('createAppSession dedups a duplicate operator POST within the window', async () => {
  await withIsolatedDb(() => {
    const first = sessionsService.createAppSession('claude', WORKSPACE, true);
    const second = sessionsService.createAppSession('claude', WORKSPACE, true);

    assert.equal(second.sessionId, first.sessionId, 'duplicate operator POST reuses the first session');
    const rows = sessionsDb.getOperatorSessions();
    assert.equal(rows.length, 1, 'only one operator session row exists');
  });
});

test('createAppSession dedup is scoped to the provider', async () => {
  await withIsolatedDb(() => {
    const claude = sessionsService.createAppSession('claude', WORKSPACE, true);
    const opencode = sessionsService.createAppSession('opencode', WORKSPACE, true);

    assert.notEqual(opencode.sessionId, claude.sessionId, 'a different provider is a distinct session');
    assert.equal(sessionsDb.getOperatorSessions().length, 2);
  });
});

test('createAppSession does not dedup once the operator session is in use', async () => {
  await withIsolatedDb(() => {
    const first = sessionsService.createAppSession('claude', WORKSPACE, true);
    sessionsDb.assignProviderSessionId(first.sessionId, 'provider-native-1');

    const second = sessionsService.createAppSession('claude', WORKSPACE, true);
    assert.notEqual(second.sessionId, first.sessionId, 'a used session is never reused');
  });
});

test('createAppSession does not dedup outside the window', async () => {
  await withIsolatedDb(() => {
    const first = sessionsService.createAppSession('claude', WORKSPACE, true);

    const backdated = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
    getConnection().prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE session_id = ?')
      .run(backdated, backdated, first.sessionId);

    const second = sessionsService.createAppSession('claude', WORKSPACE, true);
    assert.notEqual(second.sessionId, first.sessionId, 'a stale empty session is not reused');
  });
});

test('createAppSession does not dedup regular (non-operator) sessions', async () => {
  await withIsolatedDb(() => {
    const first = sessionsService.createAppSession('claude', WORKSPACE, false);
    const second = sessionsService.createAppSession('claude', WORKSPACE, false);

    assert.notEqual(second.sessionId, first.sessionId, 'regular project sessions are always fresh');
  });
});
