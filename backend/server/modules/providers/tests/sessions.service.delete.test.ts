import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sess-del-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('force-deleting a session clears the linked task session_id (no dangling reference)', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/p');
    sessionsDb.createAppSession('sess-1', 'claude', '/p');
    const task = tasksDb.createTask({ projectPath: '/p', title: 'linked', executorProvider: 'claude', sessionId: 'sess-1' });

    const result = await sessionsService.deleteOrArchiveSessionById('sess-1', { force: true, deletedFromDisk: false });

    assert.equal(result.action, 'deleted');
    assert.equal(sessionsDb.getSessionById('sess-1'), null, 'session row must be gone');
    assert.equal(tasksDb.getTask(task.task_id)?.session_id, null, 'task.session_id must be cleared, not left dangling');
    assert.ok(tasksDb.getTask(task.task_id), 'the task row itself survives, just unlinked');
  });
});

test('force-deleting a free (unlinked) session still removes only the session row', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/p');
    sessionsDb.createAppSession('sess-free', 'claude', '/p');

    const result = await sessionsService.deleteOrArchiveSessionById('sess-free', { force: true, deletedFromDisk: false });

    assert.equal(result.action, 'deleted');
    assert.equal(sessionsDb.getSessionById('sess-free'), null);
  });
});
