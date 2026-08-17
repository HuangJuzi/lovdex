import assert from 'node:assert/strict';
import test from 'node:test';

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

function listen(t: ReturnType<typeof test>, deleted: { calls: string[][] }) {
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
