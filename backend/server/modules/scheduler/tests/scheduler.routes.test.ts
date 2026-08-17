import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { buildSchedulerRouter } from '@/modules/scheduler/scheduler.routes.js';

async function startServer(svc: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled-tasks', buildSchedulerRouter(svc as never));
  const server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(r)) };
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
