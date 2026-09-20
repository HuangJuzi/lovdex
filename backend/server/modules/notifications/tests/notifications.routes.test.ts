import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { buildNotificationsRouter } from '@/modules/notifications/notifications.routes.js';

function makeSvc() {
  const rows = new Map<string, Record<string, unknown>>();
  rows.set('n1', { notification_id: 'n1', title: 'A', severity: 'warning', read_at: null });
  return {
    list: (o: { unreadOnly?: boolean }) => [...rows.values()].filter(r => !o.unreadOnly || !r.read_at),
    unreadCount: () => [...rows.values()].filter(r => !r.read_at).length,
    markRead: (id: string) => { const r = rows.get(id); if (!r) return null; r.read_at = 'now'; return r; },
    markAllRead: () => { for (const r of rows.values()) r.read_at = 'now'; },
    emit: () => ({}) as never,
  };
}

async function startServer(svc: unknown) {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', buildNotificationsRouter(svc as never));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('GET / 返回列表', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown[];
    assert.equal(body.length, 1);
  } finally { await close(); }
});

test('GET /unread-count 返回计数', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/unread-count`);
    const body = await res.json() as { unreadCount: number };
    assert.equal(body.unreadCount, 1);
  } finally { await close(); }
});

test('POST /:id/read 标记已读', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/n1/read`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally { await close(); }
});

test('POST /:id/read 不存在 → 404', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/nope/read`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally { await close(); }
});

test('POST /read-all 全部已读', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/read-all`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally { await close(); }
});
