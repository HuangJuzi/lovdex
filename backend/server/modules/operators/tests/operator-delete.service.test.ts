import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperatorDeleteService } from '@/modules/operators/operator-delete.service.js';
import { AppError } from '@/shared/utils.js';

type SessionLike = { session_id: string; project_path: string | null; is_operator: number };
type TaskLike = { task_id: string; title: string; status: string };

function makeDeps(overrides: Partial<Parameters<typeof createOperatorDeleteService>[0]> = {}) {
  const sessions = new Map<string, SessionLike>();
  const tasks = new Map<string, TaskLike>();
  const deleted: string[] = [];
  let running = false;

  sessions.set('s1', { session_id: 's1', project_path: '/p', is_operator: 0 });
  sessions.set('s2', { session_id: 's2', project_path: '/p', is_operator: 0 }); // free (unlinked) session
  tasks.set('t1', { task_id: 't1', title: 'linked task', status: 'in_review' });

  const deps = {
    sessionsDb: {
      getSessionById: (id: string) => sessions.get(id) ?? null,
    },
    tasksDb: {
      getTaskBySessionId: (sid: string) => {
        for (const task of tasks.values()) {
          if (task.task_id === 't1' && sid === 's1') return task;
        }
        return null;
      },
    },
    deleteSessionHard: async (id: string) => {
      deleted.push(id);
      return { sessionId: id, action: 'deleted', deletedFromDisk: true };
    },
    isSessionRunning: () => running,
    ...overrides,
  };

  return {
    deps: deps as Parameters<typeof createOperatorDeleteService>[0],
    sessions,
    tasks,
    deleted,
    setRunning: (v: boolean) => {
      running = v;
    },
  };
}

test('deleteSession hard-deletes a free session and returns the outcome', async () => {
  const { deps, deleted } = makeDeps();
  const svc = createOperatorDeleteService(deps);
  const out = await svc.deleteSession({ sessionId: 's2' });
  assert.deepEqual(out, { sessionId: 's2', action: 'deleted', deletedFromDisk: true, linkedTaskId: null });
  assert.deepEqual(deleted, ['s2']);
});

test('deleteSession throws SESSION_NOT_FOUND for a missing session', async () => {
  const { deps } = makeDeps();
  const svc = createOperatorDeleteService(deps);
  await assert.rejects(
    () => svc.deleteSession({ sessionId: 'nope' }),
    (err: unknown) => (err as AppError).code === 'SESSION_NOT_FOUND' && (err as AppError).statusCode === 404,
  );
});

test('deleteSession refuses an operator assistant session', async () => {
  const { deps, sessions, deleted } = makeDeps();
  sessions.set('op1', { session_id: 'op1', project_path: '/w', is_operator: 1 });
  const svc = createOperatorDeleteService(deps);
  await assert.rejects(
    () => svc.deleteSession({ sessionId: 'op1' }),
    (err: unknown) => (err as AppError).code === 'OPERATOR_SESSION_PROTECTED' && (err as AppError).statusCode === 409,
  );
  assert.deepEqual(deleted, []);
});

test('deleteSession refuses a running session', async () => {
  const { deps, setRunning, deleted } = makeDeps();
  setRunning(true);
  const svc = createOperatorDeleteService(deps);
  await assert.rejects(
    () => svc.deleteSession({ sessionId: 's1' }),
    (err: unknown) => (err as AppError).code === 'SESSION_RUNNING',
  );
  assert.deepEqual(deleted, []);
});

test('deleteSession refuses a session whose linked task is in_progress', async () => {
  const { deps, tasks, deleted } = makeDeps();
  tasks.set('t1', { task_id: 't1', title: 'linked task', status: 'in_progress' });
  const svc = createOperatorDeleteService(deps);
  await assert.rejects(
    () => svc.deleteSession({ sessionId: 's1' }),
    (err: unknown) => (err as AppError).code === 'SESSION_RUNNING',
  );
  assert.deepEqual(deleted, []);
});

test('deleteSession refuses a session still linked to a task without cascade', async () => {
  const { deps, deleted } = makeDeps();
  const svc = createOperatorDeleteService(deps);
  await assert.rejects(
    () => svc.deleteSession({ sessionId: 's1' }),
    (err: unknown) => (err as AppError).code === 'SESSION_LINKED_TO_TASK' && /task t1/.test((err as AppError).message),
  );
  assert.deepEqual(deleted, []);
});

test('deleteSession deletes a linked session when cascade is confirmed', async () => {
  const { deps, deleted } = makeDeps();
  const svc = createOperatorDeleteService(deps);
  const out = await svc.deleteSession({ sessionId: 's1', cascade: true });
  assert.deepEqual(out, { sessionId: 's1', action: 'deleted', deletedFromDisk: true, linkedTaskId: 't1' });
  assert.deepEqual(deleted, ['s1']);
});
