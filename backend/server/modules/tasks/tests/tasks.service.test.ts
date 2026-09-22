import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { getOperatorConfig } from '@/modules/operators/operator.config.js';
import { createTasksService, isUndeletable } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';
import { AppError } from '@/shared/utils.js';

type StoredTask = {
  task_id: string;
  project_path: string;
  title: string;
  description: string | null;
  status: string;
  executor_provider: string;
  executor_model: string | null;
  position: number;
  session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  context_summary: string | null;
  context_source_session_id: string | null;
  context_mode: 'none' | 'summary' | 'raw';
  context_status: 'pending' | 'ready' | 'failed' | null;
  context_raw: string | null;
  source_schedule_id: string | null;
};

function makeDbStub() {
  const tasks = new Map<string, StoredTask>();
  tasks.set('t1', {
    task_id: 't1',
    project_path: '/p',
    title: 'x',
    description: null,
    status: 'todo',
    executor_provider: 'claude',
    executor_model: null,
    position: 1,
    session_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    context_summary: null,
    context_source_session_id: null,
    context_mode: 'none',
    context_status: null,
    context_raw: null,
    source_schedule_id: null,
  });

  const calls: { linkSession: { taskId: string; sessionId: string }[] } = { linkSession: [] };

  const db = {
    createTask: (input: {
      projectPath: string;
      title: string;
      description?: string | null;
      executorProvider: string;
      executorModel?: string | null;
      status?: string;
      sessionId?: string | null;
      sourceScheduleId?: string | null;
      contextSourceSessionId?: string | null;
      contextMode?: 'none' | 'summary' | 'raw';
      contextStatus?: 'pending' | 'ready' | 'failed' | null;
    }) => {
      const row = {
        task_id: 't1',
        ...input,
        status: input.status ?? 'todo',
        session_id: input.sessionId ?? null,
        context_summary: null,
        context_source_session_id: input.contextSourceSessionId ?? null,
        context_mode: input.contextMode ?? 'none',
        context_status: input.contextStatus ?? null,
        context_raw: null,
        source_schedule_id: input.sourceScheduleId ?? null,
      };
      tasks.set('t1', row as unknown as StoredTask);
      return row;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskBySessionId: (sid: string) => {
      for (const task of tasks.values()) {
        if (task.session_id === sid) return task;
      }
      return null;
    },
    listTasks: (filter?: { sourceScheduleId?: string }) =>
      [...tasks.values()].filter(
        (t) => filter?.sourceScheduleId === undefined || t.source_schedule_id === filter.sourceScheduleId,
      ),
    updateTask: (id: string, updates: Record<string, unknown>) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next: StoredTask = { ...current };
      if (updates.title !== undefined) next.title = String(updates.title);
      if (updates.description !== undefined) next.description = updates.description as string | null;
      if (updates.executorProvider !== undefined) next.executor_provider = String(updates.executorProvider);
      if (updates.executorModel !== undefined) next.executor_model = updates.executorModel as string | null;
      if (updates.sessionId !== undefined) next.session_id = updates.sessionId as string | null;
      if (updates.projectPath !== undefined) next.project_path = String(updates.projectPath);
      tasks.set(id, next);
      return next;
    },
    updateTaskStatus: (id: string, status: string) => {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, status });
    },
    updateTaskSubStatus: (id: string, sub: string | null) => {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, sub_status: sub } as StoredTask);
    },
    linkSession: (taskId: string, sessionId: string) => {
      calls.linkSession.push({ taskId, sessionId });
      const current = tasks.get(taskId);
      if (current) tasks.set(taskId, { ...current, session_id: sessionId });
    },
    deleteTask: (id: string) => {
      tasks.delete(id);
    },
    moveTask: () => {},
    writeContextResult: (id: string, result: { status: 'ready' | 'failed'; summary?: string | null; raw?: string | null }) => {
      const t = tasks.get(id);
      if (!t) return;
      t.context_status = result.status;
      t.context_summary = result.summary ?? null;
      t.context_raw = result.raw ?? null;
    },
  };

  return { db: db as unknown as TaskDbLike, calls, tasks };
}

function makeProjectStub(...knownPaths: string[]) {
  return {
    getProjectPath: (path: string) =>
      knownPaths.includes(path)
        ? { project_id: 'p1', project_path: path, custom_project_name: null, isStarred: 0, isArchived: 0 }
        : null,
  } as unknown as typeof projectsDb;
}

test('createTask rejects invalid status / engine', async () => {
  const svc = createTasksService(makeDbStub().db, { broadcast: () => {} });
  await assert.rejects(svc.createTask({ title: 'x', projectPath: '/p', status: 'bogus' as never }), /status/);
  await assert.rejects(svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'nope' as never }), /executor/);
});

test('createTask rejects an unknown project', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub() },
  });
  await assert.rejects(svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' }), /project not found/);
});

test('createTask defaults status to todo and broadcasts task_upserted', async () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: (e) => events.push(e),
    deps: { projectsDb: makeProjectStub('/p') },
  });
  const task = await svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' });
  assert.equal((task as { status: string }).status, 'todo');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'user');
});

test('applyStatusChange mutates the stored task and broadcasts the updated row', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const updated = svc.applyStatusChange('t1', 'in_progress', 'user');
  assert.equal((updated as { status: string }).status, 'in_progress');
  assert.equal((db.getTask('t1') as { status: string }).status, 'in_progress');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'user');
  assert.equal((events[0] as { task: { status: string } }).task.status, 'in_progress');
});

test('deleteTask broadcasts task_deleted and returns the outcome', async () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const result = await svc.deleteTask('t1');
  assert.deepEqual(result, { taskId: 't1', deletedSessionId: null });
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_deleted');
  assert.equal((events[0] as { taskId: string }).taskId, 't1');
  assert.equal((events[0] as { actor: string }).actor, 'user');
  assert.equal(db.getTask('t1'), null);
});

test('deleteTask returns null for a missing task', async () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub().db, { broadcast: (e) => events.push(e) });
  assert.equal(await svc.deleteTask('missing'), null);
  assert.equal(events.length, 0);
});

test('deleteTask hard-deletes the linked session and returns its id', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const result = await svc.deleteTask('t1');
  assert.deepEqual(result, { taskId: 't1', deletedSessionId: 's1' });
  assert.deepEqual(deleted, ['s1']);
  assert.equal(db.getTask('t1'), null);
});

test('deleteTask tolerates an already-missing linked session', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 'ghost');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      deleteSessionHard: async () => {
        throw new AppError('Session not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      },
    },
  });
  const result = await svc.deleteTask('t1');
  assert.deepEqual(result, { taskId: 't1', deletedSessionId: 'ghost' });
  assert.equal(db.getTask('t1'), null);
});

test('deleteTask rejects when the linked session is running', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { isSessionRunning: () => true },
  });
  await assert.rejects(() => svc.deleteTask('t1'), /running\/in_progress/);
  assert.ok(db.getTask('t1'), 'task must survive a rejected delete');
});

test('deleteTask rejects an in_progress task even when the run registry is empty', async () => {
  const { db } = makeDbStub();
  db.updateTaskStatus('t1', 'in_progress');
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { isSessionRunning: () => false },
  });
  await assert.rejects(() => svc.deleteTask('t1'), /running\/in_progress/);
  assert.ok(db.getTask('t1'));
});

test('deleteTasks deletes each id and broadcasts task_deleted per id', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const n = svc.deleteTasks(['t1', 'missing']);
  assert.equal(n, 2);
  assert.equal(events.length, 2);
  assert.equal((events[0] as { taskId: string }).taskId, 't1');
  assert.equal((events[1] as { taskId: string }).taskId, 'missing');
  assert.equal(db.getTask('t1'), null);
});

test('deleteTasks with an empty list is a no-op', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.deleteTasks([]), 0);
  assert.equal(events.length, 0);
  assert.equal(db.getTask('t1')?.task_id, 't1');
});

/** 造一条「定时任务跑出来的」运行记录，挂在指定的调度下。 */
function seedRun(
  tasks: Map<string, StoredTask>,
  taskId: string,
  over: Partial<StoredTask> = {},
): void {
  tasks.set(taskId, {
    task_id: taskId,
    project_path: '/p',
    title: taskId,
    description: null,
    status: 'done',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    context_summary: null,
    context_source_session_id: null,
    context_mode: 'none',
    context_status: null,
    context_raw: null,
    source_schedule_id: 'sch-1',
    ...over,
  });
}

/**
 * 判据本身单测一遍：它是单条删除与级联删除**共用**的那一个，漂了就是「删到一半才 409」。
 * 尤其钉住最后一条 —— 「没挂会话的 in_progress 任务仍可删」是既有行为，不是漏判。
 */
test('isUndeletable: 只有「挂着会话且（在跑 或 会话仍活着）」才删不得', () => {
  const never = () => false;
  const always = () => true;
  assert.equal(isUndeletable({ status: 'in_progress', session_id: 's1' }, always), true, '会话在流式输出');
  assert.equal(isUndeletable({ status: 'in_progress', session_id: 's1' }, never), true, '停在 in_progress 列');
  assert.equal(isUndeletable({ status: 'done', session_id: 's1' }, always), true, 'status 骗人，会话还在跑');
  assert.equal(isUndeletable({ status: 'done', session_id: 's1' }, never), false, '跑完且会话已死');
  assert.equal(isUndeletable({ status: 'in_review', session_id: 's1' }), false, '没注入判据时退化成只看 status');
  // 没挂会话 → 一律可删（含 in_progress 的仅提醒任务），与改动前一致
  assert.equal(isUndeletable({ status: 'in_progress', session_id: null }, always), false, '没会话就不受会话判据影响');
});

test('deleteTasksBySchedule removes every run of that schedule and hard-deletes their sessions', async () => {
  const events: unknown[] = [];
  const { db, tasks } = makeDbStub();
  seedRun(tasks, 'run-1', { session_id: 'sess-1' });
  seedRun(tasks, 'run-2', { session_id: 'sess-2' });
  seedRun(tasks, 'run-3'); // 仅提醒的那一轮没有会话
  seedRun(tasks, 'other', { source_schedule_id: 'sch-2', session_id: 'sess-other' });
  const deletedSessions: string[] = [];
  const svc = createTasksService(db, {
    broadcast: (e) => events.push(e),
    deps: { deleteSessionHard: async (sid: string) => { deletedSessions.push(sid); } },
  });

  const result = await svc.deleteTasksBySchedule('sch-1');

  assert.deepEqual([...result.deletedTaskIds].sort(), ['run-1', 'run-2', 'run-3']);
  assert.equal(db.getTask('run-1'), null);
  assert.equal(db.getTask('run-2'), null);
  assert.equal(db.getTask('run-3'), null);
  assert.deepEqual(deletedSessions.sort(), ['sess-1', 'sess-2']);
  // 别的调度跑出来的任务一个都不许碰
  assert.ok(db.getTask('other'), 'another schedule\'s run must survive');
  assert.ok(db.getTask('t1'), 'a manual task must survive');
  // 每条被删的运行都要发自己的 task_deleted（看板/收件箱靠它实时摘行）
  assert.deepEqual(
    events.map((e) => (e as { taskId?: string }).taskId).sort(),
    ['run-1', 'run-2', 'run-3'],
  );
  assert.ok(events.every((e) => (e as { kind: string }).kind === 'task_deleted'));
});

test('deleteTasksBySchedule is a no-op when the schedule never ran', async () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const result = await svc.deleteTasksBySchedule('sch-1');
  assert.deepEqual(result, { deletedTaskIds: [] });
  assert.equal(events.length, 0);
});

/**
 * 级联删的是「模板 + 它跑出来的所有东西」，所以只要还有一轮在跑就**整个拒绝** ——
 * 不能删一半：删掉一半再抛 409，用户看到的是「调度还在、运行记录却少了几条」。
 * 判据与 deleteTask 单条路径逐字一致（in_progress 或会话仍在流式输出）。
 */
test('deleteTasksBySchedule refuses the whole cascade when one run is still in progress', async () => {
  const events: unknown[] = [];
  const { db, tasks } = makeDbStub();
  seedRun(tasks, 'run-1');
  seedRun(tasks, 'run-2', { status: 'in_progress', session_id: 'sess-2' });
  const svc = createTasksService(db, {
    broadcast: (e) => events.push(e),
    deps: { isSessionRunning: () => false },
  });

  await assert.rejects(
    () => svc.deleteTasksBySchedule('sch-1'),
    (e: { code?: string; statusCode?: number; details?: { taskId?: string } }) =>
      e.code === 'SESSION_RUNNING' && e.statusCode === 409 && e.details?.taskId === 'run-2',
  );
  assert.ok(db.getTask('run-1'), '已结束的那一轮也不许删 —— 拒绝必须是整体的');
  assert.ok(db.getTask('run-2'));
  assert.equal(events.length, 0, '被拒绝时不许广播 task_deleted');
});

test('deleteTasksBySchedule refuses when a settled task still has a streaming session', async () => {
  // status 会骗人：人工把在跑的任务标成 done 之后，agent 还在同一个项目里写文件。
  const { db, tasks } = makeDbStub();
  seedRun(tasks, 'run-1', { status: 'done', session_id: 'sess-live' });
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { isSessionRunning: (sid: string) => sid === 'sess-live' },
  });

  await assert.rejects(
    () => svc.deleteTasksBySchedule('sch-1'),
    (e: { code?: string }) => e.code === 'SESSION_RUNNING',
  );
  assert.ok(db.getTask('run-1'));
});

test('startExecution links a session and returns its id', () => {
  const { db, calls } = makeDbStub();
  const svc = createTasksService(db, { broadcast: () => {} });
  const result = svc.startExecution('t1', (provider, projectPath) => `session-${provider}-${projectPath}`);
  assert.deepEqual(result, { sessionId: 'session-claude-/p' });
  assert.deepEqual(calls.linkSession, [{ taskId: 't1', sessionId: 'session-claude-/p' }]);
});

test('startExecution on an archived task is rejected', () => {
  const { db, calls } = makeDbStub();
  const svc = createTasksService(db, { broadcast: () => {} });
  svc.applyStatusChange('t1', 'done', 'user');
  svc.applyStatusChange('t1', 'archived', 'user');
  assert.throws(
    () => svc.startExecution('t1', () => 'new-sess'),
    /archived/i,
  );
  assert.deepEqual(calls.linkSession, []);
});

test('getTaskBySessionId returns the decorated task for a linked session', () => {
  const row: StoredTask = {
    task_id: 't1', project_path: '/p', title: 't', description: null,
    status: 'in_progress', executor_provider: 'claude', executor_model: null,
    position: 0, session_id: 's1', started_at: null, completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    context_summary: null,
    context_source_session_id: null,
    context_mode: 'none',
    context_status: null,
    context_raw: null,
    source_schedule_id: null,
  };
  const db = {
    createTask: () => row,
    getTask: (id: string) => (id === 't1' ? row : null),
    getTaskBySessionId: (sid: string) => (sid === 's1' ? row : null),
    listTasks: () => [row],
    updateTask: () => row,
    updateTaskStatus: () => {},
    updateTaskSubStatus: () => {},
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
  } as unknown as TaskDbLike;
  const svc = createTasksService(db, {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
  });
  const got = svc.getTaskBySessionId('s1');
  assert.equal(got?.task_id, 't1');
  assert.equal(got?.approval_pending, true);
  assert.equal(svc.getTaskBySessionId('nope'), null);
});

test('updateTask: todo task project change deletes the linked session and unlinks', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p', '/q'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
  assert.equal(row?.session_id, null);
  assert.deepEqual(deleted, ['s1']);
  const stored = db.getTask('t1') as StoredTask;
  assert.equal(stored.project_path, '/q');
  assert.equal(stored.session_id, null);
});

test('updateTask: project change without a session does not delete anything', async () => {
  const { db } = makeDbStub();
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p', '/q'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
  assert.deepEqual(deleted, []);
});

test('updateTask: rejects project change for non-todo tasks', async () => {
  for (const status of ['in_progress', 'in_review', 'done'] as const) {
    const { db } = makeDbStub();
    db.updateTaskStatus('t1', status);
    const svc = createTasksService(db, {
      broadcast: () => {},
      deps: { projectsDb: makeProjectStub('/p') },
    });
    await assert.rejects(
      () => svc.updateTask('t1', { projectPath: '/q' }),
      /not todo/,
    );
  }
});

test('updateTask: rejects an unknown target project without deleting the session', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  await assert.rejects(() => svc.updateTask('t1', { projectPath: '/nope' }), /project not found/);
  assert.deepEqual(deleted, []);
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
});

test('updateTask: selecting the current project is a no-op', async () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: (e) => events.push(e),
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/p' });
  assert.equal(row?.project_path, '/p');
  assert.deepEqual(deleted, []);
  assert.equal(events.length, 0);
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
});

test('updateTask: tolerates a missing session row when deleting', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p', '/q'),
      deleteSessionHard: async () => {
        const e = new AppError('Session not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        throw e;
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
});

test('updateTask: ordinary field updates leave the session untouched', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { title: 'new title' });
  assert.equal(row?.title, 'new title');
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
  assert.deepEqual(deleted, []);
});

type SessionLike = { session_id: string; project_path: string | null };

function makeSessionStub(rows: Record<string, SessionLike>) {
  return {
    getSessionById: (sid: string) => rows[sid] ?? null,
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
}

test('createTask with a sessionId links the task and honors status', async () => {
  const { db } = makeDbStub();
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  const task = await svc.createTask({
    title: 'x',
    projectPath: '/p',
    executorProvider: 'claude',
    status: 'todo',
    sessionId: 's1',
  }) as StoredTask;
  assert.equal(task.session_id, 's1');
  assert.equal(task.status, 'todo');
});

test('createTask with a sessionId rejects an unknown session', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({}),
    },
  });
  await assert.rejects(
    svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 'nope' }),
    /session not found/,
  );
});

test('createTask with a sessionId rejects a session from another project', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/other' } }),
    },
  });
  await assert.rejects(
    svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /does not belong/,
  );
});

test('createTask with a sessionId rejects a session already linked to a task', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  await assert.rejects(
    svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /already linked/,
  );
});

test('createTask rejects invalid priority / deadline / label', async () => {
  const svc = createTasksService(makeDbStub().db, { broadcast: () => {} });
  await assert.rejects(svc.createTask({ projectPath: '/p', title: 't', priority: 'P9' as any }), /invalid priority/);
  await assert.rejects(svc.createTask({ projectPath: '/p', title: 't', deadline: '2026/13/99' }), /invalid deadline/);
  await assert.rejects(svc.createTask({ projectPath: '/p', title: 't', label: 'nope' as any }), /invalid label/);
});

test('createTask forwards sourceScheduleId to the db layer (null when absent)', async () => {
  type CreateInput = Parameters<TaskDbLike['createTask']>[0];
  const created: CreateInput[] = [];
  const stubDb = {
    ...makeDbStub().db,
    createTask: (input: CreateInput) => {
      created.push(input);
      return {
        task_id: 't2',
        ...input,
        source_schedule_id: input.sourceScheduleId ?? null,
        project_path: input.projectPath,
        status: input.status ?? 'todo',
        session_id: input.sessionId ?? null,
      };
    },
  };
  const svc = createTasksService(stubDb as unknown as TaskDbLike, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p') },
  });
  const withSched = await svc.createTask({ projectPath: '/p', title: 'sched', executorProvider: 'claude', sourceScheduleId: 'sched-1' });
  assert.equal(created[0].sourceScheduleId, 'sched-1');
  assert.equal(withSched.source_schedule_id, 'sched-1');

  created.length = 0;
  await svc.createTask({ projectPath: '/p', title: 'plain', executorProvider: 'claude' });
  assert.equal(created[0].sourceScheduleId, null);
});

test('createTask operator task uses claude + workspace project', async () => {
  const created: any[] = [];
  const stubDb = {
    ...makeDbStub().db,
    createTask: (input: any) => {
      created.push(input);
      return {
        task_id: 't1',
        priority: input.priority ?? 'P2',
        deadline: input.deadline ?? null,
        is_operator: input.isOperator ? 1 : 0,
        label: input.label ?? 'other',
        remark: input.remark ?? null,
        status: 'todo',
        project_path: input.projectPath,
      };
    },
  };
  const projectRows = new Map<string, object>();
  const stubProjects = {
    getProjectPath: (p: string) => projectRows.get(p) ?? null,
    createProjectPath: (p: string) => {
      projectRows.set(p, { project_path: p });
      return { outcome: 'created', project: { project_path: p } };
    },
  };
  const svc = createTasksService(stubDb as any, {
    broadcast: () => {},
    deps: { projectsDb: stubProjects as any },
  });
  const row = await svc.createTask({ projectPath: '__assistant__', title: 't', isOperator: true });
  assert.equal(row.is_operator, 1);
  // Hermetic: compare against the same source the service uses (getOperatorConfig),
  // expanding a possible `~` prefix exactly like the service's expandHome helper.
  const rawWs = getOperatorConfig().workspace;
  const expectedWs = rawWs === '~' ? os.homedir()
    : rawWs.startsWith('~/') || rawWs.startsWith('~\\') ? path.join(os.homedir(), rawWs.slice(2))
    : rawWs;
  assert.equal(created[0].projectPath, expectedWs);
  assert.equal(created[0].executorProvider, 'claude');
});

test('createTask operator task requires the claude executor', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub() },
  });
  await assert.rejects(
    svc.createTask({ projectPath: '__assistant__', title: 't', isOperator: true, executorProvider: 'codex' }),
    /must use the claude executor/,
  );
});

test('updateTask: rejects project change for an operator task', async () => {
  const { db } = makeDbStub();
  (db.getTask('t1') as unknown as { is_operator: number }).is_operator = 1;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p', '/q') },
  });
  await assert.rejects(() => svc.updateTask('t1', { projectPath: '/q' }), /cannot change project/);
});

test('startExecution passes isOperator to createSession', () => {
  const captured: any[] = [];
  const stubDb = {
    ...makeDbStub().db,
    getTask: () => ({ task_id: 't1', is_operator: 1, executor_provider: 'claude', project_path: '/w' }),
  };
  const svc = createTasksService(stubDb as any, { broadcast: () => {} });
  svc.startExecution('t1', (_p, _pp, isOp) => {
    captured.push(isOp);
    return 's1';
  });
  assert.equal(captured[0], true);
});

test('startExecution names the new session after the task title', () => {
  const { db } = makeDbStub();
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { sessionsDb: sessions },
  });
  const result = svc.startExecution('t1', () => 's1');
  assert.deepEqual(result, { sessionId: 's1' });
  assert.deepEqual(named, [{ sessionId: 's1', customName: 'x' }]);
});

test('startExecution skips naming when the task title is blank', () => {
  const stubDb = {
    ...makeDbStub().db,
    getTask: () => ({
      task_id: 't1',
      is_operator: 0,
      executor_provider: 'claude',
      project_path: '/p',
      title: '   ',
    }),
  };
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(stubDb as unknown as TaskDbLike, {
    broadcast: () => {},
    deps: { sessionsDb: sessions },
  });
  svc.startExecution('t1', () => 's1');
  assert.deepEqual(named, []);
});

type BackfillSessionRow = { custom_name?: string | null; project_path?: string | null };

function makeBackfillSessionStub(
  rows: Record<string, BackfillSessionRow>,
  updated: { sessionId: string; customName: string }[],
) {
  return {
    getSessionById: (sid: string) =>
      rows[sid]
        ? { session_id: sid, custom_name: rows[sid].custom_name ?? null, project_path: rows[sid].project_path ?? null }
        : null,
    updateSessionCustomName: (sessionId: string, customName: string) => {
      updated.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
}

test('backfillSessionNames fills a blank session name from the task title', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: null } }, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 1);
  assert.deepEqual(updated, [{ sessionId: 's1', customName: 'x' }]);
});

test('backfillSessionNames skips a session that already has a custom name', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: '自定义' } }, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});

test('backfillSessionNames replaces a placeholder session name', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: 'Untitled Claude Session' } }, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 1);
  assert.deepEqual(updated, [{ sessionId: 's1', customName: 'x' }]);
});

test('backfillSessionNames skips a task without a linked session', () => {
  const { db } = makeDbStub(); // t1 默认 session_id 为 null
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({}, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});

test('backfillSessionNames skips a task with a blank title', () => {
  const stubDb = {
    ...makeDbStub().db,
    listTasks: () => [{ task_id: 't1', session_id: 's1', title: '   ' }],
  };
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: null } }, updated);
  const svc = createTasksService(stubDb as unknown as TaskDbLike, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});

test('backfillSessionNames skips a task whose session is missing', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 'ghost');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({}, updated); // getSessionById('ghost') → null
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});

test('decorate flags session_deleted when the linked session row is gone', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 'ghost');
  // sessionsDb stub returns null for every lookup — simulates a session row
  // hard-deleted while the task still references it (cleanup regression guard).
  const sessions = makeBackfillSessionStub({}, []);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  const row = svc.getTask('t1');
  assert.equal(row?.session_deleted, true);
});

test('decorate does not flag session_deleted when the session row exists', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const sessions = makeBackfillSessionStub({ s1: { custom_name: null } }, []);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  const row = svc.getTask('t1');
  assert.equal(row?.session_deleted, false);
});

test('updateTask: renaming the title syncs the linked session custom name', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: sessions },
  });
  const row = await svc.updateTask('t1', { title: 'renamed' });
  assert.equal(row?.title, 'renamed');
  assert.deepEqual(named, [{ sessionId: 's1', customName: 'renamed' }]);
});

test('updateTask: no session name sync without a linked session', async () => {
  const { db } = makeDbStub(); // t1 默认 session_id 为 null
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: sessions },
  });
  await svc.updateTask('t1', { title: 'renamed' });
  assert.deepEqual(named, []);
});

test('updateTask: skips session name sync for a blank or trim-unchanged title', async () => {
  // 空白新标题（清空标题）→ 跳过。stub 会原样持久化空白标题，但同步不触发。
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: sessions },
  });
  await svc.updateTask('t1', { title: '   ' });
  assert.deepEqual(named, []);

  // 去空白后标题实质未变（' x ' vs 已存储的 'x'）→ 跳过。用新 stub 保证存储标题仍为 'x'。
  const { db: db2 } = makeDbStub();
  db2.linkSession('t1', 's1');
  const named2: { sessionId: string; customName: string }[] = [];
  const sessions2 = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named2.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc2 = createTasksService(db2, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: sessions2 },
  });
  await svc2.updateTask('t1', { title: ' x ' });
  assert.deepEqual(named2, []);
});

test('updateTask: title rename alongside a project change does not sync the old session', async () => {
  // 改项目会删会话并解链（session_id 置 null），因此标题虽变化也不得对已删会话同步名称。
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p', '/q'),
      sessionsDb: sessions,
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { title: 'renamed', projectPath: '/q' });
  assert.equal(row?.title, 'renamed');
  assert.equal(row?.session_id, null);
  assert.deepEqual(deleted, ['s1']);
  assert.deepEqual(named, []);
});

test('syncTaskTitleFromSession updates the linked task title and broadcasts', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const events: unknown[] = [];
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const row = svc.syncTaskTitleFromSession('s1', 'new name');
  assert.equal(row?.title, 'new name');
  assert.equal((db.getTask('t1') as StoredTask).title, 'new name');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
  assert.equal((events[0] as { task: { title: string } }).task.title, 'new name');
});

test('syncTaskTitleFromSession is a no-op when no task links the session', () => {
  const { db } = makeDbStub();
  const events: unknown[] = [];
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.syncTaskTitleFromSession('nope', 'x'), null);
  assert.equal(events.length, 0);
});

test('syncTaskTitleFromSession skips blank or unchanged titles', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1'); // t1 默认标题为 'x'
  const events: unknown[] = [];
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.syncTaskTitleFromSession('s1', '   '), null);
  assert.equal(svc.syncTaskTitleFromSession('s1', 'x'), null);
  assert.equal(events.length, 0);
});

function makeSessionsStub(sessions: Array<{ id: string; project_path: string }>) {
  return {
    getSessionById: (id: string) => sessions.find((s) => s.id === id) ?? null,
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
}

test('createTask with sourceSessionId validates session exists + project match and fires onContextSourceProvided', async () => {
  const events: unknown[] = [];
  const hooks: Array<[string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: (e) => events.push(e),
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionsStub([{ id: 'src1', project_path: '/p' }]),
    },
    onContextSourceProvided: (taskId, sourceSessionId) => hooks.push([taskId, sourceSessionId]),
  });
  const task = await svc.createTask({
    title: 'x',
    projectPath: '/p',
    executorProvider: 'claude',
    sourceSessionId: 'src1',
  });
  assert.equal((task as { context_summary: string | null }).context_summary, null);
  assert.deepEqual(hooks, [['t1', 'src1']]);
});

test('createTask with sourceSessionId rejects a session from another project', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionsStub([{ id: 'src1', project_path: '/other' }]),
    },
  });
  await assert.rejects(
    svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 'src1' }),
    /session does not belong/,
  );
});

test('createTask with unknown sourceSessionId rejects', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([]) },
  });
  await assert.rejects(
    svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 'nope' }),
    /session not found/,
  );
});

test('createTask without sourceSessionId never fires onContextSourceProvided', async () => {
  const hooks: Array<[string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p') },
    onContextSourceProvided: (taskId, sourceSessionId) => hooks.push([taskId, sourceSessionId]),
  });
  await svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' });
  assert.deepEqual(hooks, []);
});

test('setTaskContextResult persists, broadcasts engine task_upserted and returns decorated row', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const updated = svc.setTaskContextResult('t1', { status: 'ready', summary: '## 背景\n先前决策 A' });
  assert.equal((updated as { context_summary: string | null; context_status: string | null }).context_summary, '## 背景\n先前决策 A');
  assert.equal((updated as { context_status: string | null }).context_status, 'ready');
  assert.equal((db.getTask('t1') as { context_summary: string | null }).context_summary, '## 背景\n先前决策 A');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'engine');
});

test('setTaskContextResult for a missing task returns null and does not broadcast', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub().db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.setTaskContextResult('nope', { status: 'failed' }), null);
  assert.equal(events.length, 0);
});

test('createTask persists context_mode/status and fires onContextSourceProvided with mode', async () => {
  const hooks: Array<[string, string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([{ id: 's-1', project_path: '/p' }]) },
    onContextSourceProvided: (taskId, sourceSessionId, mode) => hooks.push([taskId, sourceSessionId, mode]),
  });
  const row = await svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 's-1', contextMode: 'raw' });
  assert.equal((row as { context_mode: string }).context_mode, 'raw');
  assert.equal((row as { context_status: string | null }).context_status, 'pending');
  assert.equal((row as { context_source_session_id: string | null }).context_source_session_id, 's-1');
  assert.deepEqual(hooks, [['t1', 's-1', 'raw']]);
});

test('createTask defaults contextMode to summary when only sourceSessionId given', async () => {
  const hooks: Array<[string, string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([{ id: 's-1', project_path: '/p' }]) },
    onContextSourceProvided: (taskId, sourceSessionId, mode) => hooks.push([taskId, sourceSessionId, mode]),
  });
  const row = await svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 's-1' });
  assert.equal((row as { context_mode: string }).context_mode, 'summary');
  assert.equal((row as { context_status: string | null }).context_status, 'pending');
  assert.deepEqual(hooks, [['t1', 's-1', 'summary']]);
});

test('createTask rejects invalid contextMode', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p') },
  });
  await assert.rejects(
    svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', contextMode: 'bogus' as never }),
    /invalid contextMode/,
  );
});

test('createTask with contextMode=none ignores sourceSessionId', async () => {
  const hooks: Array<[string, string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([{ id: 's-1', project_path: '/p' }]) },
    onContextSourceProvided: (taskId, sourceSessionId, mode) => hooks.push([taskId, sourceSessionId, mode]),
  });
  const row = await svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 's-1', contextMode: 'none' });
  assert.equal((row as { context_mode: string }).context_mode, 'none');
  assert.equal((row as { context_status: string | null }).context_status, null);
  assert.equal((row as { context_source_session_id: string | null }).context_source_session_id, null);
  assert.deepEqual(hooks, []);
});

test('createTask with contextMode=summary but no sourceSessionId rejects', async () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p') },
  });
  await assert.rejects(
    svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', contextMode: 'summary' }),
    /sourceSessionId is required/,
  );
});
