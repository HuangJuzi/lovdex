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
  // 镜像 index.js:1994 的生产错误处理：AppError → statusCode + { error: { code, message } }。
  // 没有它时 Express 默认处理器只认 err.statusCode、响应体是 HTML，断言不到 code。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    res.status(e.statusCode ?? 500).json({ success: false, error: { code: e.code, message: e.message } });
  });
  const server = app.listen(0);
  // 不直接把 resolve / r 传给 .on('listening') / .close()：两者的回调签名都是 (err?: Error) => void，
  // 而 resolve / r 是 (value: void | PromiseLike<void>) => void，TS2345（存量错误，顺手修掉）。
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
    remove: (id: string) => { rows.delete(id); },
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
  } finally { await close(); }
});
