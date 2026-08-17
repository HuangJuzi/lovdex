import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { TASK_STATUSES } from '@/shared/task-status.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-db-'));
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

test('tasksDb CRUD + status validation + session link', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({
      projectPath: '/tmp/example-repo',
      title: '修登录页',
      description: '401 跳转',
      executorProvider: 'claude',
      executorModel: 'Sonnet 4.6',
    });
    assert.equal(created.status, 'todo');
    assert.equal(created.executor_provider, 'claude');
    // SQLite timestamps are normalized to ISO (with a T) so clients never
    // parse them as local time.
    assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(created.updated_at, /^\d{4}-\d{2}-\d{2}T/);

    const list = tasksDb.listTasks({});
    assert.equal(list.length, 1);

    tasksDb.updateTaskStatus(created.task_id, 'in_progress');
    assert.equal(tasksDb.getTask(created.task_id)?.status, 'in_progress');

    tasksDb.linkSession(created.task_id, 'session-abc');
    assert.equal(tasksDb.getTaskBySessionId('session-abc')?.task_id, created.task_id);

    tasksDb.deleteTask(created.task_id);
    assert.equal(tasksDb.getTask(created.task_id), null);
  });
});

test('tasksDb.listTasks filters by project and status', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/a');
    projectsDb.createProjectPath('/tmp/b');
    const t1 = tasksDb.createTask({ projectPath: '/tmp/a', title: 't1', executorProvider: 'claude' });
    const t2 = tasksDb.createTask({ projectPath: '/tmp/b', title: 't2', executorProvider: 'codex' });
    tasksDb.updateTaskStatus(t1.task_id, 'in_progress');
    tasksDb.updateTaskStatus(t2.task_id, 'todo');

    assert.equal(tasksDb.listTasks({ projectPath: '/tmp/a' }).length, 1);
    assert.equal(tasksDb.listTasks({ status: 'todo' }).length, 1);
    assert.equal(tasksDb.listTasks({ projectPath: '/tmp/b' }).length, 1);
  });
});

test('tasksDb.moveTask reorders within a column without collisions', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/m');
    const a = tasksDb.createTask({ projectPath: '/tmp/m', title: 'A', executorProvider: 'claude' });
    const b = tasksDb.createTask({ projectPath: '/tmp/m', title: 'B', executorProvider: 'claude' });
    const c = tasksDb.createTask({ projectPath: '/tmp/m', title: 'C', executorProvider: 'claude' });
    // positions now 1,2,3 in todo (distinct)

    // Move C to top (single anchor: before A)
    tasksDb.moveTask(c.task_id, 'todo', a.task_id, null);
    // Move B between C and A (both anchors → interpolation)
    tasksDb.moveTask(b.task_id, 'todo', c.task_id, a.task_id);

    // No two tasks share a position
    const positions = tasksDb.listTasks({}).map(t => t.position);
    assert.equal(new Set(positions).size, positions.length, `positions collided: ${positions.join(',')}`);

    // Canonical order: C, B, A
    const order = tasksDb.listTasks({}).map(t => t.title);
    assert.deepEqual(order, ['C', 'B', 'A']);
  });
});

test('tasksDb status transitions write started_at / completed_at', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/ts');
    const created = tasksDb.createTask({ projectPath: '/tmp/ts', title: 't', executorProvider: 'claude' });
    assert.equal(created.started_at, null);
    assert.equal(created.completed_at, null);

    tasksDb.updateTaskStatus(created.task_id, 'in_progress');
    const running = tasksDb.getTask(created.task_id)!;
    assert.ok(running.started_at, 'started_at set on in_progress');
    assert.equal(running.completed_at, null);

    tasksDb.updateTaskStatus(created.task_id, 'done');
    const done = tasksDb.getTask(created.task_id)!;
    assert.ok(done.completed_at, 'completed_at set on done');

    // Reopen: leaving done clears completed_at; entering in_progress refreshes started_at
    tasksDb.updateTaskStatus(created.task_id, 'in_progress');
    const reopened = tasksDb.getTask(created.task_id)!;
    assert.equal(reopened.completed_at, null, 'completed_at cleared when leaving done');
    assert.ok(reopened.started_at, 'started_at remains set on re-run');
  });
});

test('tasksDb.moveTask writes started_at / completed_at like updateTaskStatus', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/mv');
    const created = tasksDb.createTask({ projectPath: '/tmp/mv', title: 't', executorProvider: 'claude' });
    tasksDb.moveTask(created.task_id, 'in_progress', null, null);
    assert.ok(tasksDb.getTask(created.task_id)?.started_at, 'moveTask to in_progress sets started_at');
    tasksDb.moveTask(created.task_id, 'done', null, null);
    assert.ok(tasksDb.getTask(created.task_id)?.completed_at, 'moveTask to done sets completed_at');
  });
});

test('tasksDb.moveTask within the same column does not re-stamp timestamps', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/reorder');
    const created = tasksDb.createTask({ projectPath: '/tmp/reorder', title: 't', executorProvider: 'claude' });
    tasksDb.updateTaskStatus(created.task_id, 'done');
    const doneAt = tasksDb.getTask(created.task_id)!.completed_at;
    assert.ok(doneAt);
    // Reorder within the done column (same status). completed_at must not change.
    tasksDb.moveTask(created.task_id, 'done', null, null);
    assert.equal(tasksDb.getTask(created.task_id)?.completed_at, doneAt, 'completed_at unchanged on same-column reorder');
  });
});

test('tasksDb.createTask honors status + sessionId + lifecycle timestamps', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/conv');

    const running = tasksDb.createTask({
      projectPath: '/tmp/conv',
      title: 'running',
      executorProvider: 'claude',
      status: 'in_progress',
      sessionId: 'sess-running',
    });
    assert.equal(running.status, 'in_progress');
    assert.equal(running.session_id, 'sess-running');
    assert.ok(running.started_at, 'started_at set for in_progress');

    const done = tasksDb.createTask({
      projectPath: '/tmp/conv',
      title: 'done',
      executorProvider: 'codex',
      status: 'done',
      sessionId: 'sess-done',
    });
    assert.equal(done.status, 'done');
    assert.equal(done.session_id, 'sess-done');
    assert.ok(done.completed_at, 'completed_at set for done');

    const todo = tasksDb.createTask({ projectPath: '/tmp/conv', title: 'b', executorProvider: 'claude' });
    assert.equal(todo.status, 'todo');
    assert.equal(todo.session_id, null);
    assert.equal(todo.started_at, null);
    assert.equal(todo.completed_at, null);
  });
});

test('tasks status CHECK reflects the canonical status list', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string }).sql;
    for (const s of TASK_STATUSES) {
      assert.ok(sql.includes(`'${s}'`), `tasks CHECK missing ${s}`);
    }
  });
});

test('createTask persists new fields with defaults', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const base = { projectPath: '/p', title: 't', executorProvider: 'claude' as const };
    const row = tasksDb.createTask({ ...base });
    assert.equal(row.priority, 'P2');
    assert.equal(row.deadline, null);
    assert.equal(row.is_operator, 0);
    assert.equal(row.label, 'other');
    assert.equal(row.remark, null);

    const op = tasksDb.createTask({ ...base, title: 'op', priority: 'P0', deadline: '2026-12-31', isOperator: true, label: 'bug', remark: '来自需求单 #123' });
    assert.equal(op.priority, 'P0');
    assert.equal(op.deadline, '2026-12-31');
    assert.equal(op.is_operator, 1);
    assert.equal(op.label, 'bug');
    assert.equal(op.remark, '来自需求单 #123');
  });
});

test('createTask persists source_schedule_id and getTask round-trips it', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const scheduled = tasksDb.createTask({ projectPath: '/p', title: 'sched', executorProvider: 'claude', sourceScheduleId: 'sched-1' });
    assert.equal(scheduled.source_schedule_id, 'sched-1');
    assert.equal(tasksDb.getTask(scheduled.task_id)?.source_schedule_id, 'sched-1');

    const plain = tasksDb.createTask({ projectPath: '/p', title: 'plain', executorProvider: 'claude' });
    assert.equal(plain.source_schedule_id, null);
  });
});

test('updateTask can set priority/deadline/label/remark', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const row = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' as const });
    const updated = tasksDb.updateTask(row.task_id, { priority: 'P1', deadline: '2026-11-30', label: 'feature', remark: '备注' });
    assert.equal(updated?.priority, 'P1');
    assert.equal(updated?.deadline, '2026-11-30');
    assert.equal(updated?.label, 'feature');
    assert.equal(updated?.remark, '备注');
    const cleared = tasksDb.updateTask(row.task_id, { deadline: null, remark: null });
    assert.equal(cleared?.deadline, null);
    assert.equal(cleared?.remark, null);
  });
});
