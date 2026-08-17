import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { getOperatorConfig } from '@/modules/operators/operator.config.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
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
    }) => {
      const row = {
        task_id: 't1',
        ...input,
        status: input.status ?? 'todo',
        session_id: input.sessionId ?? null,
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
    listTasks: () => [...tasks.values()],
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
  };

  return { db: db as unknown as TaskDbLike, calls };
}

function makeProjectStub(...knownPaths: string[]) {
  return {
    getProjectPath: (path: string) =>
      knownPaths.includes(path)
        ? { project_id: 'p1', project_path: path, custom_project_name: null, isStarred: 0, isArchived: 0 }
        : null,
  } as unknown as typeof projectsDb;
}

test('createTask rejects invalid status / engine', () => {
  const svc = createTasksService(makeDbStub().db, { broadcast: () => {} });
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', status: 'bogus' as never }), /status/);
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'nope' as never }), /executor/);
});

test('createTask rejects an unknown project', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub() },
  });
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' }), /project not found/);
});

test('createTask defaults status to todo and broadcasts task_upserted', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: (e) => events.push(e),
    deps: { projectsDb: makeProjectStub('/p') },
  });
  const task = svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' });
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

test('deleteTask broadcasts task_deleted', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  svc.deleteTask('t1');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_deleted');
  assert.equal((events[0] as { taskId: string }).taskId, 't1');
  assert.equal((events[0] as { actor: string }).actor, 'user');
  assert.equal(db.getTask('t1'), null);
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

test('startExecution links a session and returns its id', () => {
  const { db, calls } = makeDbStub();
  const svc = createTasksService(db, { broadcast: () => {} });
  const result = svc.startExecution('t1', (provider, projectPath) => `session-${provider}-${projectPath}`);
  assert.deepEqual(result, { sessionId: 'session-claude-/p' });
  assert.deepEqual(calls.linkSession, [{ taskId: 't1', sessionId: 'session-claude-/p' }]);
});

test('getTaskBySessionId returns the decorated task for a linked session', () => {
  const row: StoredTask = {
    task_id: 't1', project_path: '/p', title: 't', description: null,
    status: 'in_progress', executor_provider: 'claude', executor_model: null,
    position: 0, session_id: 's1', started_at: null, completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
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

test('createTask with a sessionId links the task and honors status', () => {
  const { db } = makeDbStub();
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  const task = svc.createTask({
    title: 'x',
    projectPath: '/p',
    executorProvider: 'claude',
    status: 'todo',
    sessionId: 's1',
  }) as StoredTask;
  assert.equal(task.session_id, 's1');
  assert.equal(task.status, 'todo');
});

test('createTask with a sessionId rejects an unknown session', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({}),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 'nope' }),
    /session not found/,
  );
});

test('createTask with a sessionId rejects a session from another project', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/other' } }),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /does not belong/,
  );
});

test('createTask with a sessionId rejects a session already linked to a task', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /already linked/,
  );
});

test('createTask rejects invalid priority / deadline / label', () => {
  const svc = createTasksService(makeDbStub().db, { broadcast: () => {} });
  assert.throws(() => svc.createTask({ projectPath: '/p', title: 't', priority: 'P9' as any }), /invalid priority/);
  assert.throws(() => svc.createTask({ projectPath: '/p', title: 't', deadline: '2026/13/99' }), /invalid deadline/);
  assert.throws(() => svc.createTask({ projectPath: '/p', title: 't', label: 'nope' as any }), /invalid label/);
});

test('createTask forwards sourceScheduleId to the db layer (null when absent)', () => {
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
  const withSched = svc.createTask({ projectPath: '/p', title: 'sched', executorProvider: 'claude', sourceScheduleId: 'sched-1' });
  assert.equal(created[0].sourceScheduleId, 'sched-1');
  assert.equal(withSched.source_schedule_id, 'sched-1');

  created.length = 0;
  svc.createTask({ projectPath: '/p', title: 'plain', executorProvider: 'claude' });
  assert.equal(created[0].sourceScheduleId, null);
});

test('createTask operator task uses claude + workspace project', () => {
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
  const row = svc.createTask({ projectPath: '__assistant__', title: 't', isOperator: true });
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

test('createTask operator task requires the claude executor', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub() },
  });
  assert.throws(
    () => svc.createTask({ projectPath: '__assistant__', title: 't', isOperator: true, executorProvider: 'codex' }),
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
