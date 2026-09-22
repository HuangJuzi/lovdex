import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  tokenUsageDb,
} from '@/modules/database/index.js';
import type { TokenUsageEvent } from '@/shared/types.js';

/**
 * Runs the test body against a throwaway database file.
 *
 * `connection.ts` only honors DATABASE_PATH inside the node:test runner, and it
 * falls back to the production `database.path` from app.config.json when the env
 * var is absent — so the override MUST be set explicitly here. Without it these
 * tests would insert rows into the live database.
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'token-usage-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function makeEvent(overrides: Partial<TokenUsageEvent> = {}): TokenUsageEvent {
  return {
    source: 'claude',
    sessionId: 'sess-1',
    projectPath: '/proj/a',
    model: 'test-model',
    tsMs: 1_700_000_000_000,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheCreationTokens: 1,
    dedupeKey: 'claude:msg-1',
    ...overrides,
  };
}

test('token_usage_events 表由 INIT_SCHEMA_SQL 建出，含四列 token', () =>
  withIsolatedDatabase(async () => {
    const columns = getConnection()
      .prepare('PRAGMA table_info(token_usage_events)')
      .all() as { name: string }[];
    const names = columns.map((c) => c.name);
    for (const expected of [
      'source', 'session_id', 'project_path', 'model', 'ts_ms',
      'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'dedupe_key',
    ]) {
      assert.ok(names.includes(expected), `缺少列 ${expected}`);
    }
  }));

test('insertEvents 落库，且相同 dedupeKey 重复插入只保留一行', () =>
  withIsolatedDatabase(() => {
    const first = tokenUsageDb.insertEvents([makeEvent()]);
    assert.equal(first, 1);

    // 同一 dedupeKey 再插一次（模拟重复扫描），不应新增
    const second = tokenUsageDb.insertEvents([makeEvent()]);
    assert.equal(second, 0);
    assert.equal(tokenUsageDb.countEvents(), 1);
  }));

test('cursor 默认全零，setCursor 后可读回', () =>
  withIsolatedDatabase(() => {
    assert.deepEqual(tokenUsageDb.getCursor('claude', '/x.jsonl'), { byteOffset: 0, lastTsMs: 0 });

    tokenUsageDb.setCursor('claude', '/x.jsonl', { byteOffset: 123, lastTsMs: 456 });
    assert.deepEqual(tokenUsageDb.getCursor('claude', '/x.jsonl'), { byteOffset: 123, lastTsMs: 456 });

    // 覆盖写（允许回退，用于文件截断后重扫）
    tokenUsageDb.setCursor('claude', '/x.jsonl', { byteOffset: 0, lastTsMs: 0 });
    assert.deepEqual(tokenUsageDb.getCursor('claude', '/x.jsonl'), { byteOffset: 0, lastTsMs: 0 });
  }));

test('aggregateBuckets 按整数分桶聚合四类 token，并支持项目与模型过滤', () =>
  withIsolatedDatabase(() => {
    const BUCKET_MS = 60_000;
    // 1_700_000_000_000 不是整分钟；先算出它的桶起点，再把 k2/k3 放到下一个桶，
    // 这样每个桶里有什么是确定的，断言才有意义。
    const bucketA = Math.floor(1_700_000_000_000 / BUCKET_MS) * BUCKET_MS;
    const bucketB = bucketA + BUCKET_MS;

    tokenUsageDb.insertEvents([
      makeEvent({ dedupeKey: 'k1', tsMs: 1_700_000_000_000, model: 'm-a', inputTokens: 100 }),
      makeEvent({ dedupeKey: 'k2', tsMs: bucketB + 1000, model: 'm-a', inputTokens: 50 }),
      makeEvent({ dedupeKey: 'k3', tsMs: bucketB + 1000, model: 'm-b', inputTokens: 7, projectPath: '/proj/b' }),
    ]);

    const rows = tokenUsageDb.aggregateBuckets({
      from: bucketA,
      to: bucketB + BUCKET_MS,
      bucketMs: BUCKET_MS,
    });

    // makeEvent 的 output/cacheRead/cacheCreation 默认是 5/3/1。
    // 整行 deepEqual：顺带钉死「不再有 tokens 这种合并列」。
    const rowA = rows.find((r) => r.bucket_ts === bucketA && r.model === 'm-a');
    assert.ok(rowA, '第一个桶应只有 m-a 的 k1');
    assert.deepEqual(rowA, {
      bucket_ts: bucketA,
      model: 'm-a',
      input_tokens: 100,
      output_tokens: 5,
      cache_read_tokens: 3,
      cache_creation_tokens: 1,
    });

    const rowB1 = rows.find((r) => r.bucket_ts === bucketB && r.model === 'm-a');
    const rowB2 = rows.find((r) => r.bucket_ts === bucketB && r.model === 'm-b');
    assert.equal(rowB1?.input_tokens, 50);
    assert.equal(rowB2?.input_tokens, 7);
    assert.equal(rowB2?.output_tokens, 5);

    const filtered = tokenUsageDb.aggregateBuckets({
      from: bucketA,
      to: bucketB + BUCKET_MS,
      bucketMs: BUCKET_MS,
      projectPath: '/proj/b',
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].input_tokens, 7);
    assert.equal(filtered[0].cache_read_tokens, 3);

    const byModel = tokenUsageDb.aggregateBuckets({
      from: bucketA,
      to: bucketB + BUCKET_MS,
      bucketMs: BUCKET_MS,
      models: ['m-b'],
    });
    assert.ok(byModel.length > 0);
    assert.ok(byModel.every((r) => r.model === 'm-b'));
  }));

test('aggregateBuckets 在 cache_read 主导时仍分开返回四类，不折叠成单一总量', () =>
  withIsolatedDatabase(() => {
    const BUCKET_MS = 60_000;
    const bucket = Math.floor(1_700_000_000_000 / BUCKET_MS) * BUCKET_MS;

    // 真实数据的形态：cache_read 74.2%、output 0.3%。单一总量会被 cache_read 淹没，
    // 把「干了多少活」藏起来 —— 四列必须各自可见。
    tokenUsageDb.insertEvents([
      makeEvent({
        dedupeKey: 'dominant',
        tsMs: bucket + 1000,
        model: 'm-dominant',
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 1000,
        cacheCreationTokens: 0,
      }),
    ]);

    const rows = tokenUsageDb.aggregateBuckets({ from: bucket, to: bucket + BUCKET_MS, bucketMs: BUCKET_MS });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cache_read_tokens, 1000);
    assert.equal(rows[0].input_tokens, 10);
    assert.equal(rows[0].output_tokens, 1);
    assert.equal(rows[0].cache_creation_tokens, 0);
    assert.ok(!('tokens' in rows[0]), '不应再有合并后的单一 tokens 列');
  }));

test('aggregateByModel 返回四类分量 / 会话数 / 最近使用，并按全部 token 降序', () =>
  withIsolatedDatabase(() => {
    const bucket = Math.floor(1_700_000_000_000 / 60_000) * 60_000;

    tokenUsageDb.insertEvents([
      // m-cache 全部 token = 1000，但 output 只有 1；m-out 全部 token = 900 且全是 output。
      // 若按 output 或 input 排序，m-out 会跑到前面 —— 这条断言就是为了钉死「按全部 token 排」。
      makeEvent({
        dedupeKey: 'c1', tsMs: bucket + 1000, model: 'm-cache',
        inputTokens: 0, outputTokens: 1, cacheReadTokens: 999, cacheCreationTokens: 0,
        sessionId: 'sess-1',
      }),
      makeEvent({
        dedupeKey: 'c2', tsMs: bucket + 2000, model: 'm-cache',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        sessionId: 'sess-1',
      }),
      makeEvent({
        dedupeKey: 'o1', tsMs: bucket + 3000, model: 'm-out',
        inputTokens: 0, outputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 0,
        sessionId: 'sess-2',
      }),
      makeEvent({
        dedupeKey: 'o2', tsMs: bucket + 4000, model: 'm-out',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        sessionId: 'sess-3',
      }),
    ]);

    const rows = tokenUsageDb.aggregateByModel({ from: bucket, to: bucket + 60_000 });

    assert.deepEqual(rows.map((r) => r.model), ['m-cache', 'm-out']);
    assert.deepEqual(rows[0], {
      model: 'm-cache',
      input_tokens: 0,
      output_tokens: 1,
      cache_read_tokens: 999,
      cache_creation_tokens: 0,
      sessions: 1,
      last_used_at: bucket + 2000,
    });
    // 去重会话数按 session_id 去重，不是行数
    assert.equal(rows[1].sessions, 2);
    assert.equal(rows[1].output_tokens, 900);

    // listModels 复用同一聚合，排序一致
    assert.deepEqual(tokenUsageDb.listModels({ from: bucket, to: bucket + 60_000 }).map((r) => r.model), ['m-cache', 'm-out']);
  }));

test('aggregateMinutePeaks 在 1 分钟粒度上给出四档峰值', () =>
  withIsolatedDatabase(() => {
    const minuteA = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
    const minuteB = minuteA + 60_000;

    tokenUsageDb.insertEvents([
      // m-a 第 1 分钟：all=100 / new=100 / output=10
      makeEvent({
        dedupeKey: 'p1', tsMs: minuteA + 1000, model: 'm-a',
        inputTokens: 90, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0,
      }),
      // m-a 第 2 分钟：同一分钟内两条 cache_read 相加成 all=2000，比任何单条都大
      makeEvent({
        dedupeKey: 'p2', tsMs: minuteB + 1000, model: 'm-a',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 1200, cacheCreationTokens: 0,
      }),
      makeEvent({
        dedupeKey: 'p3', tsMs: minuteB + 2000, model: 'm-a',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 800, cacheCreationTokens: 0,
      }),
      // m-b：all=307 / new=7 / output=7 —— 三档各不相同，能区分列是否接错
      makeEvent({
        dedupeKey: 'p4', tsMs: minuteB + 3000, model: 'm-b',
        inputTokens: 0, outputTokens: 7, cacheReadTokens: 300, cacheCreationTokens: 0,
      }),
    ]);

    const peaks = tokenUsageDb.aggregateMinutePeaks({ from: minuteA, to: minuteB + 60_000 });

    const a = peaks.find((p) => p.model === 'm-a');
    assert.deepEqual(a, { model: 'm-a', peak_all: 2000, peak_new: 100, peak_input: 90, peak_output: 10 });
    const b = peaks.find((p) => p.model === 'm-b');
    assert.deepEqual(b, { model: 'm-b', peak_all: 307, peak_new: 7, peak_input: 0, peak_output: 7 });
    assert.ok(peaks.every((p) => !('peak' in p)), '不应再有合并后的单一 peak 列');
  }));

test('区间内无事件时聚合返回空数组', () =>
  withIsolatedDatabase(() => {
    const bucket = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
    assert.deepEqual(tokenUsageDb.aggregateBuckets({ from: bucket, to: bucket + 60_000, bucketMs: 60_000 }), []);
    assert.deepEqual(tokenUsageDb.aggregateByModel({ from: bucket, to: bucket + 60_000 }), []);
    assert.deepEqual(tokenUsageDb.aggregateMinutePeaks({ from: bucket, to: bucket + 60_000 }), []);
  }));
