import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { buildSessionUpsertedEvent } from '@/modules/providers/services/sessions-watcher.service.js';

async function withIsolatedDatabase(runTest: (dir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'watcher-explicit-'));
  await mkdir(path.join(dir, 'explicit'), { recursive: true });
  await mkdir(path.join(dir, 'discovered'), { recursive: true });
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('buildSessionUpsertedEvent skips sessions whose project is not explicit', async () => {
  await withIsolatedDatabase(async (dir) => {
    const explicitPath = path.join(dir, 'explicit');
    const discoveredPath = path.join(dir, 'discovered');

    projectsDb.createProjectPath(explicitPath, null, true);
    sessionsDb.createSession('sess-explicit', 'claude', explicitPath);

    sessionsDb.createSession('sess-discovered', 'claude', discoveredPath);

    assert.ok((await buildSessionUpsertedEvent('sess-explicit')) !== null);
    assert.equal(await buildSessionUpsertedEvent('sess-discovered'), null);
  });
});
