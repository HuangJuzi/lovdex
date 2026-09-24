import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { scheduledTasksDb } from '@/modules/database/repositories/scheduled-tasks.db.js';

/**
 * is_operator 是 project_path 的派生列：建行时由 `input.projectPath ? 0 : 1`
 * 算出来（scheduled-tasks.db.ts 的 createScheduledTask）。更新路径走的是显式
 * keyMap（scheduler.service.ts 的 update），**不重算**这一列 —— 于是把一条普通
 * 项目的定时任务改成「🤖 Lovdex助手」时，project_path 落成 NULL 而 is_operator
 * 仍是 0。这个组合会被派发路径拒掉（isOperator=false + projectPath=null →
 * PROJECT_NOT_FOUND），而错误又被 scheduler 的 tick catch 吞掉、next_run_at 不
 * 推进，表现成每 15 秒重试一次的静默失败。
 *
 * 本测试钉的是**数据库层的不变式**，不是修法：无论最终是「更新时重算」还是
 * 「调用方补传」，这条不变式都必须成立。
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-operator-'));
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

const baseInput = {
  title: 't',
  description: 'd',
  executorProvider: 'claude' as const,
  executorModel: null,
  priority: 'P2' as const,
  label: 'other' as const,
  autoRun: true,
  permissionMode: 'default',
  scheduleType: 'interval' as const,
  intervalSeconds: 3600,
  nextRunAt: '2026-09-25T00:00:00.000Z',
};

test('createScheduledTask derives is_operator from project_path', async () => {
  await withIsolatedDatabase(() => {
    const withProject = scheduledTasksDb.createScheduledTask({ ...baseInput, projectPath: '/p/app' });
    assert.equal(withProject.project_path, '/p/app');
    assert.equal(withProject.is_operator, 0);

    const assistant = scheduledTasksDb.createScheduledTask({ ...baseInput, projectPath: null });
    assert.equal(assistant.project_path, null);
    assert.equal(assistant.is_operator, 1);
  });
});

test('switching a scheduled task to the assistant target keeps is_operator consistent', async () => {
  await withIsolatedDatabase(() => {
    // 起点：普通项目的定时任务。这正是用户库里那两条的形状。
    const created = scheduledTasksDb.createScheduledTask({ ...baseInput, projectPath: '/p/app' });
    assert.equal(created.is_operator, 0);

    // 用户在详情面板里把「项目」切成「🤖 Lovdex助手」并保存 —— 前端 toApiBody
    // 发出的就是 projectPath: null。is_operator 必须跟着变成 1。
    const updated = scheduledTasksDb.updateScheduledTask(created.schedule_id, { project_path: null });
    assert.equal(updated?.project_path, null);
    assert.equal(
      updated?.is_operator,
      1,
      'a NULL project_path must imply is_operator=1, otherwise dispatch 400s and the schedule silently retries every 15s',
    );
  });
});

test('switching a scheduled task back to a real project keeps is_operator consistent', async () => {
  await withIsolatedDatabase(() => {
    const created = scheduledTasksDb.createScheduledTask({ ...baseInput, projectPath: null });
    assert.equal(created.is_operator, 1);

    const updated = scheduledTasksDb.updateScheduledTask(created.schedule_id, { project_path: '/p/app' });
    assert.equal(updated?.project_path, '/p/app');
    assert.equal(
      updated?.is_operator,
      0,
      'a non-NULL project_path must imply is_operator=0, otherwise the run lands in the operator workspace instead of the project',
    );
  });
});
