import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { scheduledTasksDb } from '@/modules/database/repositories/scheduled-tasks.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sched-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('scheduledTasksDb CRUD + due query', async () => {
  await withIsolatedDatabase(() => {
    const created = scheduledTasksDb.createScheduledTask({
      title: '每日站会提醒',
      scheduleType: 'cron',
      cronExpr: '0 9 * * 1-5',
      nextRunAt: '2026-08-14T01:00:00.000Z',
      autoRun: 0,
    });
    assert.equal(created.schedule_type, 'cron');
    assert.equal(created.enabled, 1);
    assert.equal(created.is_operator, 1); // projectPath 缺省 → 助手工作区
    assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(scheduledTasksDb.getScheduledTask(created.schedule_id)?.title, '每日站会提醒');
    assert.equal(scheduledTasksDb.listScheduledTasks({}).length, 1);

    assert.equal(scheduledTasksDb.listDueScheduledTasks('2026-08-14T02:00:00.000Z').length, 1);
    assert.equal(scheduledTasksDb.listDueScheduledTasks('2026-08-13T00:00:00.000Z').length, 0);

    scheduledTasksDb.updateScheduledTask(created.schedule_id, { enabled: 0 });
    assert.equal(scheduledTasksDb.getScheduledTask(created.schedule_id)?.enabled, 0);
    assert.equal(scheduledTasksDb.listDueScheduledTasks('2026-08-14T02:00:00.000Z').length, 0);

    scheduledTasksDb.deleteScheduledTask(created.schedule_id);
    assert.equal(scheduledTasksDb.getScheduledTask(created.schedule_id), null);
  });
});
