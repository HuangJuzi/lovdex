import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

async function withIsolatedDb(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'rename-wb-'));
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

test('renameSessionById writes custom-title to disk for claude', async () => {
  await withIsolatedDb(async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'rename-wb-files-'));
    const file = path.join(tmp, 's.jsonl');
    await writeFile(file, JSON.stringify({ sessionId: 'p1', cwd: '/p', type: 'user' }) + '\n', 'utf8');
    // 建一个 provider session 行,带 jsonl_path
    sessionsDb.createSession('p1', 'claude', '/p', undefined, undefined, undefined, file, undefined);
    await sessionsService.renameSessionById('p1', 'New Name');
    const content = await readFile(file, 'utf8');
    assert.ok(content.includes('"customTitle":"New Name"'));
    const row = sessionsDb.getSessionById('p1');
    assert.equal(row?.custom_name, 'New Name');
    await rm(tmp, { recursive: true, force: true });
  });
});

test('renameSessionById does not throw when jsonl_path is null', async () => {
  await withIsolatedDb(async () => {
    sessionsDb.createSession('p2', 'claude', '/p', undefined, undefined, undefined, undefined, undefined);
    await sessionsService.renameSessionById('p2', 'New Name');
    const row = sessionsDb.getSessionById('p2');
    assert.equal(row?.custom_name, 'New Name');
  });
});
