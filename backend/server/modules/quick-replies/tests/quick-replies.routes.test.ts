import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';

import { QUICK_REPLIES_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { AppError } from '@/shared/utils.js';

import { createQuickRepliesDb, type QuickReplyRow } from '@/modules/quick-replies/quick-replies.db.js';
import { createQuickRepliesService } from '@/modules/quick-replies/quick-replies.service.js';
import { buildQuickRepliesRouter } from '@/modules/quick-replies/quick-replies.routes.js';

async function startServer() {
  const db = new Database(':memory:');
  db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL);
  const service = createQuickRepliesService(createQuickRepliesDb(db));

  const app = express();
  app.use(express.json());
  app.use('/api/quick-replies', buildQuickRepliesRouter(service));
  // 复刻 server/index.js 末尾的全局错误中间件，否则 AppError 会退化成 express
  // 默认的 500 页面，测不到 code/statusCode。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('GET / 空库返回空数组', async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/api/quick-replies`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [] });
  } finally {
    await close();
  }
});

test('POST / 建一条后 GET 能看到，列为 snake_case', async () => {
  const { base, close } = await startServer();
  try {
    const created = await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '继续' }),
    });
    assert.equal(created.status, 201);
    const row = await created.json() as QuickReplyRow;
    assert.equal(row.content, '继续');
    assert.equal(row.last_used_at, null);
    assert.ok(row.quick_reply_id);

    const listed = await (await fetch(`${base}/api/quick-replies`)).json() as { items: QuickReplyRow[] };
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].quick_reply_id, row.quick_reply_id);
  } finally {
    await close();
  }
});

test('POST / 空内容与重复内容分别返回 400 / 409', async () => {
  const { base, close } = await startServer();
  try {
    const post = (content: string) => fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    const empty = await post('   ');
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { error: { code: string } }).error.code, 'QUICK_REPLY_EMPTY');

    await post('继续');
    const dup = await post('继续');
    assert.equal(dup.status, 409);
    assert.equal(((await dup.json()) as { error: { code: string } }).error.code, 'QUICK_REPLY_DUPLICATE');
  } finally {
    await close();
  }
});

test('PUT /:id 改正文，不存在的 id 返回 404', async () => {
  const { base, close } = await startServer();
  try {
    const created = await (await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '旧' }),
    })).json() as QuickReplyRow;

    const updated = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '新' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as QuickReplyRow).content, '新');

    const missing = await fetch(`${base}/api/quick-replies/nope`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '新' }),
    });
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'QUICK_REPLY_NOT_FOUND');
  } finally {
    await close();
  }
});

test('DELETE /:id 删掉，再删返回 404', async () => {
  const { base, close } = await startServer();
  try {
    const created = await (await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '待删' }),
    })).json() as QuickReplyRow;

    const first = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { success: true });

    const second = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}`, { method: 'DELETE' });
    assert.equal(second.status, 404);
  } finally {
    await close();
  }
});

test('POST /:id/use 刷新 last_used_at，不存在返回 404', async () => {
  const { base, close } = await startServer();
  try {
    const created = await (await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '继续' }),
    })).json() as QuickReplyRow;

    const used = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}/use`, { method: 'POST' });
    assert.equal(used.status, 200);
    assert.notEqual(((await used.json()) as QuickReplyRow).last_used_at, null);

    const missing = await fetch(`${base}/api/quick-replies/nope/use`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});
