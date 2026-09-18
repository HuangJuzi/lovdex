import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import express from 'express';

import { buildTasksRouter } from '../tasks.routes.js';
import type { TasksService } from '../services/tasks.service.js';
import { AppError } from '@/shared/utils.js';

/** 挂载批量删除路由 + 一个映射 AppError 的错误中间件（复刻 index.js 的全局中间件）。 */
function buildTestApp(deleted: { calls: string[][] }) {
  const app = express();
  app.use(express.json());
  const fakeService = {
    deleteTasks: (ids: string[]) => {
      deleted.calls.push(ids);
      return ids.length;
    },
  } as unknown as TasksService;
  app.use('/api/tasks', buildTasksRouter(fakeService, { createSession: () => 's1' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    }
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'internal' } });
  });
  return app;
}

function listen(t: TestContext, deleted: { calls: string[][] }) {
  const server = buildTestApp(deleted).listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return { port };
}

test('POST /api/tasks/batch-delete forwards ids and returns the deleted count', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: ['t1', 't2'] }),
  });
  assert.strictEqual(res.status, 200);
  assert.deepEqual(deleted.calls, [['t1', 't2']]);
  assert.deepEqual(await res.json(), { success: true, deleted: 2 });
});

test('POST /api/tasks/batch-delete rejects a missing or non-array taskIds', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: 't1' }),
  });
  assert.strictEqual(res.status, 400);
  assert.deepEqual(deleted.calls, []);
});

test('POST /api/tasks/batch-delete rejects a non-string entry', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: ['t1', 42] }),
  });
  assert.strictEqual(res.status, 400);
  assert.deepEqual(deleted.calls, []);
});

test('POST /api/tasks/batch-delete rejects an empty or oversized list', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const empty = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: [] }),
  });
  assert.strictEqual(empty.status, 400);
  const big = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: Array.from({ length: 501 }, (_, i) => `t${i}`) }),
  });
  assert.strictEqual(big.status, 400);
  assert.deepEqual(deleted.calls, []);
});

test('POST /api/tasks forwards sourceSessionId to createTask', async (t) => {
  const created: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  const fakeService = {
    createTask: (input: Record<string, unknown>) => {
      created.push(input);
      return { task_id: 't1', project_path: String(input.projectPath), title: String(input.title), context_summary: null };
    },
  } as unknown as TasksService;
  app.use('/api/tasks', buildTasksRouter(fakeService, { createSession: () => 's1' }));
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: '/p', title: 'x', sourceSessionId: 'src1' }),
  });
  assert.equal(res.status, 201);
  assert.equal(created.length, 1);
  assert.equal(created[0].sourceSessionId, 'src1');
});

/** 挂载建任务路由，用一个只记录入参的假服务，验证路由往服务里传了什么。 */
function buildCreateApp(seen: Record<string, unknown>[]) {
  const app = express();
  app.use(express.json());
  const fakeService = {
    createTask: async (input: Record<string, unknown>) => {
      seen.push(input);
      return { task_id: 't1', title: input.title };
    },
  } as unknown as TasksService;
  app.use('/api/tasks', buildTasksRouter(fakeService, { createSession: () => 's1' }));
  return app;
}

test('POST /api/tasks 打开服务端去重，重复提交才不会各建一条', async (t) => {
  const seen: Record<string, unknown>[] = [];
  const server = buildCreateApp(seen).listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };

  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: '/p', title: '', description: '把看板筛选做出来' }),
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(seen.length, 1);
  assert.equal(seen[0].dedupIdentical, true);
});

/** 挂载删除任务路由，用一个只记录入参的假服务，验证 DELETE 的行为。 */
function buildDeleteApp(deleteTask: (id: string) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', buildTasksRouter({ deleteTask } as unknown as TasksService, { createSession: () => 's1' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    }
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'internal' } });
  });
  return app;
}

test('DELETE /api/tasks/:taskId returns the deletion outcome', async (t) => {
  const seen: string[] = [];
  const server = buildDeleteApp(async (id: string) => {
    seen.push(id);
    return { taskId: id, deletedSessionId: 's1' };
  }).listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/t1`, { method: 'DELETE' });
  assert.strictEqual(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, taskId: 't1', deletedSessionId: 's1' });
  assert.deepEqual(seen, ['t1']);
});

test('DELETE /api/tasks/:taskId 404s with TASK_NOT_FOUND when the service reports missing', async (t) => {
  const server = buildDeleteApp(async () => null).listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/missing`, { method: 'DELETE' });
  assert.strictEqual(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: { code: 'TASK_NOT_FOUND', message: 'task not found' } });
});
