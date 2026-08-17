import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { onProviderSessionAssigned } from '@/modules/websocket/services/chat-run-registry.service.js';

async function withIsolatedDb(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'assign-wb-'));
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  closeConnection();
  await initializeDatabase();
  try {
    await fn();
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test('onProviderSessionAssigned writes pending custom_name to disk after jsonl_path is ready', async () => {
  await withIsolatedDb(async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'assign-wb-files-'));
    const file = path.join(tmp, 's.jsonl');
    await writeFile(file, JSON.stringify({ sessionId: 'p1', cwd: '/p', type: 'user' }) + '\n', 'utf8');
    // 1) app session 改名（provider 未启动，无 jsonl_path）
    sessionsDb.createAppSession('app-1', 'claude', '/p');
    sessionsDb.updateSessionCustomName('app-1', 'Pending Name');
    // 2) provider 落地：assign + jsonl_path 就绪
    sessionsDb.assignProviderSessionId('app-1', 'p1');
    sessionsDb.createSession('p1', 'claude', '/p', undefined, undefined, undefined, file, undefined);
    // 3) 补写
    await onProviderSessionAssigned('app-1');
    const content = await readFile(file, 'utf8');
    assert.ok(content.includes('"customTitle":"Pending Name"'), content);
    await rm(tmp, { recursive: true, force: true });
  });
});

test('onProviderSessionAssigned is no-op when custom_name is empty', async () => {
  await withIsolatedDb(async () => {
    sessionsDb.createAppSession('app-2', 'claude', '/p');
    await onProviderSessionAssigned('app-2'); // should not throw
  });
});
