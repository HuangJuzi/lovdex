import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

async function withIsolatedDb(fn: (home: string) => Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dbDir = await mkdtemp(path.join(tmpdir(), 'claude-sync-db-'));
  const homeDir = await mkdtemp(path.join(tmpdir(), 'claude-home-'));
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

test('claude sync puts custom-title into custom_name and ai-title into summary', async () => {
  await withIsolatedDb(async (home) => {
    const projectsDir = path.join(home, 'projects', 'proj');
    await mkdir(projectsDir, { recursive: true });
    const file = path.join(projectsDir, 'sess-1.jsonl');
    const first = JSON.stringify({ sessionId: 'sess-1', cwd: '/proj', type: 'user', message: { role: 'user', content: 'hi' } });
    const ai = JSON.stringify({ type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Auto Title' });
    const custom = JSON.stringify({ type: 'custom-title', sessionId: 'sess-1', customTitle: 'My Rename' });
    await writeFile(file, [first, ai, custom].join('\n') + '\n', 'utf8');
    await writeFile(path.join(home, 'history.jsonl'), '', 'utf8');

    const sync = new ClaudeSessionSynchronizer(home);
    await sync.synchronizeFile(file);

    const row = sessionsDb.getSessionByProviderSessionId('sess-1');
    assert.equal(row?.custom_name, 'My Rename');
    assert.equal(row?.summary, 'Auto Title');
  });
});
