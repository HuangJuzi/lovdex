import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';
import { buildStatsRouter } from '../stats.routes.js';
import type { TokenUsageQueryService } from '../services/token-usage-query.service.js';
import { MAX_RANGE_MS } from '../services/token-usage-query.service.js';

type Captured = { filter?: Record<string, unknown>; bucketMs?: number };

function buildTestApp(captured: Captured, timeseriesBody?: unknown) {
  const app = express();
  app.use(express.json());
  const query = {
    getTimeseries: (filter: Record<string, unknown>, bucketMs?: number) => {
      captured.filter = filter;
      captured.bucketMs = bucketMs;
      return timeseriesBody ?? { range: filter, bucketMs: bucketMs ?? 0, models: [], buckets: [], ingest: {} };
    },
    getSummary: (filter: Record<string, unknown>) => {
      captured.filter = filter;
      return { range: filter, byModel: [] };
    },
    listModels: () => [],
    getIngestStatus: () => ({ scanning: false, filesTotal: 0, filesDone: 0, eventsIndexed: 0, startedAt: null, lastScanAt: null }),
    triggerRefresh: () => undefined,
  } as unknown as TokenUsageQueryService;
  app.use('/api/stats', buildStatsRouter({ query }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    }
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'internal' } });
  });
  return app;
}

function listen(t: TestContext, captured: Captured, timeseriesBody?: unknown) {
  const server = buildTestApp(captured, timeseriesBody).listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return { port };
}

test('timeseries 透传 projectPath 与 from/to，并接受合法的 bucketMs', async (t) => {
  const captured: Captured = {};
  const { port } = listen(t, captured);
  const res = await fetch(
    `http://127.0.0.1:${port}/api/stats/token-usage/timeseries?projectPath=/p&from=1000&to=2000&bucketMs=300000`,
  );
  assert.equal(res.status, 200);
  assert.equal(captured.filter?.projectPath, '/p');
  assert.equal(captured.filter?.from, 1000);
  assert.equal(captured.filter?.to, 2000);
  assert.equal(captured.bucketMs, 300000);
});

test('非法 bucketMs 不报错，交给 service 回落', async (t) => {
  const captured: Captured = {};
  const { port } = listen(t, captured);
  const res = await fetch(`http://127.0.0.1:${port}/api/stats/token-usage/timeseries?bucketMs=12345`);
  assert.equal(res.status, 200);
  assert.equal(captured.bucketMs, undefined);
});

test('负 bucketMs 返回 400，且绝不落到 service（会撑爆 buildTimeseries）', async (t) => {
  const captured: Captured = {};
  const { port } = listen(t, captured);
  const res = await fetch(`http://127.0.0.1:${port}/api/stats/token-usage/timeseries?bucketMs=-60000`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'INVALID_QUERY_PARAMETER');
  assert.equal(captured.bucketMs, undefined);
  assert.equal(captured.filter, undefined);
});

test('超大 to 被夹到 MAX_RANGE_MS，请求正常返回而不是挂起进程', async (t) => {
  const captured: Captured = {};
  const { port } = listen(t, captured);
  const res = await fetch(
    `http://127.0.0.1:${port}/api/stats/token-usage/timeseries?from=0&to=1000000000000000000`,
  );
  assert.equal(res.status, 200);
  const filter = captured.filter as { from: number; to: number };
  assert.equal(filter.to, 1_000_000_000_000_000_000);
  assert.equal(filter.to - filter.from, MAX_RANGE_MS);
});

test('非数字 from/to 返回 400 INVALID_QUERY_PARAMETER', async (t) => {
  const { port } = listen(t, {});
  const res = await fetch(`http://127.0.0.1:${port}/api/stats/token-usage/timeseries?from=abc`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'INVALID_QUERY_PARAMETER');
});

test('model 可重复传参，收敛成数组', async (t) => {
  const captured: Captured = {};
  const { port } = listen(t, captured);
  await fetch(`http://127.0.0.1:${port}/api/stats/token-usage/summary?model=m-a&model=m-b`);
  assert.deepEqual(captured.filter?.models, ['m-a', 'm-b']);
});

test('timeseries 响应里四类分量各自成列，不被折叠成单一总量', async (t) => {
  // 口径切换在前端本地做，所以 HTTP 边界上必须拿得到四个分量；
  // 这条测试钉的是线上契约（cache_read 主导时尤其不能只剩一个数）。
  const { port } = listen(t, {}, {
    range: { from: 0, to: 60_000 },
    bucketMs: 60_000,
    models: ['m-a'],
    buckets: [{ ts: 0, byModel: { 'm-a': { input: 10, output: 1, cacheRead: 1000, cacheCreation: 0 } } }],
    ingest: {},
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/stats/token-usage/timeseries`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { buckets: { byModel: Record<string, unknown> }[] };
  assert.deepEqual(body.buckets[0].byModel['m-a'], { input: 10, output: 1, cacheRead: 1000, cacheCreation: 0 });
  assert.ok(!('total' in body.buckets[0]));
});

test('ingest-status 返回采集状态并触发一次刷新检查', async (t) => {
  const { port } = listen(t, {});
  const res = await fetch(`http://127.0.0.1:${port}/api/stats/token-usage/ingest-status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { scanning: boolean };
  assert.equal(body.scanning, false);
});
