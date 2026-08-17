import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';

async function withIsolatedDb(fn: (home: string) => Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dbDir = await mkdtemp(path.join(tmpdir(), 'codex-sync-db-'));
  const homeDir = await mkdtemp(path.join(tmpdir(), 'codex-home-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
  closeConnection();
  await initializeDatabase();
  try {
    await fn(homeDir);
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
    await rm(dbDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('codex sync puts thread_name into custom_name and first user message into summary', async () => {
  await withIsolatedDb(async (home) => {
    const sessionsDir = path.join(home, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, 'sess-1.jsonl');
    // Header line carries the session id + cwd; extractFirstValidJsonlData
    // parses it. extractFirstUserMessageFromStart reads event_msg/user_message
    // payload.message.
    const header = JSON.stringify({ type: 'session_meta', payload: { id: 'sess-1', cwd: '/proj' } });
    const userMsg = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Hello world' } });
    await writeFile(file, [header, userMsg].join('\n') + '\n', 'utf8');
    await writeFile(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: 'sess-1', thread_name: 'My Rename' }) + '\n', 'utf8');

    // Mark the session as app-created (session_id !== provider_session_id) so
    // the synchronizer routes the first user message into summary.
    sessionsDb.createAppSession('app-1', 'codex', '/proj');
    sessionsDb.assignProviderSessionId('app-1', 'sess-1');

    const sync = new CodexSessionSynchronizer(home);
    await sync.synchronizeFile(file);

    const row = sessionsDb.getSessionByProviderSessionId('sess-1');
    assert.equal(row?.custom_name, 'My Rename');
    // summary comes from the first user message (not custom_name).
    assert.equal(row?.summary, 'Hello world');
  });
});

test('codex sync falls back to last agent message for summary when no user message', async () => {
  await withIsolatedDb(async (home) => {
    const sessionsDir = path.join(home, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, 'sess-2.jsonl');
    const header = JSON.stringify({ type: 'session_meta', payload: { id: 'sess-2', cwd: '/proj' } });
    const taskComplete = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done building' } });
    await writeFile(file, [header, taskComplete].join('\n') + '\n', 'utf8');

    const sync = new CodexSessionSynchronizer(home);
    await sync.synchronizeFile(file);

    const row = sessionsDb.getSessionByProviderSessionId('sess-2');
    // No thread_name and not app-created -> custom_name stays null, summary
    // is the last agent message.
    assert.equal(row?.custom_name, null);
    assert.equal(row?.summary, 'Done building');
  });
});
