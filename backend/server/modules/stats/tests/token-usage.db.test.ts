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

test('aggregateBuckets 按整数分桶聚合，并支持项目与模型过滤', () =>
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

    // makeEvent 的 output/cacheRead/cacheCreation 默认是 5/3/1
    const rowA = rows.find((r) => r.bucket_ts === bucketA && r.model === 'm-a');
    assert.ok(rowA, '第一个桶应只有 m-a 的 k1');
    assert.equal(rowA.tokens, 100 + 5 + 3 + 1);

    const rowB1 = rows.find((r) => r.bucket_ts === bucketB && r.model === 'm-a');
    const rowB2 = rows.find((r) => r.bucket_ts === bucketB && r.model === 'm-b');
    assert.equal(rowB1?.tokens, 50 + 5 + 3 + 1);
    assert.equal(rowB2?.tokens, 7 + 5 + 3 + 1);

    const filtered = tokenUsageDb.aggregateBuckets({
      from: bucketA,
      to: bucketB + BUCKET_MS,
      bucketMs: BUCKET_MS,
      projectPath: '/proj/b',
    });
    assert.equal(filtered.reduce((sum, r) => sum + r.tokens, 0), 7 + 5 + 3 + 1);

    const byModel = tokenUsageDb.aggregateBuckets({
      from: bucketA,
      to: bucketB + BUCKET_MS,
      bucketMs: BUCKET_MS,
      models: ['m-b'],
    });
    assert.ok(byModel.length > 0);
    assert.ok(byModel.every((r) => r.model === 'm-b'));
  }));
