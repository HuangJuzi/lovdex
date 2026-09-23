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

test('createTask defaults permission_mode to default and honours the autoApprove mode', async () => {
  await withIsolatedDatabase(() => {
    const plain = tasksDb.createTask({ projectPath: '/tmp/repo', title: 'plain', executorProvider: 'claude' });
    assert.equal(plain.permission_mode, 'default', 'omitting the mode must keep the existing behaviour');

    const flagged = tasksDb.createTask({
      projectPath: '/tmp/repo',
      title: 'flagged',
      executorProvider: 'claude',
      permissionMode: 'autoApprove',
    });
    assert.equal(flagged.permission_mode, 'autoApprove');
  });
});

test('updateTask sets permission_mode and leaves other fields alone', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.createTask({ projectPath: '/tmp/repo', title: 'toggle', executorProvider: 'claude' });
    assert.equal(task.permission_mode, 'default');

    const on = tasksDb.updateTask(task.task_id, { permissionMode: 'autoApprove' });
    assert.equal(on?.permission_mode, 'autoApprove');
    assert.equal(on?.title, 'toggle', 'unrelated fields must be untouched');

    const off = tasksDb.updateTask(task.task_id, { permissionMode: 'default' });
    assert.equal(off?.permission_mode, 'default');
  });
});

test('updateTask with no permissionMode key does not clear an existing mode', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.createTask({
      projectPath: '/tmp/repo',
      title: 'keep',
      executorProvider: 'claude',
      permissionMode: 'autoApprove',
    });
    // 这是「部分更新」的回归点：undefined 必须被忽略，不能被当成 'default' 写回。
    const updated = tasksDb.updateTask(task.task_id, { title: 'renamed' });
    assert.equal(updated?.title, 'renamed');
    assert.equal(updated?.permission_mode, 'autoApprove', 'an unrelated update must not silently turn auto-approval off');
  });
});
