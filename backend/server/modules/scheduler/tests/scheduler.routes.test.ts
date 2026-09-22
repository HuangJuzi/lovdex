import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { buildSchedulerRouter } from '@/modules/scheduler/scheduler.routes.js';
import { AppError } from '@/shared/utils.js';

async function startServer(svc: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled-tasks', buildSchedulerRouter(svc as never));
  // 镜像 index.js:1994 的生产错误处理：AppError → statusCode + { error: { code, message, details } }。
  // 没有它时 Express 默认处理器只认 err.statusCode、响应体是 HTML，断言不到 code。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // 只对 AppError 认 statusCode/code —— 生产也是这么收窄的（index.js:1994），
    // 别的错误一律 500 + INTERNAL_ERROR，避免测试版比生产宽松。
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    console.error('unhandled error in scheduler routes test', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
  const server = app.listen(0);
  // 不直接把 r 传给 .close()：close 的回调是 (err?: Error) => void，而这里的返回类型
  // 把 r 定型成 (value: void | PromiseLike<void>) => void，Error | undefined 不能赋给 void
  // → TS2345（存量错误 scheduler.routes.test.ts(14,102)，顺手修掉）。
  // 'listening' 的监听器其实无参、传 resolve 本不报错，包一层只是顺手统一风格。
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(() => r())) };
}

function makeSvc() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id) ?? null,
    create: (i: Record<string, unknown>) => {
      const row = { schedule_id: 's1', ...i, next_run_at: '2026-08-14T09:00:00.000Z' };
      rows.set('s1', row); return row;
    },
    update: (id: string, u: Record<string, unknown>) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, ...u }; rows.set(id, next); return next;
    },
    remove: (id: string) => { rows.delete(id); return { deletedTaskIds: [] }; },
    runNow: (id: string) => rows.has(id) ? { ok: true } : null,
    setEnabled: (id: string, enabled: boolean) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, enabled: enabled ? 1 : 0 }; rows.set(id, next); return next;
    },
  };
}

test('POST / creates a scheduled task', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { schedule_id: string };
    assert.equal(body.schedule_id, 's1');
  } finally { await close(); }
});

test('POST / rejects invalid scheduleType', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scheduleType: 'bogus' }),
    });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('DELETE /:id removes', async () => {
  const svc = makeSvc(); svc.create({ title: 'x', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' });
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  } finally { await close(); }
});

/**
 * 级联删掉的任务 id 必须回给前端：WS 不可靠（E2E 里每次连接都报 WebSocket error），
 * 页面要靠这份 id 把行从本地任务列表里摘掉，否则运行记录会挂着一批已经不在库里的行。
 */
test('DELETE /:id returns the ids of the runs it cascaded away', async () => {
  const svc = {
    ...makeSvc(),
    remove: () => ({ deletedTaskIds: ['run-1', 'run-2'] }),
  };
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json() as { success?: boolean; deletedTaskIds?: string[] };
    assert.equal(body.success, true);
    assert.deepEqual(body.deletedTaskIds, ['run-1', 'run-2']);
  } finally { await close(); }
});

test('DELETE /:id surfaces the running guard as 409 + code', async () => {
  const svc = {
    ...makeSvc(),
    remove: () => {
      throw new AppError('schedule s1 still has an unfinished run; settle or interrupt it first', {
        code: 'SESSION_RUNNING',
        statusCode: 409,
      });
    },
  };
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = await res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'SESSION_RUNNING', '前端靠这个 code 说人话');
  } finally { await close(); }
});

test('POST /:id/disable toggles enabled off', async () => {
  const svc = makeSvc(); svc.create({ title: 'x', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' });
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1/disable`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { enabled: number };
    assert.equal(body.enabled, 0);
  } finally { await close(); }
});

test('POST / returns the title the service resolved for a blank title', async () => {
  const base = makeSvc();
  // 模拟 scheduler.service 的取名行为：空 title 进来，生成后的名字出去。
  const svc = {
    ...base,
    create: async (i: Record<string, unknown>) =>
      base.create({ ...i, title: i.title === '' ? 'AI 取的名' : i.title }),
  };
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '', description: '每天汇总', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { title: string };
    assert.equal(body.title, 'AI 取的名');
  } finally { await close(); }
});

test('POST /:id/run-now surfaces the running guard as 409 + code', async () => {
  const svc = {
    ...makeSvc(),
    runNow: () => {
      throw new AppError('schedule s1 still has an unfinished run; settle or interrupt it first', {
        code: 'SCHEDULE_RUNNING',
        statusCode: 409,
      });
    },
  };
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1/run-now`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = await res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'SCHEDULE_RUNNING', '前端靠这个 code 说人话');
  } finally { await close(); }
});

test('POST /:id/run-now returns 404 for an unknown schedule', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/nope/run-now`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'SCHEDULE_NOT_FOUND', '404 必须来自路由分支，不是 Express 默认 404');
  } finally { await close(); }
});
