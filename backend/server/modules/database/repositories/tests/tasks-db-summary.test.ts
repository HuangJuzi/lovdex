import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-db-summary-'));
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

test('writeSummary folds verdict into sub_status and sets verdict_at', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const created = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' });
    const updated = tasksDb.writeSummary(created.task_id, {
      summary: '做了X，没做Y',
      verdict: 'only_plan',
      reason: '只生成了 plan 文件',
    });
    assert.equal(updated?.sub_status, 'only_plan');
    assert.equal(updated?.ai_summary, '做了X，没做Y');
    assert.equal(updated?.verdict_reason, '只生成了 plan 文件');
    assert.ok(updated?.verdict_at);
  });
});

test('writeSummary rejects invalid verdict', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const created = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' });
    assert.throws(() => tasksDb.writeSummary(created.task_id, { summary: 's', verdict: 'bogus' as never }));
  });
});

test('writeSummary persists null reason when omitted', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const created = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' });
    const updated = tasksDb.writeSummary(created.task_id, {
      summary: '完成了',
      verdict: 'done',
    });
    assert.equal(updated?.sub_status, 'done');
    assert.equal(updated?.ai_summary, '完成了');
    assert.equal(updated?.verdict_reason, null);
    assert.ok(updated?.verdict_at);
  });
});
