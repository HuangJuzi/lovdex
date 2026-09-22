/**
 * 删定时任务级联的整链路验证：真 sqlite + 真 tasksService + 真 scheduler service。
 *
 * 单测里 db 是替身（listTasks 自己实现过滤），这里走一遍真实接线，确认「删掉模板
 * → 它跑出来的任务真的从库里消失、别的调度与手工任务一条不动」。SQL 过滤写错列名、
 * 白名单漏参数、级联循环漏掉某一行，都只有真库 + 真服务才照得出来。
 *
 * 会话的硬删（deleteSessionHard）在这里是替身 —— 它属于 deleteTask 的既有行为，
 * 本次没有改动，单测已覆盖「按 session_id 调用它」；这里只断言它拿到了正确的会话。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { scheduledTasksDb } from '@/modules/database/repositories/scheduled-tasks.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { createSchedulerService } from '@/modules/scheduler/services/scheduler.service.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sched-cascade-'));
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

function makeScheduler(tasksService: ReturnType<typeof createTasksService>, deletedSessions: string[]) {
  return createSchedulerService({
    scheduledTasksDb: { ...scheduledTasksDb, operatorWorkspacePath: '/op-ws' },
    tasksService,
    createSession: () => 'unused',
    startTaskRun: () => true,
    broadcast: () => {},
    isSessionRunning: () => false,
    generateTitle: async () => null,
    titleBlockingMs: 10,
  });
}

test('删调度会把它跑出来的任务从库里清掉，且不碰别的调度与手工任务', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/p');
    const db = getConnection();
    const deletedSessions: string[] = [];
    const tasksService = createTasksService(tasksDb, {
      broadcast: () => {},
      deps: { deleteSessionHard: async (sid) => { deletedSessions.push(sid); } },
    });
    const scheduler = makeScheduler(tasksService, deletedSessions);

    const schedule = scheduledTasksDb.createScheduledTask({
      title: '同步付款审批并通知', scheduleType: 'interval', intervalSeconds: 1800, nextRunAt: '2026-09-22T00:00:00.000Z',
    });
    const other = scheduledTasksDb.createScheduledTask({
      title: '另一个调度', scheduleType: 'interval', intervalSeconds: 1800, nextRunAt: '2026-09-22T00:00:00.000Z',
    });

    // 三次运行：两条带会话（跑完的）、一条仅提醒（没会话）
    const run1 = tasksDb.createTask({ projectPath: '/p', title: 'run1', executorProvider: 'claude', sourceScheduleId: schedule.schedule_id, status: 'done' });
    tasksDb.linkSession(run1.task_id, 'sess-1');
    const run2 = tasksDb.createTask({ projectPath: '/p', title: 'run2', executorProvider: 'claude', sourceScheduleId: schedule.schedule_id, status: 'in_review' });
    tasksDb.linkSession(run2.task_id, 'sess-2');
    const remind = tasksDb.createTask({ projectPath: '/p', title: 'run3', executorProvider: 'claude', sourceScheduleId: schedule.schedule_id });
    // 干扰项：另一个调度的运行 + 一条手工任务
    const foreign = tasksDb.createTask({ projectPath: '/p', title: 'foreign', executorProvider: 'claude', sourceScheduleId: other.schedule_id, status: 'done' });
    const manual = tasksDb.createTask({ projectPath: '/p', title: 'manual', executorProvider: 'claude' });

    const result = await scheduler.remove(schedule.schedule_id);

    assert.deepEqual([...result.deletedTaskIds].sort(), [run1.task_id, remind.task_id, run2.task_id].sort());
    assert.deepEqual(deletedSessions.sort(), ['sess-1', 'sess-2']);
    // 直接查库：被级联的三条真的不在表里了（不是只从内存/事件里消失）
    const remaining = (db.prepare('SELECT task_id FROM tasks').all() as Array<{ task_id: string }>).map((r) => r.task_id).sort();
    assert.deepEqual(remaining, [foreign.task_id, manual.task_id].sort());
    // 模板行也没了，另一个调度还在
    assert.equal(scheduledTasksDb.getScheduledTask(schedule.schedule_id), null);
    assert.ok(scheduledTasksDb.getScheduledTask(other.schedule_id), '别的调度不许受影响');
  });
});

test('级联被拒时真库里一条都不许少（模板也还在）', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/p');
    const db = getConnection();
    // 「会话是否在跑」注入在 **tasksService** 上：级联的守卫读的是它自己的 deps，
    // 生产里 index.js 给调度器与 tasksService 传的是同一个 chatRunRegistry 判据。
    const tasksService = createTasksService(tasksDb, {
      broadcast: () => {},
      deps: { isSessionRunning: (sid) => sid === 'sess-live' },
    });
    const scheduler = createSchedulerService({
      scheduledTasksDb: { ...scheduledTasksDb, operatorWorkspacePath: '/op-ws' },
      tasksService,
      createSession: () => 'unused',
      startTaskRun: () => true,
      broadcast: () => {},
      isSessionRunning: (sid) => sid === 'sess-live',
      generateTitle: async () => null,
      titleBlockingMs: 10,
    });

    const schedule = scheduledTasksDb.createScheduledTask({
      title: '跑着的调度', scheduleType: 'interval', intervalSeconds: 1800, nextRunAt: '2026-09-22T00:00:00.000Z',
    });
    const settled = tasksDb.createTask({ projectPath: '/p', title: 'settled', executorProvider: 'claude', sourceScheduleId: schedule.schedule_id, status: 'done' });
    const live = tasksDb.createTask({ projectPath: '/p', title: 'live', executorProvider: 'claude', sourceScheduleId: schedule.schedule_id, status: 'done' });
    tasksDb.linkSession(live.task_id, 'sess-live');

    await assert.rejects(
      () => scheduler.remove(schedule.schedule_id),
      (e: { code?: string; statusCode?: number; details?: { taskId?: string } }) =>
        e.code === 'SESSION_RUNNING' && e.statusCode === 409 && e.details?.taskId === live.task_id,
    );

    const remaining = (db.prepare('SELECT task_id FROM tasks').all() as Array<{ task_id: string }>).map((r) => r.task_id).sort();
    assert.deepEqual(remaining, [live.task_id, settled.task_id].sort(), '被拒时一条都不许删');
    assert.ok(scheduledTasksDb.getScheduledTask(schedule.schedule_id), '被拒时模板必须还在，用户才能重试');
  });
});
