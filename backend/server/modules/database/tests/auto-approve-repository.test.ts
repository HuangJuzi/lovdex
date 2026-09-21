import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-repo-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    getConnection().prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('createTask defaults auto_approve to 0 and honours an explicit true', async () => {
  await withIsolatedDatabase(() => {
    const plain = tasksDb.createTask({ projectPath: '/tmp/repo', title: 'plain', executorProvider: 'claude' });
    assert.equal(plain.auto_approve, 0, 'omitting the flag must keep the existing behaviour');

    const flagged = tasksDb.createTask({
      projectPath: '/tmp/repo',
      title: 'flagged',
      executorProvider: 'claude',
      autoApprove: true,
    });
    assert.equal(flagged.auto_approve, 1);
  });
});

test('updateTask toggles auto_approve and leaves other fields alone', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.createTask({ projectPath: '/tmp/repo', title: 'toggle', executorProvider: 'claude' });
    assert.equal(task.auto_approve, 0);

    const on = tasksDb.updateTask(task.task_id, { autoApprove: true });
    assert.equal(on?.auto_approve, 1);
    assert.equal(on?.title, 'toggle', 'unrelated fields must be untouched');

    const off = tasksDb.updateTask(task.task_id, { autoApprove: false });
    assert.equal(off?.auto_approve, 0);
  });
});

test('updateTask with no autoApprove key does not clear an existing flag', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.createTask({
      projectPath: '/tmp/repo',
      title: 'keep',
      executorProvider: 'claude',
      autoApprove: true,
    });
    // 这是「部分更新」的回归点：undefined 必须被忽略，不能被当成 false 写回。
    const updated = tasksDb.updateTask(task.task_id, { title: 'renamed' });
    assert.equal(updated?.title, 'renamed');
    assert.equal(updated?.auto_approve, 1, 'an unrelated update must not silently turn auto-approval off');
  });
});
