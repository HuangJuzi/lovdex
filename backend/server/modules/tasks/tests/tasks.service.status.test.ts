import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { createTasksService, type TaskBroadcast } from '../services/tasks.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-status-'));
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

function makeService(events: unknown[] = []) {
  const broadcast: TaskBroadcast = (e) => { events.push(e); };
  return createTasksService(tasksDb, { broadcast });
}

function seedTask() {
  projectsDb.createProjectPath('/tmp/example-repo');
  const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude' });
  tasksDb.linkSession(created.task_id, 's1');
  return created.task_id;
}

test('createTask defaults to todo', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude' });
    assert.equal(created.status, 'todo');
  });
});

test('failed session persists sub_status=failed, status stays in_progress', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed');
    const row = svc.getTask(id);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.sub_status, 'failed');
    assert.equal(tasksDb.getTask(id)?.sub_status, 'failed');
  });
});

test('running clears a persisted failed sub_status', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed');
    svc.onSessionStatus('s1', 'running');
    assert.equal(svc.getTask(id)?.sub_status, 'running');
    assert.equal(tasksDb.getTask(id)?.sub_status, null);
  });
});

test('writeSummary folds verdict into sub_status and moves non-done back to in_progress', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.writeSummary(id, { summary: 'blocked', verdict: 'blocked', reason: 'broke' });
    let row = svc.getTask(id);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.sub_status, 'blocked');
    assert.equal(row?.verdict_reason, 'broke');
    assert.equal(row?.ai_summary, 'blocked');

    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.writeSummary(id, { summary: 'done', verdict: 'done', reason: 'ok' });
    row = svc.getTask(id);
    assert.equal(row?.status, 'in_review');
    assert.equal(row?.sub_status, 'done');
  });
});

test('writeSummary does not move a task the user already dragged out of in_review', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.applyStatusChange(id, 'todo', 'user');
    svc.writeSummary(id, { summary: 'late', verdict: 'blocked' });
    // status stays where the user put it (not moved by the late verdict)
    assert.equal(svc.getTask(id)?.status, 'todo');
    // the verdict is still recorded as audit on the row
    assert.equal(tasksDb.getTask(id)?.sub_status, 'blocked');
    assert.equal(tasksDb.getTask(id)?.verdict_reason, null);
  });
});

test('reconcileFailedTasks marks orphaned in_progress tasks failed', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    const changed = svc.reconcileFailedTasks(() => new Set());
    assert.equal(changed, 1);
    assert.equal(tasksDb.getTask(id)?.sub_status, 'failed');
  });
});

test('reconcileFailedTasks broadcasts the refreshed sub_status, not the stale row', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const events: unknown[] = [];
    const svc = makeService(events);
    svc.onSessionStatus('s1', 'running');
    svc.reconcileFailedTasks(() => new Set());
    const matching = events.filter(
      (e) => (e as { kind: string; task?: { task_id?: string } }).kind === 'task_upserted'
        && (e as { task?: { task_id?: string } }).task?.task_id === id,
    );
    // The reconcile emit is the last one (after the earlier running-transition emit).
    const event = matching[matching.length - 1] as { task: { sub_status?: string } };
    assert.ok(event, 'expected a task_upserted broadcast for the reconciled task');
    assert.equal(event.task.sub_status, 'failed');
  });
});

test('manual applyStatusChange to done clears a persisted sub_status tag', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.writeSummary(id, { summary: 'blocked', verdict: 'blocked', reason: 'broke' });
    // blocked moved it back to in_progress with sub_status='blocked'
    assert.equal(svc.getTask(id)?.sub_status, 'blocked');
    // user marks it done
    svc.applyStatusChange(id, 'done', 'user');
    assert.equal(svc.getTask(id)?.status, 'done');
    assert.equal(svc.getTask(id)?.sub_status, null);
    assert.equal(tasksDb.getTask(id)?.sub_status, null); // persisted clear
  });
});

test('moveTask to a different column clears sub_status', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed'); // sub_status='failed'
    svc.moveTask(id, 'todo', null, null);
    assert.equal(svc.getTask(id)?.status, 'todo');
    assert.equal(svc.getTask(id)?.sub_status, null);
    assert.equal(tasksDb.getTask(id)?.sub_status, null);
  });
});

test('applyStatusChange to the same status does not clear sub_status', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed'); // sub_status='failed', status stays in_progress
    svc.applyStatusChange(id, 'in_progress', 'user'); // same status
    assert.equal(svc.getTask(id)?.sub_status, 'failed');
  });
});

test('reopened done task goes back to in_progress and still triggers the auto-verdict on completion', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const completedCalls: Array<[string, string]> = [];
    const svc = createTasksService(tasksDb, {
      broadcast: () => {},
      onTaskCompleted: (tid, title) => { completedCalls.push([tid, title]); },
    });
    // 正常跑到 done（第一次完成触发 onTaskCompleted）
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    assert.equal(completedCalls.length, 1);
    svc.writeSummary(id, { summary: 'done', verdict: 'done', reason: 'ok' });
    svc.applyStatusChange(id, 'done', 'user');
    assert.equal(svc.getTask(id)?.status, 'done');
    // 用户在已完成任务的会话里继续做其他事 → 回到进行中
    svc.onSessionStatus('s1', 'running');
    assert.equal(svc.getTask(id)?.status, 'in_progress');
    // 完成时【必须】再次触发自动 verdict
    svc.onSessionStatus('s1', 'completed');
    assert.equal(completedCalls.length, 2);
    const row = svc.getTask(id);
    assert.equal(row?.status, 'in_review');
  });
});

test('resume (running) clears a stale premature verdict so it cannot taint the next run', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    // A verdict lands (e.g. a premature one from an earlier pause, or a legit
    // one the user is about to override by resuming).
    svc.writeSummary(id, { summary: 'stale', verdict: 'only_plan', reason: 'old' });
    assert.equal(tasksDb.getTask(id)?.ai_summary, 'stale');
    assert.ok(tasksDb.getTask(id)?.verdict_at);
    // The task resumes: the fresh run must drop the old verdict audit so the
    // next verdict judge does not cite it as prior context, and the board stops
    // showing the stale tag.
    svc.onSessionStatus('s1', 'running');
    const row = tasksDb.getTask(id);
    assert.equal(row?.sub_status, null);
    assert.equal(row?.ai_summary, null);
    assert.equal(row?.verdict_reason, null);
    assert.equal(row?.verdict_at, null);
  });
});

test('writeSummary on an in_progress (actively running) task is skipped — no stale label on a running task', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running'); // in_progress, actively running
    // A verdict that lands while the task is still in_progress is stale (the
    // task resumed or never settled to in_review). It must NOT label a running
    // task failed/only_plan — that is the "执行中 + 执行失败" contradiction.
    svc.writeSummary(id, { summary: 'late', verdict: 'failed', reason: 'stale' });
    const row = tasksDb.getTask(id);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.sub_status, null, 'sub_status must not be written');
    assert.equal(row?.ai_summary, null, 'ai_summary must not be written');
    assert.equal(row?.verdict_at, null, 'verdict_at must not be written');
  });
});

test('late verdict does not downgrade a task the user already marked done', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.applyStatusChange(id, 'done', 'user'); // 用户先标记完成，verdict 还没落
    svc.writeSummary(id, { summary: 'blocked', verdict: 'blocked', reason: 'broke' });
    const row = svc.getTask(id);
    assert.equal(row?.status, 'done');
    assert.notEqual(row?.sub_status, 'blocked');
  });
});
