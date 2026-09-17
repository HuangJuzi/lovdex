# Token 用量统计页（TPM 按模型拆分）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建一条 transcript → SQLite 的 token 用量采集管道，并在此之上做一个按模型拆分 TPM 时间序列的 `/stats` 页面。

**Architecture:** Lovdex 库里没有任何 token 数据，全部用量只存在于 provider transcript。因此先用一个采集引擎把 `~/.claude/projects/**/*.jsonl`、`~/.codex/sessions/**/*.jsonl`、`~/.local/share/opencode/opencode.db` 解析成 `token_usage_events` 行（`dedupe_key` UNIQUE 保证幂等），再用纯整数分桶 SQL 聚合成时间序列。前端新 `/stats` 页用卡片网格承载 recharts 图表，便于后续追加统计卡片。

**Tech Stack:** 后端 Express 4 + better-sqlite3 + TypeScript（`@/` → `server/`）；前端 React 18 + Vite + Tailwind + recharts 3；测试用 `node:test`。

**Spec:** `docs/superpowers/specs/2026-09-17-token-usage-stats-design.md`

---

## 关键约定（每个 Task 都要遵守）

**测试命令**（仓库没有 npm test 脚本，必须显式指定文件）：

```bash
# 后端（在 backend/ 下）
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/<name>.test.ts

# 前端（在 web/ 下；必须先清掉全局的 TSX_TSCONFIG_PATH，否则 tsx 会加载错的 tsconfig 而崩溃）
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/<name>.test.ts
```

**⚠️ 任何碰数据库的测试都必须显式隔离，否则会写进生产库。**

`connection.ts:37` 的条件是 `NODE_TEST_CONTEXT && DATABASE_PATH` —— **两个都要**。
`node --test` 只设置前者，`DATABASE_PATH` 是空的，于是 `resolveDatabasePath()` 会回落到
`app.config.json` 的 `database.path`，也就是正在运行的**生产库** `~/.lovdex/data/new-auth.db`。
「跑 `--test` 就自动隔离」是错的。

每个碰 DB 的测试文件都要复制仓库既有的 `withIsolatedDatabase` 辅助函数
（原版见 `backend/server/modules/database/repositories/tests/operator-audit.db.test.ts:11-33`；
仓库没有共享导出版本，复制是既有惯例）：

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

/** 在一次性临时库上跑测试体。不设 DATABASE_PATH 会打到生产库。 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'lovdex-test-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
```

用法：`test('...', async () => { await withIsolatedDatabase(async () => { ...断言... }); });`

**SQLite 分桶必须用 `CAST(? AS INTEGER)`。** better-sqlite3 把 JS number 绑成 REAL，
`(ts_ms / ?) * ?` 会做浮点除法并原样还原，**静默地不分桶**（每条事件各自成组，不报错）。
字面量 `60000` 不受影响（SQLite 视其为整数），但任何参数化的桶大小都必须 CAST。

**验收基线**：`npm run typecheck` 与 `npm run lint` 在改动前**就不是干净的**（后端约 11 个 tsc 错误 / 44 个 lint 错误，均与本功能无关）。验收标准是**零新增**，不是零错误。

**提交信息**：禁止添加 `Co-Authored-By: Claude` 署名行。

**四列 token 语义**（贯穿全计划，不要改）：`input_tokens` 是**不含缓存**的新增输入；
`总 token = input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens`。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `backend/server/shared/types.ts` | 追加 `TokenUsageEvent` / `TokenUsageRow`（放共享层，避免 database 模块反向依赖 stats 模块） |
| `backend/server/modules/database/schema.ts` | 追加两张表的 DDL 并拼进 `INIT_SCHEMA_SQL` |
| `backend/server/modules/database/repositories/token-usage.db.ts` | 插入 + cursor + 聚合 SQL |
| `backend/server/modules/database/index.ts` | 导出 `tokenUsageDb` |
| `backend/server/modules/stats/services/token-usage-parsers.ts` | 三个 provider 的纯解析函数（无 IO，易测） |
| `backend/server/modules/stats/services/token-usage-ingest.service.ts` | 文件遍历 + 增量读取 + 调度 |
| `backend/server/modules/stats/services/token-usage-query.service.ts` | 分桶选择 + 补零 + summary 组装 |
| `backend/server/modules/stats/stats.routes.ts` | 4 个 GET 端点 |
| `backend/server/modules/stats/index.ts` | barrel |
| `backend/server/index.js` | 挂载路由 + 启动采集 |
| `web/src/components/stats/format.ts` | 纯格式化/分桶工具 |
| `web/src/components/stats/useTokenStats.ts` | 数据层（拉取 + 轮询） |
| `web/src/components/stats/StatsPage.tsx` | 页面骨架（卡片网格） |
| `web/src/components/stats/widgets/TpmChartCard.tsx` | recharts 堆叠面积图 |
| `web/src/components/stats/widgets/ModelRankCard.tsx` | 模型排行表 |
| `web/src/utils/api.js` | 追加 `stats` 命名空间 |
| `web/src/App.tsx` | 追加 `/stats` 路由 |
| `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx` | 追加「统计」导航按钮（桌面 + 移动两处） |
| `web/src/i18n/locales/en/sidebar.json` | 追加 `tooltips.stats` |

---

## Task 1: 类型 + 建表 + repository

**Files:**
- Modify: `backend/server/shared/types.ts`（追加类型）
- Modify: `backend/server/modules/database/schema.ts`（追加两张表 + 拼进 `INIT_SCHEMA_SQL`）
- Create: `backend/server/modules/database/repositories/token-usage.db.ts`
- Modify: `backend/server/modules/database/index.ts`（加 export）
- Test: `backend/server/modules/stats/tests/token-usage.db.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/stats/tests/token-usage.db.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeDatabase, getConnection } from '@/modules/database/index.js';
import { tokenUsageDb } from '@/modules/database/repositories/token-usage.db.js';
import type { TokenUsageEvent } from '@/shared/types.js';

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

test('token_usage_events 表由 INIT_SCHEMA_SQL 建出，含四列 token', () => {
  initializeDatabase();
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
});

test('insertEvents 落库，且相同 dedupeKey 重复插入只保留一行', () => {
  initializeDatabase();
  const first = tokenUsageDb.insertEvents([makeEvent()]);
  assert.equal(first, 1);

  // 同一 dedupeKey 再插一次（模拟重复扫描），不应新增
  const second = tokenUsageDb.insertEvents([makeEvent()]);
  assert.equal(second, 0);
  assert.equal(tokenUsageDb.countEvents(), 1);
});

test('cursor 默认全零，setCursor 后可读回', () => {
  initializeDatabase();
  assert.deepEqual(tokenUsageDb.getCursor('claude', '/x.jsonl'), { byteOffset: 0, lastTsMs: 0 });

  tokenUsageDb.setCursor('claude', '/x.jsonl', { byteOffset: 123, lastTsMs: 456 });
  assert.deepEqual(tokenUsageDb.getCursor('claude', '/x.jsonl'), { byteOffset: 123, lastTsMs: 456 });

  // 覆盖写（允许回退，用于文件截断后重扫）
  tokenUsageDb.setCursor('claude', '/x.jsonl', { byteOffset: 0, lastTsMs: 0 });
  assert.deepEqual(tokenUsageDb.getCursor('claude', '/x.jsonl'), { byteOffset: 0, lastTsMs: 0 });
});

test('aggregateBuckets 按整数分桶聚合，并支持项目与模型过滤', () => {
  initializeDatabase();
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
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage.db.test.ts
```
Expected: FAIL —— 报 `Cannot find module '@/modules/database/repositories/token-usage.db.js'`（或 `no such table: token_usage_events`）。

- [ ] **Step 3: 追加共享类型**

在 `backend/server/shared/types.ts` 末尾追加：

```ts
// ---------------------------
//----------------- TOKEN USAGE STATS TYPES ------------
/** 采集来源；Qoder 只有 credits 没有 token，不参与统计。 */
export type TokenUsageSource = 'claude' | 'codex' | 'opencode';

/**
 * 一条归一化后的用量事件（一行 = 一条 assistant 消息 / 一个累计值差分区间）。
 *
 * 四列 token 的统一语义：`inputTokens` 是**不含缓存**的新增输入，
 * 总 token = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens。
 */
export type TokenUsageEvent = {
  source: TokenUsageSource;
  sessionId: string | null;
  /** 解析自 transcript 里的 cwd；解析不到为 null。 */
  projectPath: string | null;
  model: string;
  /** epoch 毫秒。整数存储，分桶时用整数除法，避免 SQLite 时区问题。 */
  tsMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 幂等键，见 token-usage-parsers.ts 的 dedupeKey 规则。 */
  dedupeKey: string;
};

/** `token_usage_events` 的数据库行形状。 */
export type TokenUsageRow = {
  id: number;
  source: TokenUsageSource;
  session_id: string | null;
  project_path: string | null;
  model: string;
  ts_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  dedupe_key: string;
};
```

- [ ] **Step 4: 追加表 DDL**

在 `backend/server/modules/database/schema.ts` 中，紧跟在 `OPERATOR_EXEC_AUDIT_TABLE_SCHEMA_SQL`（`schema.ts:245-260`）之后追加：

```ts
export const TOKEN_USAGE_EVENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS token_usage_events (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    source                TEXT    NOT NULL,
    session_id            TEXT,
    project_path          TEXT,
    model                 TEXT    NOT NULL,
    ts_ms                 INTEGER NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    dedupe_key            TEXT    NOT NULL UNIQUE
);
`;

export const TOKEN_INGEST_CURSOR_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS token_ingest_cursor (
    source      TEXT    NOT NULL,
    file_path   TEXT    NOT NULL,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    last_ts_ms  INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT,
    PRIMARY KEY (source, file_path)
);
`;
```

然后在 `INIT_SCHEMA_SQL` 模板串里，`${OPERATOR_EXEC_AUDIT_TABLE_SCHEMA_SQL}` 那一行之后追加（索引也放这里，与其他表一致）：

```ts
${TOKEN_USAGE_EVENTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_tue_ts ON token_usage_events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_tue_project_ts ON token_usage_events(project_path, ts_ms);
CREATE INDEX IF NOT EXISTS idx_tue_model_ts ON token_usage_events(model, ts_ms);

${TOKEN_INGEST_CURSOR_TABLE_SCHEMA_SQL}
```

> 两张表都是新增表 + `CREATE TABLE IF NOT EXISTS`，**不需要**动 `migrations.ts`（与 `operator_exec_audit` 同模式）。

- [ ] **Step 5: 写 repository**

创建 `backend/server/modules/database/repositories/token-usage.db.ts`：

```ts
import { getConnection } from '@/modules/database/connection.js';
import type { TokenUsageEvent } from '@/shared/types.js';

export type TokenUsageCursor = { byteOffset: number; lastTsMs: number };

/** 一个 (时间桶, 模型) 的聚合结果。 */
export type BucketAggregateRow = { bucket_ts: number; model: string; tokens: number };

/** 一个模型的区间聚合结果。 */
export type ModelAggregateRow = {
  model: string;
  tokens: number;
  sessions: number;
  last_used_at: number;
};

/** 一个模型在 1 分钟粒度上的峰值。 */
export type ModelPeakRow = { model: string; peak: number };

type AggregateFilter = {
  from: number;
  to: number;
  projectPath?: string;
  models?: string[];
};

/**
 * 拼出 `token_usage_events` 查询的 WHERE 子句与绑定值。
 *
 * `models` 为空数组时视为「不过滤」（而不是「匹配空集合」）——调用方未传筛选条件时
 * 就是这种情况。占位符按传入模型数动态拼接，沿用 tasks.db.ts 的动态 WHERE 惯例。
 */
function buildFilter(filter: AggregateFilter): { where: string; values: unknown[] } {
  const clauses = ['ts_ms >= ?', 'ts_ms < ?'];
  const values: unknown[] = [filter.from, filter.to];
  if (filter.projectPath) {
    clauses.push('project_path = ?');
    values.push(filter.projectPath);
  }
  if (filter.models && filter.models.length > 0) {
    clauses.push(`model IN (${filter.models.map(() => '?').join(', ')})`);
    values.push(...filter.models);
  }
  return { where: clauses.join(' AND '), values };
}

export const tokenUsageDb = {
  /** 批量插入；返回真正新增的行数（`INSERT OR IGNORE` 会跳过重复 dedupeKey）。 */
  insertEvents(events: TokenUsageEvent[]): number {
    if (events.length === 0) {
      return 0;
    }
    const db = getConnection();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO token_usage_events
        (source, session_id, project_path, model, ts_ms,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const runAll = db.transaction((rows: TokenUsageEvent[]) => {
      for (const e of rows) {
        const info = stmt.run(
          e.source, e.sessionId, e.projectPath, e.model, e.tsMs,
          e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.dedupeKey,
        );
        inserted += info.changes;
      }
    });
    runAll(events);
    return inserted;
  },

  countEvents(): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM token_usage_events')
      .get() as { count: number };
    return row.count;
  },

  getCursor(source: string, filePath: string): TokenUsageCursor {
    const row = getConnection()
      .prepare('SELECT byte_offset, last_ts_ms FROM token_ingest_cursor WHERE source = ? AND file_path = ?')
      .get(source, filePath) as { byte_offset: number; last_ts_ms: number } | undefined;
    return { byteOffset: row?.byte_offset ?? 0, lastTsMs: row?.last_ts_ms ?? 0 };
  },

  /** 覆盖写 cursor。刻意不用 MAX()：文件被截断时需要允许 offset 回退到 0。 */
  setCursor(source: string, filePath: string, cursor: Partial<TokenUsageCursor>): void {
    const current = tokenUsageDb.getCursor(source, filePath);
    const byteOffset = cursor.byteOffset ?? current.byteOffset;
    const lastTsMs = cursor.lastTsMs ?? current.lastTsMs;
    getConnection()
      .prepare(`
        INSERT INTO token_ingest_cursor (source, file_path, byte_offset, last_ts_ms, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source, file_path) DO UPDATE SET
          byte_offset = excluded.byte_offset,
          last_ts_ms = excluded.last_ts_ms,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(source, filePath, byteOffset, lastTsMs);
  },

  /** 按 (时间桶, 模型) 聚合。分桶用整数除法，与 SQLite 时区无关。 */
  aggregateBuckets(filter: AggregateFilter & { bucketMs: number }): BucketAggregateRow[] {
    const { where, values } = buildFilter(filter);
    return getConnection()
      .prepare(`
        SELECT (ts_ms / ?) * ? AS bucket_ts,
               model,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
        FROM token_usage_events
        WHERE ${where}
        GROUP BY bucket_ts, model
        ORDER BY bucket_ts ASC
      `)
      .all(filter.bucketMs, filter.bucketMs, ...values) as BucketAggregateRow[];
  },

  /** 按模型聚合区间总量、去重会话数与最近使用时间。 */
  aggregateByModel(filter: AggregateFilter): ModelAggregateRow[] {
    const { where, values } = buildFilter(filter);
    return getConnection()
      .prepare(`
        SELECT model,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
               COUNT(DISTINCT session_id) AS sessions,
               MAX(ts_ms) AS last_used_at
        FROM token_usage_events
        WHERE ${where}
        GROUP BY model
        ORDER BY tokens DESC
      `)
      .all(...values) as ModelAggregateRow[];
  },

  /** 每个模型在 1 分钟粒度上的峰值。必须独立于响应里的 bucketMs 计算。 */
  aggregateMinutePeaks(filter: AggregateFilter): ModelPeakRow[] {
    const { where, values } = buildFilter(filter);
    return getConnection()
      .prepare(`
        SELECT model, MAX(bucket_tokens) AS peak
        FROM (
          SELECT model,
                 (ts_ms / 60000) * 60000 AS bucket_ts,
                 SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS bucket_tokens
          FROM token_usage_events
          WHERE ${where}
          GROUP BY bucket_ts, model
        )
        GROUP BY model
      `)
      .all(...values) as ModelPeakRow[];
  },

  /** 去重模型列表（供前端筛选器），按用量降序。 */
  listModels(filter: { from: number; to: number; projectPath?: string }): ModelAggregateRow[] {
    return tokenUsageDb.aggregateByModel(filter);
  },
};
```

- [ ] **Step 6: 导出 repository**

在 `backend/server/modules/database/index.ts` 的 `export { tasksDb } ...` 之后追加：

```ts
export { tokenUsageDb } from '@/modules/database/repositories/token-usage.db.js';
```

- [ ] **Step 7: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage.db.test.ts
```
Expected: PASS，4 个测试全绿。

- [ ] **Step 8: 提交**

```bash
git add backend/server/shared/types.ts backend/server/modules/database/schema.ts \
        backend/server/modules/database/repositories/token-usage.db.ts \
        backend/server/modules/database/index.ts \
        backend/server/modules/stats/tests/token-usage.db.test.ts
git commit -m "feat(stats): token_usage_events 表 + repository（幂等插入 / cursor / 分桶聚合）"
```

---

## Task 2: Claude 行解析器

**Files:**
- Create: `backend/server/modules/stats/services/token-usage-parsers.ts`
- Test: `backend/server/modules/stats/tests/token-usage-parsers-claude.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/stats/tests/token-usage-parsers-claude.test.ts`。这里的 fixture 是从本机真实 transcript 摘录的三种 usage 形状：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeLine, readUsageNumber } from '../services/token-usage-parsers.js';

/** 形状 A：仅 input/output（第三方模型经 llm-proxy 转发时的形状）。 */
const SHAPE_A = JSON.stringify({
  type: 'assistant',
  cwd: '/mnt/b/workdir/github/lovdex',
  sessionId: '631e2b8a-240d-4dfe-bcf3-91a577a1a1ea',
  timestamp: '2026-08-18T11:05:29.539Z',
  isSidechain: false,
  message: {
    id: 'msg_01f86402-aaf5-436f-ab18-fb6c65d3b2b3',
    model: 'DeepSeek-V4-Flash-0731',
    usage: { output_tokens: 0, input_tokens: 53478 },
  },
});

/** 形状 B：含 cache_read，无 cache_creation。 */
const SHAPE_B = JSON.stringify({
  type: 'assistant',
  cwd: '/mnt/b/workdir/github/lovdex',
  sessionId: 'sess-b',
  timestamp: '2026-08-18T12:00:00.000Z',
  message: {
    id: 'msg_b',
    model: 'claude-opus-4-8',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
  },
});

/** 形状 C：全套字段（官方 API 形状）。 */
const SHAPE_C = JSON.stringify({
  type: 'assistant',
  cwd: '/mnt/b/workdir/github/lovdex',
  sessionId: 'sess-c',
  timestamp: '2026-08-18T13:00:00.000Z',
  message: {
    id: 'msg_c',
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 10, output_tokens: 2,
      cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
      service_tier: 'standard', inference_geo: 'not_available', iterations: [],
    },
  },
});

test('readUsageNumber 把缺失/负数/字符串/NaN 一律收敛成非负整数', () => {
  assert.equal(readUsageNumber(undefined), 0);
  assert.equal(readUsageNumber(null), 0);
  assert.equal(readUsageNumber(-5), 0);
  assert.equal(readUsageNumber('42'), 42);
  assert.equal(readUsageNumber('abc'), 0);
  assert.equal(readUsageNumber(Number.NaN), 0);
  assert.equal(readUsageNumber(7.9), 7);
});

test('形状 A：input 不含缓存，四列分别落位', () => {
  const event = parseClaudeLine(JSON.parse(SHAPE_A));
  assert.ok(event);
  assert.equal(event.source, 'claude');
  assert.equal(event.model, 'DeepSeek-V4-Flash-0731');
  assert.equal(event.sessionId, '631e2b8a-240d-4dfe-bcf3-91a577a1a1ea');
  assert.equal(event.projectPath, '/mnt/b/workdir/github/lovdex');
  assert.equal(event.tsMs, Date.parse('2026-08-18T11:05:29.539Z'));
  assert.equal(event.inputTokens, 53478);
  assert.equal(event.outputTokens, 0);
  assert.equal(event.cacheReadTokens, 0);
  assert.equal(event.cacheCreationTokens, 0);
  assert.equal(event.dedupeKey, 'claude:msg_01f86402-aaf5-436f-ab18-fb6c65d3b2b3');
});

test('形状 B：cache_read 落在 cacheReadTokens，不混进 inputTokens', () => {
  const event = parseClaudeLine(JSON.parse(SHAPE_B));
  assert.ok(event);
  assert.equal(event.inputTokens, 100);
  assert.equal(event.outputTokens, 20);
  assert.equal(event.cacheReadTokens, 900);
  assert.equal(event.cacheCreationTokens, 0);
});

test('形状 C：四个字段齐全时全部落位，忽略未知字段', () => {
  const event = parseClaudeLine(JSON.parse(SHAPE_C));
  assert.ok(event);
  assert.equal(event.inputTokens, 10);
  assert.equal(event.outputTokens, 2);
  assert.equal(event.cacheReadTokens, 30);
  assert.equal(event.cacheCreationTokens, 40);
});

test('非 assistant / 无 usage / <synthetic> / 缺 id / 缺时间戳 都返回 null', () => {
  assert.equal(parseClaudeLine(null), null);
  assert.equal(parseClaudeLine({ type: 'user', message: { usage: { input_tokens: 1 } } }), null);
  assert.equal(parseClaudeLine({ type: 'assistant', message: {} }), null);
  assert.equal(
    parseClaudeLine({
      type: 'assistant', timestamp: '2026-08-18T11:05:29.539Z',
      message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 1 } },
    }),
    null,
  );
  assert.equal(
    parseClaudeLine({
      type: 'assistant', timestamp: '2026-08-18T11:05:29.539Z',
      message: { model: 'm', usage: { input_tokens: 1 } },
    }),
    null,
  );
  assert.equal(
    parseClaudeLine({
      type: 'assistant', message: { id: 'm', model: 'm', usage: { input_tokens: 1 } },
    }),
    null,
  );
});

test('缺 cwd 时 projectPath 为 null，但事件仍然产出', () => {
  const event = parseClaudeLine({
    type: 'assistant', timestamp: '2026-08-18T11:05:29.539Z',
    message: { id: 'm', model: 'm', usage: { input_tokens: 1 } },
  });
  assert.ok(event);
  assert.equal(event.projectPath, null);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-parsers-claude.test.ts
```
Expected: FAIL —— `Cannot find module '../services/token-usage-parsers.js'`。

- [ ] **Step 3: 实现解析器**

创建 `backend/server/modules/stats/services/token-usage-parsers.ts`：

```ts
import type { TokenUsageEvent } from '@/shared/types.js';

/**
 * 把 Anthropic 的 usage 字段收敛成非负整数。
 *
 * 真实 transcript 里同一字段可能是 number / string / null / 缺失，历史版本还出现过
 * `Number.NaN`，因此这里做一次性兜底，调用方不必再判类型。
 */
export function readUsageNumber(value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : 0;
}

/** 解析 ISO 时间戳为 epoch 毫秒；无法解析返回 null。 */
export function parseIsoToMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 从对象里安全读取字符串字段，空串视为缺失。 */
function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 解析 Claude transcript 的一行。
 *
 * 返回 null 表示这行不产生用量事件：非 assistant 条目、无 usage、`<synthetic>` 模型
 * （非真实 API 调用）、或缺 `message.id` / `timestamp`（无法定位与去重）。
 *
 * `dedupeKey` 用 `message.id`——同一个 message 可能同时出现在主 transcript 与
 * `subagents/agent-*.jsonl` 里，用 id 去重可自动处理这种重叠，不必依赖文件布局假设。
 */
export function parseClaudeLine(raw: unknown): TokenUsageEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.type !== 'assistant') {
    return null;
  }
  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return null;
  }
  const usage = (message as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const model = readString(message, 'model');
  if (!model || model === '<synthetic>') {
    return null;
  }
  const messageId = readString(message, 'id');
  const tsMs = parseIsoToMs(entry.timestamp);
  if (!messageId || tsMs === null) {
    return null;
  }

  const usageRecord = usage as Record<string, unknown>;
  return {
    source: 'claude',
    sessionId: readString(entry, 'sessionId'),
    projectPath: readString(entry, 'cwd'),
    model,
    tsMs,
    inputTokens: readUsageNumber(usageRecord.input_tokens ?? usageRecord.inputTokens),
    outputTokens: readUsageNumber(usageRecord.output_tokens ?? usageRecord.outputTokens),
    cacheReadTokens: readUsageNumber(
      usageRecord.cache_read_input_tokens ?? usageRecord.cacheReadInputTokens,
    ),
    cacheCreationTokens: readUsageNumber(
      usageRecord.cache_creation_input_tokens ?? usageRecord.cacheCreationInputTokens,
    ),
    dedupeKey: `claude:${messageId}`,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-parsers-claude.test.ts
```
Expected: PASS，6 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/stats/services/token-usage-parsers.ts \
        backend/server/modules/stats/tests/token-usage-parsers-claude.test.ts
git commit -m "feat(stats): Claude transcript 行解析器（三种 usage 形状 + message.id 去重）"
```

---

## Task 3: Codex 文件解析器（累计值差分）

Codex 的 `total_token_usage` 是**会话累计值**，必须差分。文件极小（全量 1.1MB），因此每次全量重扫 + 从文件头重新累积，`dedupe_key` 用 `codex:<sessionId>:<lineNo>` 保证幂等——这样就不会出现「cursor 落在文件中间导致丢失差分基准」的 bug。

**Files:**
- Modify: `backend/server/modules/stats/services/token-usage-parsers.ts`（追加函数）
- Test: `backend/server/modules/stats/tests/token-usage-parsers-codex.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/stats/tests/token-usage-parsers-codex.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCodexFile } from '../services/token-usage-parsers.js';

/** 用真实 codex session 的字段形状构造：session_meta 带 cwd，turn_context 带 model，
 *  token_count 带累计 total_token_usage（注意 codex 的 input_tokens 含 cached）。 */
function codexFile(): string {
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: '019f62b2-89a5-7513-b05e-d3f84b1e60a2',
        cwd: '/mnt/b/workdir/github/lovdex',
        model_provider: 'sophnet',
      },
    }),
    JSON.stringify({
      type: 'turn_context',
      payload: { cwd: '/mnt/b/workdir/github/lovdex', model: 'gpt-5.5' },
    }),
    // 第一次累计：全部当作增量
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-14T22:14:56.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000, cached_input_tokens: 400,
            output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050,
          },
        },
      },
    }),
    // 第二次累计：只取相对上次的增量
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-14T22:14:58.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1300, cached_input_tokens: 500,
            output_tokens: 80, reasoning_output_tokens: 30, total_tokens: 1380,
          },
        },
      },
    }),
    '',
  ];
  return lines.join('\n');
}

test('累计值差分成区间事件，且 input 扣除 cached', () => {
  const events = parseCodexFile(codexFile(), '/tmp/x.jsonl');
  assert.equal(events.length, 2);

  const [first, second] = events;
  assert.equal(first.source, 'codex');
  assert.equal(first.model, 'gpt-5.5');
  assert.equal(first.sessionId, '019f62b2-89a5-7513-b05e-d3f84b1e60a2');
  assert.equal(first.projectPath, '/mnt/b/workdir/github/lovdex');
  assert.equal(first.tsMs, Date.parse('2026-07-14T22:14:56.000Z'));
  // 首次以 0 为基准：input = 1000-400 = 600，cache_read = 400，output = 50
  assert.equal(first.inputTokens, 600);
  assert.equal(first.cacheReadTokens, 400);
  assert.equal(first.outputTokens, 50);
  assert.equal(first.cacheCreationTokens, 0);
  assert.equal(first.dedupeKey, 'codex:019f62b2-89a5-7513-b05e-d3f84b1e60a2:3');

  // 增量：input 300-100 = 200，cached 100，output 30
  assert.equal(second.inputTokens, 200);
  assert.equal(second.cacheReadTokens, 100);
  assert.equal(second.outputTokens, 30);
  assert.equal(second.dedupeKey, 'codex:019f62b2-89a5-7513-b05e-d3f84b1e60a2:4');
});

test('同一文件重复解析结果完全一致（保证 INSERT OR IGNORE 幂等）', () => {
  const a = parseCodexFile(codexFile(), '/tmp/x.jsonl');
  const b = parseCodexFile(codexFile(), '/tmp/x.jsonl');
  assert.deepEqual(a, b);
});

test('取不到 model 时标为 unknown 而不是丢弃', () => {
  const text = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's1', cwd: '/p' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-14T22:14:56.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } },
    }),
  ].join('\n');
  const events = parseCodexFile(text, '/tmp/y.jsonl');
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'unknown');
});

test('损坏行与无增量的重复上报都被跳过，且不打断后续解析', () => {
  const text = [
    '{ this is not json',
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's2', cwd: '/p' } }),
    JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-14T22:14:56.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } },
    }),
    // 累计值没变 → 增量为 0 → 不产出事件
    JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-14T22:14:57.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } },
    }),
    JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-14T22:14:58.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, output_tokens: 2 } } },
    }),
  ].join('\n');
  const events = parseCodexFile(text, '/tmp/z.jsonl');
  assert.equal(events.length, 2);
  assert.equal(events[0].inputTokens, 10);
  assert.equal(events[1].inputTokens, 10);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-parsers-codex.test.ts
```
Expected: FAIL —— `parseCodexFile is not a function`。

- [ ] **Step 3: 实现**

在 `backend/server/modules/stats/services/token-usage-parsers.ts` 末尾追加：

```ts
/** Codex 累计用量的三元组；`cached` 是 `input` 的子集。 */
type CodexCumulative = { input: number; output: number; cached: number };

const CODEX_ZERO: CodexCumulative = { input: 0, output: 0, cached: 0 };

/**
 * 解析整个 Codex session 文件（`.jsonl` 文本），返回按行序排列的区间增量事件。
 *
 * Codex 的 `payload.info.total_token_usage` 是**会话累计值**而非单次用量，因此必须差分。
 * 本函数刻意做成「输入整个文件文本」的纯函数：codex 文件总量只有 1MB 量级，每次全量重扫
 * 的成本可忽略，换来的是差分基准永远从文件头重新累积——不会出现 cursor 落在文件中途
 * 导致丢失上次累计值的问题。同一文件重复解析结果恒等，配合 `dedupe_key` 天然幂等。
 *
 * `dedupe_key` 用 `codex:<sessionId>:<行号>`（行号从 1 开始）；sessionId 缺失时用文件路径兜底。
 */
export function parseCodexFile(text: string, filePath: string): TokenUsageEvent[] {
  const events: TokenUsageEvent[] = [];
  let sessionId: string | null = null;
  let projectPath: string | null = null;
  let model = 'unknown';
  let previous: CodexCumulative | null = null;

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const payloadRecord = payload as Record<string, unknown>;

    if (entry.type === 'session_meta') {
      sessionId = readString(payloadRecord, 'session_id') ?? sessionId;
      projectPath = readString(payloadRecord, 'cwd') ?? projectPath;
      continue;
    }

    // turn_context 是 model 的常规来源；后续事件也接受 payload.model。
    // 刻意不回落到 model_provider —— 那是 provider 名不是模型名，回落会污染模型维度。
    const payloadModel = readString(payloadRecord, 'model');
    if (payloadModel) {
      model = payloadModel;
    }

    if (payloadRecord.type !== 'token_count') {
      continue;
    }
    const info = payloadRecord.info;
    if (!info || typeof info !== 'object') {
      continue;
    }
    const total = (info as Record<string, unknown>).total_token_usage;
    if (!total || typeof total !== 'object') {
      continue;
    }
    const totalRecord = total as Record<string, unknown>;
    const current: CodexCumulative = {
      input: readUsageNumber(totalRecord.input_tokens),
      output: readUsageNumber(totalRecord.output_tokens),
      cached: readUsageNumber(totalRecord.cached_input_tokens),
    };
    const base = previous ?? CODEX_ZERO;
    const delta = {
      input: Math.max(0, current.input - base.input),
      output: Math.max(0, current.output - base.output),
      cached: Math.max(0, current.cached - base.cached),
    };
    // 基准必须无条件推进（包括下面要 continue 的情况），否则后续增量会算错。
    previous = current;

    const tsMs = parseIsoToMs(entry.timestamp);
    if (tsMs === null) {
      continue;
    }
    if (delta.input === 0 && delta.output === 0 && delta.cached === 0) {
      continue;
    }

    events.push({
      source: 'codex',
      sessionId,
      projectPath,
      model,
      tsMs,
      // codex 的 input_tokens 含 cached_input_tokens，扣除后才是「不含缓存的新增输入」。
      inputTokens: Math.max(0, delta.input - delta.cached),
      outputTokens: delta.output,
      cacheReadTokens: delta.cached,
      cacheCreationTokens: 0,
      dedupeKey: `codex:${sessionId ?? filePath}:${index + 1}`,
    });
  }

  return events;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-parsers-codex.test.ts
```
Expected: PASS，4 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/stats/services/token-usage-parsers.ts \
        backend/server/modules/stats/tests/token-usage-parsers-codex.test.ts
git commit -m "feat(stats): Codex transcript 解析器（累计值差分 + 全量重扫幂等）"
```

---

## Task 4: OpenCode 行解析器

**Files:**
- Modify: `backend/server/modules/stats/services/token-usage-parsers.ts`（追加函数）
- Test: `backend/server/modules/stats/tests/token-usage-parsers-opencode.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/stats/tests/token-usage-parsers-opencode.test.ts`。fixture 取自真实 `opencode.db` 的 `message` 行：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOpencodeRow } from '../services/token-usage-parsers.js';

/** 真实样本：tokens 满足 19112 + 16 + 1920 = 21048 = total，即 input 不含缓存。 */
const ASSISTANT_ROW = {
  id: 'msg_ff2651f19001UJ79vfB4y7APEB',
  session_id: 'ses_00d9ae2c2ffeLYG8SPbcdWnxvS',
  data: JSON.stringify({
    parentID: 'msg_ff2651d8b001hNncbCOtBf929k',
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/mnt/b/workdir/gitlab/moltbot', root: '/mnt/b/workdir/gitlab/moltbot' },
    cost: 0,
    tokens: {
      total: 21048, input: 19112, output: 16, reasoning: 0,
      cache: { write: 0, read: 1920 },
    },
    modelID: 'DeepSeek-V4-Flash-0731',
    providerID: 'sophnet',
    time: { created: 1786478141209, completed: 1786478147716 },
    finish: 'stop',
  }),
};

test('assistant 行映射成四列，reasoning 不重复计入 output', () => {
  const event = parseOpencodeRow(ASSISTANT_ROW, null);
  assert.ok(event);
  assert.equal(event.source, 'opencode');
  assert.equal(event.sessionId, 'ses_00d9ae2c2ffeLYG8SPbcdWnxvS');
  assert.equal(event.projectPath, '/mnt/b/workdir/gitlab/moltbot');
  assert.equal(event.model, 'DeepSeek-V4-Flash-0731');
  assert.equal(event.tsMs, 1786478141209);
  assert.equal(event.inputTokens, 19112);
  assert.equal(event.outputTokens, 16);
  assert.equal(event.cacheReadTokens, 1920);
  assert.equal(event.cacheCreationTokens, 0);
  assert.equal(event.dedupeKey, 'opencode:msg_ff2651f19001UJ79vfB4y7APEB');
});

test('cache.write 落在 cacheCreationTokens', () => {
  const event = parseOpencodeRow(
    {
      ...ASSISTANT_ROW,
      data: JSON.stringify({
        role: 'assistant',
        tokens: { input: 5, output: 1, cache: { write: 77, read: 0 } },
        modelID: 'm',
        time: { created: 1786478141209 },
      }),
    },
    null,
  );
  assert.ok(event);
  assert.equal(event.cacheCreationTokens, 77);
  assert.equal(event.cacheReadTokens, 0);
});

test('user 行 / 无 tokens / 坏 JSON / 无时间戳 都返回 null', () => {
  assert.equal(parseOpencodeRow({ ...ASSISTANT_ROW, data: JSON.stringify({ role: 'user' }) }, null), null);
  assert.equal(parseOpencodeRow({ ...ASSISTANT_ROW, data: JSON.stringify({ role: 'assistant' }) }, null), null);
  assert.equal(parseOpencodeRow({ ...ASSISTANT_ROW, data: '{oops' }, null), null);
  assert.equal(
    parseOpencodeRow(
      { ...ASSISTANT_ROW, data: JSON.stringify({ role: 'assistant', tokens: { input: 1 } }) },
      null,
    ),
    null,
  );
});

test('缺 path.cwd 时回落到 session.directory，缺 modelID 时标 unknown', () => {
  const event = parseOpencodeRow(
    {
      ...ASSISTANT_ROW,
      data: JSON.stringify({
        role: 'assistant', tokens: { input: 1, output: 1 }, time: { created: 1786478141209 },
      }),
    },
    '/fallback/dir',
  );
  assert.ok(event);
  assert.equal(event.projectPath, '/fallback/dir');
  assert.equal(event.model, 'unknown');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-parsers-opencode.test.ts
```
Expected: FAIL —— `parseOpencodeRow is not a function`。

- [ ] **Step 3: 实现**

在 `backend/server/modules/stats/services/token-usage-parsers.ts` 末尾追加：

```ts
/** `opencode.db` 的 `message` 表行（只取用得到的列）。 */
export type OpencodeMessageRow = {
  id: string;
  session_id: string;
  data: string;
};

/**
 * 解析 `opencode.db` 的一行 message。
 *
 * `data` 是 JSON 文本，assistant 行的 `tokens` 形状为
 * `{ total, input, output, reasoning, cache: { write, read } }`，其中
 * `input` 不含缓存（真实样本满足 `input + output + cache.read = total`），
 * `reasoning` 是 `output` 的子集因而不单独计数。
 *
 * `dedupeKey` 用 `message.id`（该表主键，稳定唯一）。
 */
export function parseOpencodeRow(
  row: OpencodeMessageRow,
  fallbackProjectPath: string | null,
): TokenUsageEvent | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || data.role !== 'assistant') {
    return null;
  }
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== 'object') {
    return null;
  }
  const time = data.time;
  const tsMs = time && typeof time === 'object' && typeof (time as Record<string, unknown>).created === 'number'
    ? ((time as Record<string, unknown>).created as number)
    : null;
  if (tsMs === null) {
    return null;
  }

  const tokensRecord = tokens as Record<string, unknown>;
  const cache = tokensRecord.cache && typeof tokensRecord.cache === 'object'
    ? (tokensRecord.cache as Record<string, unknown>)
    : {};

  return {
    source: 'opencode',
    sessionId: row.session_id,
    projectPath: readString(data.path, 'cwd') ?? fallbackProjectPath,
    model: readString(data, 'modelID') ?? 'unknown',
    tsMs,
    inputTokens: readUsageNumber(tokensRecord.input),
    outputTokens: readUsageNumber(tokensRecord.output),
    cacheReadTokens: readUsageNumber(cache.read),
    cacheCreationTokens: readUsageNumber(cache.write),
    dedupeKey: `opencode:${row.id}`,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-parsers-opencode.test.ts
```
Expected: PASS，4 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/stats/services/token-usage-parsers.ts \
        backend/server/modules/stats/tests/token-usage-parsers-opencode.test.ts
git commit -m "feat(stats): OpenCode message 行解析器"
```

---

## Task 5: 采集引擎

**Files:**
- Create: `backend/server/modules/stats/services/token-usage-ingest.service.ts`
- Test: `backend/server/modules/stats/tests/token-usage-ingest.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/stats/tests/token-usage-ingest.test.ts`。测试用临时目录造真实文件。

**必须用 `withIsolatedDatabase` 包裹每个测试体**（见「关键约定」）——这些测试会调 `initializeDatabase()`
并写入 `tokenUsageDb`，不隔离就会污染生产库。注意测试体因此变成 async。

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDatabase } from '@/modules/database/index.js';
import { tokenUsageDb } from '@/modules/database/repositories/token-usage.db.js';
import { createTokenUsageIngestService } from '../services/token-usage-ingest.service.js';

function claudeLine(id: string, ts: string, input: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    cwd: '/proj/alpha',
    sessionId: 'sess-1',
    timestamp: ts,
    message: { id, model: 'm-x', usage: { input_tokens: input, output_tokens: output } },
  });
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-token-ingest-'));
}

test('扫描 Claude transcript 目录，入库并可增量追加', async () => {
  initializeDatabase();
  const root = makeTempRoot();
  const file = path.join(root, 'sess-1.jsonl');
  fs.writeFileSync(file, `${claudeLine('m1', '2026-08-18T11:00:00.000Z', 100, 10)}\n`);

  const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 1);

  // 追加一行后再扫：只应新增 1 行（offset 增量生效）
  fs.appendFileSync(file, `${claudeLine('m2', '2026-08-18T11:01:00.000Z', 200, 20)}\n`);
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 2);

  // 再扫一次不追加：不应新增（cursor 已到文件尾 + dedupe 兜底）
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 2);
});

test('文件末尾的半行留到下次扫描，不会被吞掉', async () => {
  initializeDatabase();
  const root = makeTempRoot();
  const file = path.join(root, 'sess-half.jsonl');
  const complete = `${claudeLine('h1', '2026-08-18T11:00:00.000Z', 5, 1)}\n`;
  const partial = claudeLine('h2', '2026-08-18T11:01:00.000Z', 7, 2);
  // 写入完整行 + 半行（无换行结尾）
  fs.writeFileSync(file, complete + partial);

  const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 1, '半行不应入库');

  // 补齐换行后，半行应被解析出来
  fs.appendFileSync(file, '\n');
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 2, '补齐后应入库');
});

test('文件被截断（size < cursor offset）时重扫且不重复计数', async () => {
  initializeDatabase();
  const root = makeTempRoot();
  const file = path.join(root, 'sess-trunc.jsonl');
  fs.writeFileSync(file, `${claudeLine('t1', '2026-08-18T11:00:00.000Z', 1, 1)}\n`);

  const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 1);

  // 截断成更短的内容（模拟轮转），offset 应归零重扫
  fs.writeFileSync(file, `${claudeLine('t2', '2026-08-18T11:05:00.000Z', 2, 2)}\n`);
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 2);
  assert.equal(tokenUsageDb.getCursor('claude', file).byteOffset, fs.statSync(file).size);
});

test('同一 message.id 出现在主 transcript 与 subagents 子目录时只入库一次', async () => {
  initializeDatabase();
  const root = makeTempRoot();
  const nested = path.join(root, 'sess-1', 'subagents');
  fs.mkdirSync(nested, { recursive: true });
  const line = claudeLine('dup-1', '2026-08-18T11:00:00.000Z', 9, 9);
  fs.writeFileSync(path.join(root, 'sess-1.jsonl'), `${line}\n`);
  fs.writeFileSync(path.join(nested, 'agent-a.jsonl'), `${line}\n`);

  const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
  await ingest.runScan();
  assert.equal(tokenUsageDb.countEvents(), 1);
});

test('扫描根不存在时不抛错，getStatus 反映已完成', async () => {
  initializeDatabase();
  const ingest = createTokenUsageIngestService({
    claudeRoot: path.join(os.tmpdir(), 'lovdex-does-not-exist-xyz'),
    codexRoot: null,
    opencodeDbPath: null,
  });
  await ingest.runScan();
  const status = ingest.getStatus();
  assert.equal(status.scanning, false);
  assert.ok(status.lastScanAt);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-ingest.test.ts
```
Expected: FAIL —— `Cannot find module '../services/token-usage-ingest.service.js'`。

- [ ] **Step 3: 实现采集引擎**

创建 `backend/server/modules/stats/services/token-usage-ingest.service.ts`：

```ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { tokenUsageDb } from '@/modules/database/repositories/token-usage.db.js';
import type { TokenUsageEvent } from '@/shared/types.js';

import { parseClaudeLine, parseCodexFile, parseOpencodeRow } from './token-usage-parsers.js';

/** 每处理完一个文件让出事件循环，避免长时间阻塞 express。 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 每批插入的行数；配合事务降低 SQLite 提交次数。 */
const INSERT_BATCH_SIZE = 500;

const SCAN_INTERVAL_MS = 60_000;
const INITIAL_SCAN_DELAY_MS = 5_000;
/** ingest-status 被访问时，距上次扫描超过这个时长就触发一次后台刷新。 */
const STALE_REFRESH_MS = 30_000;

export type TokenUsageIngestRoots = {
  claudeRoot: string | null;
  codexRoot: string | null;
  opencodeDbPath: string | null;
};

export type TokenUsageIngestStatus = {
  scanning: boolean;
  filesTotal: number;
  filesDone: number;
  eventsIndexed: number;
  startedAt: string | null;
  lastScanAt: string | null;
};

function defaultRoots(): TokenUsageIngestRoots {
  const home = os.homedir();
  return {
    claudeRoot: path.join(home, '.claude', 'projects'),
    codexRoot: path.join(home, '.codex', 'sessions'),
    opencodeDbPath: path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
  };
}

/** 递归列出目录下所有 `.jsonl` 文件；目录不存在时返回空数组而不是抛错。 */
async function listJsonlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * 从 `fromOffset` 起读取新增的**完整行**。
 *
 * 返回的 `nextOffset` 只推进到最后一个换行符之后，因此正在被写入的半行会留到下次扫描；
 * offset 用 UTF-8 字节长度累加（不是字符长度），否则多字节内容会让 offset 漂移。
 */
async function readCompleteLines(
  filePath: string,
  fromOffset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const stats = await fsp.stat(filePath);
  // 文件被轮转/截断：从头重扫（dedupe_key 保证不会重复计数）
  const startOffset = stats.size < fromOffset ? 0 : fromOffset;
  if (stats.size === startOffset) {
    return { lines: [], nextOffset: startOffset };
  }

  const handle = await fsp.open(filePath, 'r');
  try {
    const length = stats.size - startOffset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, startOffset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      return { lines: [], nextOffset: startOffset };
    }
    const complete = text.slice(0, lastNewline);
    const nextOffset = startOffset + Buffer.byteLength(complete, 'utf8') + 1;
    return { lines: complete.split('\n'), nextOffset };
  } finally {
    await handle.close();
  }
}

function insertInBatches(events: TokenUsageEvent[]): number {
  let inserted = 0;
  for (let i = 0; i < events.length; i += INSERT_BATCH_SIZE) {
    inserted += tokenUsageDb.insertEvents(events.slice(i, i + INSERT_BATCH_SIZE));
  }
  return inserted;
}

export function createTokenUsageIngestService(overrides: Partial<TokenUsageIngestRoots> = {}) {
  const roots: TokenUsageIngestRoots = { ...defaultRoots(), ...overrides };
  const status: TokenUsageIngestStatus = {
    scanning: false,
    filesTotal: 0,
    filesDone: 0,
    eventsIndexed: 0,
    startedAt: null,
    lastScanAt: null,
  };
  let interval: NodeJS.Timeout | null = null;

  /** Claude：按 byte offset 增量读新增的完整行。 */
  async function scanClaude(): Promise<number> {
    if (!roots.claudeRoot) {
      return 0;
    }
    const files = await listJsonlFiles(roots.claudeRoot);
    status.filesTotal += files.length;
    let inserted = 0;

    for (const file of files) {
      const cursor = tokenUsageDb.getCursor('claude', file);
      const { lines, nextOffset } = await readCompleteLines(file, cursor.byteOffset);
      const events: TokenUsageEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const event = parseClaudeLine(JSON.parse(line));
          if (event) {
            events.push(event);
          }
        } catch {
          // 损坏行跳过，不影响同一文件后续行
        }
      }
      inserted += insertInBatches(events);
      tokenUsageDb.setCursor('claude', file, { byteOffset: nextOffset });
      status.filesDone += 1;
      await yieldToEventLoop();
    }
    return inserted;
  }

  /** Codex：文件极小，每次全量重扫 + 差分，靠 dedupe_key 幂等。 */
  async function scanCodex(): Promise<number> {
    if (!roots.codexRoot) {
      return 0;
    }
    const files = await listJsonlFiles(roots.codexRoot);
    status.filesTotal += files.length;
    let inserted = 0;

    for (const file of files) {
      let text: string;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        status.filesDone += 1;
        continue;
      }
      inserted += insertInBatches(parseCodexFile(text, file));
      status.filesDone += 1;
      await yieldToEventLoop();
    }
    return inserted;
  }

  /**
   * OpenCode：读它自己的 sqlite，按 `time_created` 增量。
   *
   * 该库是 WAL 模式且被 provider 进程同时写入，因此用普通连接（只读连接在 WAL 下
   * 需要写 -shm，会直接报错）并设置 busy_timeout。
   */
  async function scanOpencode(): Promise<number> {
    const dbPath = roots.opencodeDbPath;
    if (!dbPath || !fs.existsSync(dbPath)) {
      return 0;
    }
    const cursor = tokenUsageDb.getCursor('opencode', dbPath);
    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch {
      return 0;
    }

    let inserted = 0;
    try {
      db.pragma('busy_timeout = 2000');
      const rows = db
        .prepare(`
          SELECT m.id AS id, m.session_id AS session_id, m.data AS data, s.directory AS directory
          FROM message m
          LEFT JOIN session s ON s.id = m.session_id
          WHERE m.time_created > ?
            AND json_extract(m.data, '$.role') = 'assistant'
          ORDER BY m.time_created ASC
        `)
        .all(cursor.lastTsMs) as {
          id: string;
          session_id: string;
          data: string;
          directory: string | null;
        }[];

      const events: TokenUsageEvent[] = [];
      let maxTs = cursor.lastTsMs;
      for (const row of rows) {
        const event = parseOpencodeRow(row, row.directory ?? null);
        if (event) {
          events.push(event);
          maxTs = Math.max(maxTs, event.tsMs);
        }
      }
      inserted = insertInBatches(events);
      tokenUsageDb.setCursor('opencode', dbPath, { lastTsMs: maxTs });
    } catch {
      // provider 正在写入或表结构变化：本轮跳过，不影响其他来源
    } finally {
      db.close();
    }
    return inserted;
  }

  /** 跑一轮完整扫描；重入时直接返回，不排队。 */
  async function runScan(): Promise<void> {
    if (status.scanning) {
      return;
    }
    status.scanning = true;
    status.filesTotal = 0;
    status.filesDone = 0;
    status.eventsIndexed = 0;
    status.startedAt = new Date().toISOString();
    try {
      status.eventsIndexed += await scanClaude();
      status.eventsIndexed += await scanCodex();
      status.eventsIndexed += await scanOpencode();
    } finally {
      status.scanning = false;
      status.lastScanAt = new Date().toISOString();
    }
  }

  /** 启动定时采集。由 index.js 在 server.listen 回调里调用，不 await。 */
  function start(): void {
    if (interval) {
      return;
    }
    setTimeout(() => void runScan(), INITIAL_SCAN_DELAY_MS);
    interval = setInterval(() => void runScan(), SCAN_INTERVAL_MS);
    // 不要因为这个定时器而阻止进程退出
    interval.unref?.();
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function getStatus(): TokenUsageIngestStatus {
    return { ...status };
  }

  /** 页面请求时调用：数据够新就什么都不做，否则后台触发一次增量扫描（不 await）。 */
  function maybeTriggerRefresh(): void {
    if (status.scanning) {
      return;
    }
    const last = status.lastScanAt ? Date.parse(status.lastScanAt) : 0;
    if (Date.now() - last > STALE_REFRESH_MS) {
      void runScan();
    }
  }

  return { start, stop, runScan, getStatus, maybeTriggerRefresh };
}

export type TokenUsageIngestService = ReturnType<typeof createTokenUsageIngestService>;
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-ingest.test.ts
```
Expected: PASS，5 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/stats/services/token-usage-ingest.service.ts \
        backend/server/modules/stats/tests/token-usage-ingest.test.ts
git commit -m "feat(stats): token 用量采集引擎（增量 offset / 半行处理 / 截断重扫 / 定时调度）"
```

---

## Task 6: 聚合查询服务

**Files:**
- Create: `backend/server/modules/stats/services/token-usage-query.service.ts`
- Test: `backend/server/modules/stats/tests/token-usage-query.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/stats/tests/token-usage-query.test.ts`。

**本文件的测试全是纯函数**（`pickBucketMs` / `isAllowedBucketMs` / `resolveRange` /
`buildTimeseries` / `buildSummary`），**不碰数据库**，所以**不要** import `initializeDatabase`
或 `tokenUsageDb`——那会是未使用的 import，直接触发 lint 错误。

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimeseries,
  buildSummary,
  pickBucketMs,
  isAllowedBucketMs,
  resolveRange,
} from '../services/token-usage-query.service.js';

const MIN = 60_000;

test('pickBucketMs 按范围自适应，边界取较小桶', () => {
  assert.equal(pickBucketMs(60 * MIN), MIN);            // 1h → 1 分钟桶
  assert.equal(pickBucketMs(6 * 60 * MIN), MIN);        // 恰好 6h → 仍是 1 分钟
  assert.equal(pickBucketMs(6 * 60 * MIN + 1), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN + 1), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN + 1), 24 * 60 * MIN);
});

test('isAllowedBucketMs 只接受 60000 的正整数倍', () => {
  assert.equal(isAllowedBucketMs(MIN), true);
  assert.equal(isAllowedBucketMs(5 * MIN), true);
  assert.equal(isAllowedBucketMs(0), false);
  assert.equal(isAllowedBucketMs(-MIN), false);
  assert.equal(isAllowedBucketMs(30_000), false);
  assert.equal(isAllowedBucketMs(Number.NaN), false);
});

test('resolveRange 缺省为最近 24 小时，且容忍 from >= to', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(resolveRange(undefined, undefined, now), { from: now - 24 * 60 * MIN, to: now });
  assert.deepEqual(resolveRange(1000, 2000, now), { from: 1000, to: 2000 });
  // 只给 from 时上界补 now
  assert.deepEqual(resolveRange(1000, undefined, now), { from: 1000, to: now });
  // from >= to 属矛盾输入 → 回退默认窗口，避免返回空数组让前端误以为没数据
  assert.deepEqual(resolveRange(5000, 5000, now), { from: now - 24 * 60 * MIN, to: now });
});

test('buildTimeseries 补零到连续桶，tpm 按桶分钟数换算', () => {
  // from 必须先对齐到桶边界，否则聚合行的 bucket_ts 与补零循环的起点对不上
  const from = Math.floor(1_700_000_000_000 / MIN) * MIN;
  const to = from + 3 * MIN;
  const buckets = buildTimeseries(
    [{ bucket_ts: from, model: 'm-a', tokens: 600 }],
    { from, to, bucketMs: MIN },
  );
  assert.equal(buckets.length, 3, '空桶也要补出来');
  assert.equal(buckets[0].total, 600);
  assert.equal(buckets[0].tpm, 600);        // 1 分钟桶：600 tokens / 1 min
  assert.equal(buckets[1].total, 0);
  assert.equal(buckets[1].tpm, 0);
  assert.deepEqual(buckets[0].byModel, { 'm-a': 600 });
});

test('buildTimeseries 在 5 分钟桶下把 tpm 归一成每分钟', () => {
  const from = Math.floor(1_700_000_000_000 / (5 * MIN)) * (5 * MIN);
  const buckets = buildTimeseries(
    [{ bucket_ts: from, model: 'm-a', tokens: 3000 }],
    { from, to: from + 5 * MIN, bucketMs: 5 * MIN },
  );
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].tpm, 600);        // 3000 tokens / 5 min
});

test('buildSummary 算 share / tpmAvg / tpmPeak / sessions', () => {
  const from = 1_700_000_000_000;
  const to = from + 10 * MIN;
  const summary = buildSummary(
    [
      { model: 'm-a', tokens: 600, sessions: 2, last_used_at: from + MIN },
      { model: 'm-b', tokens: 400, sessions: 1, last_used_at: from },
    ],
    [{ model: 'm-a', peak: 300 }, { model: 'm-b', peak: 400 }],
    { from, to },
  );
  assert.equal(summary.totalTokens, 1000);
  const a = summary.byModel.find((m) => m.model === 'm-a');
  assert.ok(a);
  assert.equal(a.share, 0.6);
  assert.equal(a.tpmAvg, 60);               // 600 / 10 min
  assert.equal(a.tpmPeak, 300);             // 来自 1 分钟粒度查询，不是 10 分钟桶
  assert.equal(a.sessions, 2);
  // 没有峰值记录的模型回落 0 而不是 undefined
  const b = summary.byModel.find((m) => m.model === 'm-b');
  assert.equal(b?.tpmPeak, 400);
});

test('空区间返回空 buckets 与零总量，不抛错', () => {
  const from = 1_700_000_000_000;
  const summary = buildSummary([], [], { from, to: from + MIN });
  assert.equal(summary.totalTokens, 0);
  assert.deepEqual(summary.byModel, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-query.test.ts
```
Expected: FAIL —— `Cannot find module '../services/token-usage-query.service.js'`。

- [ ] **Step 3: 实现**

创建 `backend/server/modules/stats/services/token-usage-query.service.ts`：

```ts
import {
  tokenUsageDb,
  type BucketAggregateRow,
  type ModelAggregateRow,
  type ModelPeakRow,
} from '@/modules/database/repositories/token-usage.db.js';

const MINUTE_MS = 60_000;
const DEFAULT_RANGE_MS = 24 * 60 * MINUTE_MS;

/** 桶大小阶梯：范围越大桶越粗，避免 7 天视图画出上万个点。 */
const BUCKET_STEPS: { maxRangeMs: number; bucketMs: number }[] = [
  { maxRangeMs: 6 * 60 * MINUTE_MS, bucketMs: MINUTE_MS },
  { maxRangeMs: 24 * 60 * MINUTE_MS, bucketMs: 5 * MINUTE_MS },
  { maxRangeMs: 7 * 24 * 60 * MINUTE_MS, bucketMs: 60 * MINUTE_MS },
];
const FALLBACK_BUCKET_MS = 24 * 60 * MINUTE_MS;

export type TimeseriesBucket = {
  ts: number;
  total: number;
  /** 归一化成「每分钟 token 数」，因此不同桶大小下 y 轴量级可比。 */
  tpm: number;
  byModel: Record<string, number>;
};

export type SummaryModelEntry = {
  model: string;
  tokens: number;
  share: number;
  tpmAvg: number;
  tpmPeak: number;
  sessions: number;
  lastUsedAt: number;
};

export type TimeseriesResult = {
  range: { from: number; to: number };
  bucketMs: number;
  models: string[];
  buckets: TimeseriesBucket[];
};

export type SummaryResult = {
  range: { from: number; to: number };
  totalTokens: number;
  byModel: SummaryModelEntry[];
};

export type TokenUsageQueryFilter = {
  from: number;
  to: number;
  projectPath?: string;
  models?: string[];
};

/** 按范围选桶大小。 */
export function pickBucketMs(rangeMs: number): number {
  for (const step of BUCKET_STEPS) {
    if (rangeMs <= step.maxRangeMs) {
      return step.bucketMs;
    }
  }
  return FALLBACK_BUCKET_MS;
}

/** 桶大小必须是 60000 的正整数倍，否则 `(ts/桶)*桶` 的对齐会失真。 */
export function isAllowedBucketMs(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value % MINUTE_MS === 0;
}

/**
 * 归一化 from/to。缺省为最近 24 小时；`from >= to` 属矛盾输入，同样回退默认窗口——
 * 否则会返回空数组，前端会误判成「没有数据」。
 */
export function resolveRange(
  from: number | undefined,
  to: number | undefined,
  now: number,
): { from: number; to: number } {
  const hasValidTo = typeof to === 'number' && Number.isFinite(to) && to > 0;
  const hasValidFrom = typeof from === 'number' && Number.isFinite(from) && from >= 0;

  if (hasValidFrom && hasValidTo && from < to) {
    return { from, to };
  }
  if (hasValidFrom && !hasValidTo) {
    return { from, to: now };
  }
  return { from: now - DEFAULT_RANGE_MS, to: now };
}

/**
 * 把聚合行摊成连续的时间桶。
 *
 * 空桶必须补 0：否则折线图会跨空洞直连，视觉上等于伪造了中间时段的用量。
 */
export function buildTimeseries(
  rows: BucketAggregateRow[],
  options: { from: number; to: number; bucketMs: number },
): TimeseriesBucket[] {
  const { from, to, bucketMs } = options;
  const totalsByBucket = new Map<number, Map<string, number>>();
  const modelTotals = new Map<string, number>();

  for (const row of rows) {
    let bucket = totalsByBucket.get(row.bucket_ts);
    if (!bucket) {
      bucket = new Map<string, number>();
      totalsByBucket.set(row.bucket_ts, bucket);
    }
    bucket.set(row.model, (bucket.get(row.model) ?? 0) + row.tokens);
    modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + row.tokens);
  }

  // 模型按用量降序，图表堆叠顺序稳定且把大头放底部
  const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  const minutesPerBucket = bucketMs / MINUTE_MS;
  const buckets: TimeseriesBucket[] = [];

  for (let ts = Math.floor(from / bucketMs) * bucketMs; ts < to; ts += bucketMs) {
    const bucket = totalsByBucket.get(ts);
    const byModel: Record<string, number> = {};
    let total = 0;
    for (const model of models) {
      const tokens = bucket?.get(model) ?? 0;
      byModel[model] = tokens;
      total += tokens;
    }
    buckets.push({ ts, total, tpm: total / minutesPerBucket, byModel });
  }

  return buckets;
}

/** 组装区间汇总；`tpmPeak` 来自独立的 1 分钟粒度查询。 */
export function buildSummary(
  rows: ModelAggregateRow[],
  peaks: ModelPeakRow[],
  range: { from: number; to: number },
): SummaryResult {
  const peakByModel = new Map(peaks.map((p) => [p.model, p.peak]));
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const rangeMinutes = Math.max(1, (range.to - range.from) / MINUTE_MS);

  return {
    range,
    totalTokens,
    byModel: rows.map((row) => ({
      model: row.model,
      tokens: row.tokens,
      share: totalTokens > 0 ? row.tokens / totalTokens : 0,
      tpmAvg: row.tokens / rangeMinutes,
      tpmPeak: peakByModel.get(row.model) ?? 0,
      sessions: row.sessions,
      lastUsedAt: row.last_used_at,
    })),
  };
}

export function createTokenUsageQueryService(deps: {
  getIngestStatus: () => unknown;
  triggerRefresh: () => void;
}) {
  function getTimeseries(
    filter: TokenUsageQueryFilter,
    bucketMsInput?: number,
  ): TimeseriesResult & { ingest: unknown } {
    const bucketMs = isAllowedBucketMs(bucketMsInput ?? Number.NaN)
      ? (bucketMsInput as number)
      : pickBucketMs(filter.to - filter.from);
    const rows = tokenUsageDb.aggregateBuckets({ ...filter, bucketMs });
    const buckets = buildTimeseries(rows, { ...filter, bucketMs });
    return {
      range: { from: filter.from, to: filter.to },
      bucketMs,
      models: buckets.length > 0 ? Object.keys(buckets[0].byModel) : [],
      buckets,
      ingest: deps.getIngestStatus(),
    };
  }

  function getSummary(filter: TokenUsageQueryFilter): SummaryResult {
    const rows = tokenUsageDb.aggregateByModel(filter);
    const peaks = tokenUsageDb.aggregateMinutePeaks(filter);
    return buildSummary(rows, peaks, { from: filter.from, to: filter.to });
  }

  function listModels(filter: { from: number; to: number; projectPath?: string }) {
    return tokenUsageDb
      .listModels(filter)
      .map((row) => ({ model: row.model, tokens: row.tokens, lastUsedAt: row.last_used_at }));
  }

  return { getTimeseries, getSummary, listModels, getIngestStatus: deps.getIngestStatus, triggerRefresh: deps.triggerRefresh };
}

export type TokenUsageQueryService = ReturnType<typeof createTokenUsageQueryService>;
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/token-usage-query.test.ts
```
Expected: PASS，7 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/stats/services/token-usage-query.service.ts \
        backend/server/modules/stats/tests/token-usage-query.test.ts
git commit -m "feat(stats): 聚合查询服务（自适应分桶 / 空桶补零 / 峰值独立查询）"
```

---

## Task 7: 路由 + barrel + 挂载

**Files:**
- Create: `backend/server/modules/stats/stats.routes.ts`
- Create: `backend/server/modules/stats/index.ts`
- Modify: `backend/server/index.js`（import + 挂载 + 启动采集）
- Test: `backend/server/modules/stats/tests/stats.routes.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/stats/tests/stats.routes.test.ts`（复刻 `tasks.routes.test.ts` 的 app 构造方式）：

```ts
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';
import { buildStatsRouter } from '../stats.routes.js';

type Captured = { filter?: Record<string, unknown>; bucketMs?: number };

function buildTestApp(captured: Captured) {
  const app = express();
  app.use(express.json());
  const query = {
    getTimeseries: (filter: Record<string, unknown>, bucketMs?: number) => {
      captured.filter = filter;
      captured.bucketMs = bucketMs;
      return { range: filter, bucketMs: bucketMs ?? 0, models: [], buckets: [], ingest: {} };
    },
    getSummary: (filter: Record<string, unknown>) => {
      captured.filter = filter;
      return { range: filter, totalTokens: 0, byModel: [] };
    },
    listModels: () => [],
    getIngestStatus: () => ({ scanning: false, filesTotal: 0, filesDone: 0, eventsIndexed: 0, startedAt: null, lastScanAt: null }),
    triggerRefresh: () => undefined,
  };
  app.use('/api/stats', buildStatsRouter({ query }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    }
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'internal' } });
  });
  return app;
}

function listen(t: TestContext, captured: Captured) {
  const server = buildTestApp(captured).listen(0);
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

test('ingest-status 返回采集状态并触发一次刷新检查', async (t) => {
  const { port } = listen(t, {});
  const res = await fetch(`http://127.0.0.1:${port}/api/stats/token-usage/ingest-status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { scanning: boolean };
  assert.equal(body.scanning, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/stats.routes.test.ts
```
Expected: FAIL —— `Cannot find module '../stats.routes.js'`。

- [ ] **Step 3: 实现路由**

创建 `backend/server/modules/stats/stats.routes.ts`：

```ts
import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import { isAllowedBucketMs, resolveRange, type TokenUsageQueryService } from './services/token-usage-query.service.js';

export type StatsRouterDeps = {
  query: TokenUsageQueryService;
};

/** 读取单个 query 字符串；数组（重复传参）取全部非空项。 */
function readQueryStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return [];
}

function readOptionalInt(value: unknown, name: string): number | undefined {
  const raw = readQueryStrings(value)[0];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }
  return parsed;
}

/** 从 query 里解析出统一的过滤条件；非法 from/to 会抛 400。 */
function parseFilter(req: express.Request) {
  const from = readOptionalInt(req.query.from, 'from');
  const to = readOptionalInt(req.query.to, 'to');
  const range = resolveRange(from, to, Date.now());
  const projectPath = readQueryStrings(req.query.projectPath)[0];
  const models = readQueryStrings(req.query.model);
  return {
    ...range,
    ...(projectPath ? { projectPath } : {}),
    ...(models.length > 0 ? { models } : {}),
  };
}

export function buildStatsRouter({ query }: StatsRouterDeps) {
  const router = express.Router();

  // GET /api/stats/token-usage/timeseries?projectPath=&from=&to=&bucketMs=&model=&model=
  router.get(
    '/token-usage/timeseries',
    asyncHandler(async (req, res) => {
      const filter = parseFilter(req);
      // 非法 bucketMs 刻意不报错：直接不传，由 service 按范围回落
      const bucketMs = readOptionalInt(req.query.bucketMs, 'bucketMs');
      query.triggerRefresh();
      res.json(
        query.getTimeseries(filter, bucketMs !== undefined && isAllowedBucketMs(bucketMs) ? bucketMs : undefined),
      );
    }),
  );

  // GET /api/stats/token-usage/summary?projectPath=&from=&to=&model=&model=
  router.get(
    '/token-usage/summary',
    asyncHandler(async (req, res) => {
      const filter = parseFilter(req);
      query.triggerRefresh();
      res.json(query.getSummary(filter));
    }),
  );

  // GET /api/stats/token-usage/models?projectPath=&from=&to=
  router.get(
    '/token-usage/models',
    asyncHandler(async (req, res) => {
      const filter = parseFilter(req);
      const { projectPath } = filter;
      res.json(query.listModels({ from: filter.from, to: filter.to, ...(projectPath ? { projectPath } : {}) }));
    }),
  );

  // GET /api/stats/token-usage/ingest-status
  router.get(
    '/token-usage/ingest-status',
    asyncHandler(async (req, res) => {
      query.triggerRefresh();
      res.json(query.getIngestStatus());
    }),
  );

  return router;
}

export default buildStatsRouter;
```

- [ ] **Step 4: 写 barrel**

创建 `backend/server/modules/stats/index.ts`：

```ts
export { buildStatsRouter } from './stats.routes.js';
export type { StatsRouterDeps } from './stats.routes.js';
export { createTokenUsageIngestService } from './services/token-usage-ingest.service.js';
export type { TokenUsageIngestService, TokenUsageIngestRoots, TokenUsageIngestStatus } from './services/token-usage-ingest.service.js';
export { createTokenUsageQueryService } from './services/token-usage-query.service.js';
export type { TokenUsageQueryService } from './services/token-usage-query.service.js';
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/stats/tests/stats.routes.test.ts
```
Expected: PASS，5 个测试全绿。

- [ ] **Step 6: 挂载到 index.js**

在 `backend/server/index.js` 的 import 区（`import { buildOperatorRouter } ...` 附近，约 `index.js:59`）追加：

```js
import { buildStatsRouter, createTokenUsageIngestService, createTokenUsageQueryService } from './modules/stats/index.js';
```

在 `app.use('/api/scheduled-tasks', ...)` 之后（约 `index.js:611`）追加：

```js
// Token 用量统计 API（protected）— 见 docs/superpowers/specs/2026-09-17-token-usage-stats-design.md
const tokenUsageIngest = createTokenUsageIngestService();
const tokenUsageQuery = createTokenUsageQueryService({
    getIngestStatus: tokenUsageIngest.getStatus,
    triggerRefresh: tokenUsageIngest.maybeTriggerRefresh,
});
app.use('/api/stats', authenticateToken, buildStatsRouter({ query: tokenUsageQuery }));
```

在 `server.listen(SERVER_PORT, HOST, async () => {` 回调内部、`await writeLocalServerMarker()` 之后追加（**不 await**，回填必须与服务可用解耦）：

```js
            // 启动 token 用量采集：延迟首扫（回填历史 transcript）+ 之后每分钟增量。
            tokenUsageIngest.start();
```

- [ ] **Step 7: 全量后端测试 + typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test "server/modules/stats/tests/*.test.ts"
npm run typecheck 2>&1 | tail -20
```
Expected: stats 全部测试 PASS；typecheck 错误数 **不超过改动前基线**（先跑一次 `git stash && npm run typecheck` 记录基线，再 `git stash pop` 对比）。

- [ ] **Step 8: 提交**

```bash
git add backend/server/modules/stats/stats.routes.ts \
        backend/server/modules/stats/index.ts \
        backend/server/modules/stats/tests/stats.routes.test.ts \
        backend/server/index.js
git commit -m "feat(stats): /api/stats/token-usage/* 路由 + 挂载 + 启动采集"
```

---

## Task 8: 前端依赖 + API client

**Files:**
- Modify: `web/package.json`（加 recharts）
- Modify: `web/src/utils/api.js`（加 `stats` 命名空间）

- [ ] **Step 1: 安装 recharts**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm install recharts@^3.10.1
node -p "require('./package.json').dependencies.recharts"
```
Expected: 打印 `^3.10.1`。安装后确认 `react-is` 也被装上（recharts 的 peer dep）：
```bash
node -e "console.log(require.resolve('react-is'))"
```
若报错则执行 `npm install react-is`。

- [ ] **Step 2: 加 API 命名空间**

在 `web/src/utils/api.js` 的 `tasks:` 段之前（约 `:305`）插入：

```js
  // Token 用量统计端点 — /stats 页面。model 可重复传参以筛选多个模型。
  stats: {
    tokenUsageTimeseries: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.projectPath) qs.set('projectPath', params.projectPath);
      if (params.from) qs.set('from', String(params.from));
      if (params.to) qs.set('to', String(params.to));
      if (params.bucketMs) qs.set('bucketMs', String(params.bucketMs));
      for (const model of params.models ?? []) qs.append('model', model);
      const s = qs.toString();
      return authenticatedFetch(`/api/stats/token-usage/timeseries${s ? `?${s}` : ''}`);
    },
    tokenUsageSummary: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.projectPath) qs.set('projectPath', params.projectPath);
      if (params.from) qs.set('from', String(params.from));
      if (params.to) qs.set('to', String(params.to));
      for (const model of params.models ?? []) qs.append('model', model);
      const s = qs.toString();
      return authenticatedFetch(`/api/stats/token-usage/summary${s ? `?${s}` : ''}`);
    },
    tokenUsageModels: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.projectPath) qs.set('projectPath', params.projectPath);
      const s = qs.toString();
      return authenticatedFetch(`/api/stats/token-usage/models${s ? `?${s}` : ''}`);
    },
    tokenUsageIngestStatus: () => authenticatedFetch('/api/stats/token-usage/ingest-status'),
  },

```

- [ ] **Step 3: 验证 lint 不新增错误**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run lint 2>&1 | tail -5
```
Expected: 错误数不超过改动前基线。

- [ ] **Step 4: 提交**

```bash
git add web/package.json web/package-lock.json web/src/utils/api.js
git commit -m "feat(stats): 前端引入 recharts + token 用量统计 API client"
```

---

## Task 9: 前端格式化工具

**Files:**
- Create: `web/src/components/stats/format.ts`
- Test: `web/src/components/stats/format.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/stats/format.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { pickBucketMs, formatTokenCount, formatTpm, formatBucketLabel, TIME_RANGES } from './format';

const MIN = 60_000;

test('pickBucketMs 与后端规则一致', () => {
  assert.equal(pickBucketMs(60 * MIN), MIN);
  assert.equal(pickBucketMs(6 * 60 * MIN), MIN);
  assert.equal(pickBucketMs(6 * 60 * MIN + 1), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN + 1), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN + 1), 24 * 60 * MIN);
});

test('TIME_RANGES 的每个预设都能推出合法桶', () => {
  for (const range of TIME_RANGES) {
    assert.ok(range.label.length > 0);
    assert.ok(range.ms > 0);
    assert.equal(pickBucketMs(range.ms) % MIN, 0);
  }
});

test('formatTokenCount 用 K/M 缩写并保留一位小数', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1.0K');
  assert.equal(formatTokenCount(1234), '1.2K');
  assert.equal(formatTokenCount(1_000_000), '1.0M');
  assert.equal(formatTokenCount(12_345_678), '12.3M');
});

test('formatTpm 处理小数值与空值', () => {
  assert.equal(formatTpm(0), '0');
  assert.equal(formatTpm(12.34), '12.3');
  assert.equal(formatTpm(1234.5), '1.2K');
});

test('formatBucketLabel 按桶大小切换格式', () => {
  const ts = new Date(2026, 8, 17, 14, 30, 0).getTime(); // 本地时间 2026-09-17 14:30
  assert.equal(formatBucketLabel(ts, MIN), '14:30');
  assert.equal(formatBucketLabel(ts, 60 * MIN), '14:00');
  assert.equal(formatBucketLabel(ts, 24 * 60 * MIN), '09-17');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/format.test.ts
```
Expected: FAIL —— `Cannot find module './format'`。

- [ ] **Step 3: 实现**

创建 `web/src/components/stats/format.ts`：

```ts
const MINUTE_MS = 60_000;

/**
 * 时间范围预设。`ms` 与后端 `pickBucketMs` 的阶梯对应，
 * 保证两端对同一区间算出同一个桶大小。
 */
export const TIME_RANGES: { label: string; ms: number }[] = [
  { label: '1 小时', ms: 60 * MINUTE_MS },
  { label: '6 小时', ms: 6 * 60 * MINUTE_MS },
  { label: '24 小时', ms: 24 * 60 * MINUTE_MS },
  { label: '7 天', ms: 7 * 24 * 60 * MINUTE_MS },
  { label: '30 天', ms: 30 * 24 * 60 * MINUTE_MS },
];

/** 与后端 token-usage-query.service.ts 的 BUCKET_STEPS 保持一致。 */
export function pickBucketMs(rangeMs: number): number {
  if (rangeMs <= 6 * 60 * MINUTE_MS) return MINUTE_MS;
  if (rangeMs <= 24 * 60 * MINUTE_MS) return 5 * MINUTE_MS;
  if (rangeMs <= 7 * 24 * 60 * MINUTE_MS) return 60 * MINUTE_MS;
  return 24 * 60 * MINUTE_MS;
}

/** token 数缩写：1234 → "1.2K"，12345678 → "12.3M"。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(value));
}

/** TPM 数值：小值保留一位小数，大值走 K/M 缩写。 */
export function formatTpm(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1000) {
    return formatTokenCount(value);
  }
  return value.toFixed(1);
}

/** x 轴刻度：桶越粗，标签越粗。 */
export function formatBucketLabel(ts: number, bucketMs: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (bucketMs >= 24 * 60 * MINUTE_MS) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  if (bucketMs >= 60 * MINUTE_MS) {
    return `${pad(date.getHours())}:00`;
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 悬浮提示里的完整时间。 */
export function formatFullTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 给模型分配稳定的颜色。同一个模型在同一会话内始终拿到同一个颜色，
 * 避免筛选后颜色跳变。
 */
const MODEL_COLORS = [
  '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444',
  '#14b8a6', '#ec4899', '#84cc16', '#6366f1', '#f97316',
];

export function colorForModel(model: string, allModels: string[]): string {
  const index = allModels.indexOf(model);
  return MODEL_COLORS[(index < 0 ? 0 : index) % MODEL_COLORS.length];
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/format.test.ts
```
Expected: PASS，5 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/stats/format.ts web/src/components/stats/format.test.ts
git commit -m "feat(stats): 前端格式化与分桶工具"
```

---

## Task 10: 数据层 hook

**Files:**
- Create: `web/src/components/stats/useTokenStats.ts`

- [ ] **Step 1: 实现 hook**

创建 `web/src/components/stats/useTokenStats.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';
import { pickBucketMs } from './format';

export type TimeseriesBucket = {
  ts: number;
  total: number;
  tpm: number;
  byModel: Record<string, number>;
};

export type IngestStatus = {
  scanning: boolean;
  filesTotal: number;
  filesDone: number;
  eventsIndexed: number;
  startedAt: string | null;
  lastScanAt: string | null;
};

export type TimeseriesResponse = {
  range: { from: number; to: number };
  bucketMs: number;
  models: string[];
  buckets: TimeseriesBucket[];
  ingest: IngestStatus;
};

export type SummaryModelEntry = {
  model: string;
  tokens: number;
  share: number;
  tpmAvg: number;
  tpmPeak: number;
  sessions: number;
  lastUsedAt: number;
};

export type SummaryResponse = {
  range: { from: number; to: number };
  totalTokens: number;
  byModel: SummaryModelEntry[];
};

const REFRESH_INTERVAL_MS = 30_000;

/**
 * `/stats` 页的数据层：拉取时间序列与汇总，30s 轮询。
 *
 * 页面隐藏时暂停轮询（后台标签页不该空转）；重新可见时立刻补拉一次。
 */
export function useTokenStats(options: {
  projectPath?: string;
  rangeMs: number;
  selectedModels: string[];
}) {
  const { projectPath, rangeMs, selectedModels } = options;
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const to = Date.now();
    const from = to - rangeMs;
    const models = selectedModels.length > 0 ? selectedModels : undefined;
    try {
      const [tsRes, sumRes] = await Promise.all([
        api.stats.tokenUsageTimeseries({ projectPath, from, to, bucketMs: pickBucketMs(rangeMs), models }),
        api.stats.tokenUsageSummary({ projectPath, from, to, models }),
      ]);
      if (!tsRes.ok || !sumRes.ok) {
        throw new Error(`token usage request failed: ${tsRes.status}/${sumRes.status}`);
      }
      const [tsData, sumData] = (await Promise.all([tsRes.json(), sumRes.json()])) as [
        TimeseriesResponse,
        SummaryResponse,
      ];
      if (mounted.current) {
        setTimeseries(tsData);
        setSummary(sumData);
        setError(false);
      }
    } catch {
      if (mounted.current) {
        setError(true);
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [projectPath, rangeMs, selectedModels]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, REFRESH_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { timeseries, summary, loading, error, refresh };
}
```

> `selectedModels` 是数组，调用方必须用 `useMemo`/稳定引用传入，否则 `refresh` 每次渲染都变，会反复重建定时器。

- [ ] **Step 2: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -20
```
Expected: 错误数不超过改动前基线。

- [ ] **Step 3: 提交**

```bash
git add web/src/components/stats/useTokenStats.ts
git commit -m "feat(stats): /stats 数据层 hook（30s 轮询 + 可见性暂停）"
```

---

## Task 11: 图表卡片 + 排行卡片

**Files:**
- Create: `web/src/components/stats/widgets/TpmChartCard.tsx`
- Create: `web/src/components/stats/widgets/ModelRankCard.tsx`

- [ ] **Step 1: 写 TPM 图表卡片**

创建 `web/src/components/stats/widgets/TpmChartCard.tsx`：

```tsx
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { colorForModel, formatBucketLabel, formatFullTime, formatTpm } from '../format';
import type { IngestStatus, TimeseriesResponse } from '../useTokenStats';

type ChartRow = { ts: number } & Record<string, number>;

/** 悬浮提示：按 TPM 降序列出各模型 + 合计。 */
function ChartTooltip({
  active,
  payload,
  label,
  models,
  bucketMs,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number }[];
  label?: number;
  models: string[];
  bucketMs: number;
}) {
  if (!active || !payload || payload.length === 0 || typeof label !== 'number') {
    return null;
  }
  const rows = payload
    .filter((item) => models.includes(String(item.dataKey)))
    .map((item) => ({ model: String(item.dataKey), tpm: item.value ?? 0 }))
    .sort((a, b) => b.tpm - a.tpm);
  const total = rows.reduce((sum, row) => sum + row.tpm, 0);

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 text-muted-foreground">
        {formatFullTime(label)} · {formatBucketLabel(label, bucketMs)}
      </div>
      {rows.map((row) => (
        <div key={row.model} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: colorForModel(row.model, models) }}
            />
            {row.model}
          </span>
          <span className="font-mono">{formatTpm(row.tpm)} TPM</span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border pt-1.5 font-medium">
        <span>合计</span>
        <span className="font-mono">{formatTpm(total)} TPM</span>
      </div>
    </div>
  );
}

/**
 * TPM 时间序列卡片：按模型堆叠的面积图。
 *
 * y 轴是「每分钟 token 数」（后端已按桶大小归一化），因此切换时间范围时曲线量级可比。
 */
export function TpmChartCard({
  timeseries,
  ingest,
}: {
  timeseries: TimeseriesResponse | null;
  ingest: IngestStatus | null;
}) {
  const models = timeseries?.models ?? [];
  const bucketMs = timeseries?.bucketMs ?? 60_000;

  // recharts 需要扁平的 { ts, [model]: tpm } 行
  const rows = useMemo<ChartRow[]>(
    () =>
      (timeseries?.buckets ?? []).map((bucket) => {
        const row: ChartRow = { ts: bucket.ts };
        for (const model of models) {
          row[model] = bucket.byModel[model] ?? 0;
        }
        return row;
      }),
    [timeseries, models],
  );

  const hasData = rows.some((row) => models.some((model) => (row[model] ?? 0) > 0));
  const backfilling = Boolean(ingest?.scanning);

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">TPM 变化（按模型）</h2>
        {backfilling && ingest && (
          <span className="text-xs text-muted-foreground">
            正在回填历史 {ingest.filesDone}/{ingest.filesTotal} 个文件…
          </span>
        )}
      </header>

      {!hasData ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>暂无用量数据</span>
          {backfilling && ingest && (
            <span className="text-xs">
              首次回填进行中（{ingest.filesDone}/{ingest.filesTotal} 个文件，已入库 {ingest.eventsIndexed} 条）
            </span>
          )}
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(value: number) => formatBucketLabel(value, bucketMs)}
                tick={{ fontSize: 11 }}
                stroke="currentColor"
                className="text-muted-foreground"
                minTickGap={40}
              />
              <YAxis
                tickFormatter={(value: number) => formatTpm(value)}
                tick={{ fontSize: 11 }}
                stroke="currentColor"
                className="text-muted-foreground"
                width={48}
              />
              <Tooltip content={<ChartTooltip models={models} bucketMs={bucketMs} />} />
              {models.map((model) => (
                <Area
                  key={model}
                  type="monotone"
                  dataKey={model}
                  stackId="tpm"
                  stroke={colorForModel(model, models)}
                  fill={colorForModel(model, models)}
                  fillOpacity={0.35}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {models.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {models.map((model) => (
            <span key={model} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorForModel(model, models) }} />
              {model}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 写模型排行卡片**

创建 `web/src/components/stats/widgets/ModelRankCard.tsx`：

```tsx
import { formatTokenCount, formatTpm } from '../format';
import type { SummaryResponse } from '../useTokenStats';

function formatLastUsed(ts: number): string {
  if (!ts) {
    return '—';
  }
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 模型排行卡片：区间内各模型的用量、TPM 均值/峰值与占比。 */
export function ModelRankCard({ summary }: { summary: SummaryResponse | null }) {
  const rows = summary?.byModel ?? [];

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">模型用量排行</h2>
        <span className="text-xs text-muted-foreground">
          合计 {formatTokenCount(summary?.totalTokens ?? 0)} tokens
        </span>
      </header>

      {rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">暂无用量数据</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-normal">模型</th>
                <th className="py-2 pr-3 text-right font-normal">总量</th>
                <th className="py-2 pr-3 text-right font-normal">占比</th>
                <th className="py-2 pr-3 text-right font-normal">平均 TPM</th>
                <th className="py-2 pr-3 text-right font-normal">峰值 TPM</th>
                <th className="py-2 text-right font-normal">最近使用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3">{row.model}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatTokenCount(row.tokens)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{(row.share * 100).toFixed(1)}%</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatTpm(row.tpmAvg)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatTpm(row.tpmPeak)}</td>
                  <td className="py-2 text-right font-mono text-muted-foreground">{formatLastUsed(row.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -20
```
Expected: 错误数不超过改动前基线。

> recharts 的自定义 `Tooltip` content 会由库注入 `active` / `payload` / `label`，其类型
> 与我们的 props 签名并不完全吻合。上面把这三个字段都声明成可选的宽松类型；
> 若 typecheck 仍报错，在 `<Tooltip content={...} />` 处对 content 做一次
> `as never` 断言（recharts 3 的已知类型摩擦），**不要**为此放宽全局 tsconfig。

- [ ] **Step 4: 提交**

```bash
git add web/src/components/stats/widgets/
git commit -m "feat(stats): TPM 堆叠面积图卡片 + 模型用量排行卡片"
```

---

## Task 12: 页面骨架 + 路由 + 导航

**Files:**
- Create: `web/src/components/stats/StatsPage.tsx`
- Create: `web/src/components/stats/index.ts`
- Modify: `web/src/App.tsx`（加路由）
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx`（加导航按钮，桌面 + 移动两处）
- Modify: `web/src/i18n/locales/en/sidebar.json`（加 `tooltips.stats`）

- [ ] **Step 1: 写页面骨架**

创建 `web/src/components/stats/StatsPage.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { projectPathOf, taskFormProjects } from '../tasks/projectOptions';
import { TIME_RANGES } from './format';
import { ModelRankCard } from './widgets/ModelRankCard';
import { TpmChartCard } from './widgets/TpmChartCard';
import { useTokenStats } from './useTokenStats';

const ALL_PROJECTS = '__all__';

/**
 * Token 用量统计页。
 *
 * 用卡片网格承载各个统计卡片；后续追加新卡片时只需新建
 * `widgets/XxxCard.tsx` 并在下面的网格里插一行，页面骨架不用改。
 */
export function StatsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectPath, setProjectPath] = useState<string>(ALL_PROJECTS);
  const [rangeIndex, setRangeIndex] = useState(2); // 默认 24 小时
  const [selectedModels, setSelectedModels] = useState<string[]>([]);

  // 项目列表只在挂载时拉一次（与 TaskBoard.tsx:162-180 同一做法）。
  // 没有全局 project store，`api.projects()` 是函数不是对象。
  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then(async (res) => {
        if (!res.ok) throw new Error(`projects failed: ${res.status}`);
        const data = (await res.json()) as Project[];
        if (!cancelled) setProjects(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projectOptions = useMemo(
    () =>
      taskFormProjects(projects).map((project) => ({
        value: projectPathOf(project),
        label: project.displayName || projectPathOf(project),
      })),
    [projects],
  );

  const rangeMs = TIME_RANGES[rangeIndex].ms;
  // useTokenStats 的 refresh 依赖 selectedModels，必须保持稳定引用
  const stableModels = useMemo(() => selectedModels, [selectedModels]);

  const { timeseries, summary, loading, error } = useTokenStats({
    projectPath: projectPath === ALL_PROJECTS ? undefined : projectPath,
    rangeMs,
    selectedModels: stableModels,
  });

  const allModels = timeseries?.models ?? [];

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background p-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-medium">Token 统计</h1>

        <select
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
          className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
        >
          <option value={ALL_PROJECTS}>全部项目</option>
          {projectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
          {TIME_RANGES.map((range, index) => (
            <button
              key={range.label}
              type="button"
              aria-pressed={index === rangeIndex}
              onClick={() => setRangeIndex(index)}
              className={
                index === rangeIndex
                  ? 'rounded-lg bg-card px-2 py-1 text-xs font-normal text-card-foreground shadow-sm'
                  : 'rounded-lg px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground'
              }
            >
              {range.label}
            </button>
          ))}
        </div>

        {allModels.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {allModels.map((model) => {
              const active = selectedModels.includes(model);
              return (
                <button
                  key={model}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setSelectedModels((current) =>
                      current.includes(model) ? current.filter((m) => m !== model) : [...current, model],
                    )
                  }
                  className={
                    active
                      ? 'rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-xs text-primary'
                      : 'rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground'
                  }
                >
                  {model}
                </button>
              );
            })}
          </div>
        )}

        {error && <span className="text-xs text-destructive">加载失败，稍后重试</span>}
        {loading && !timeseries && <span className="text-xs text-muted-foreground">加载中…</span>}
      </header>

      {/* 卡片网格：后续统计卡片直接往这里加 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="xl:col-span-2">
          <TpmChartCard timeseries={timeseries} ingest={timeseries?.ingest ?? null} />
        </div>
        <ModelRankCard summary={summary} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 写 barrel**

创建 `web/src/components/stats/index.ts`：

```ts
export { StatsPage } from './StatsPage';
```

- [ ] **Step 3: 加路由**

在 `web/src/App.tsx` 的 import 区加：

```tsx
import { StatsPage } from './components/stats';
```

在 `<Route path="/tasks" element={<TaskBoardPage />} />` 之后加：

```tsx
<Route path="/stats" element={<StatsPage />} />
```

- [ ] **Step 4: 加导航入口**

> **不要改 `ViewSwitcher.tsx`**：全仓 `grep -rn "ViewSwitcher" src/` 除自身文件外零命中，
> 它是没被任何地方渲染的死代码。真正的导航入口在 `SidebarHeader.tsx` 里两个
> `navigate('/tasks')` 按钮（约 `:88` 桌面版用 `Button`，约 `:187` 移动版用原生 `<button>`）。

先在 `web/src/i18n/locales/en/sidebar.json` 的 `tooltips` 对象里，`"tasks": "Tasks"` 之后加：

```json
"stats": "Token stats"
```

再在 `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx` 的 import 行里补图标：

```tsx
import { BarChart3, ClipboardList } from 'lucide-react';
```

然后**两处都加**（桌面版，紧跟 `:88` 那个 tasks `Button` 之后）：

```tsx
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => navigate('/stats')}
              title={t('tooltips.stats')}
            >
              <BarChart3 className="h-3.5 w-3.5" />
            </Button>
```

（移动版，紧跟 `:187` 那个 tasks `<button>` 之后）：

```tsx
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
              onClick={() => navigate('/stats')}
              title={t('tooltips.stats')}
            >
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </button>
```

- [ ] **Step 5: typecheck + lint**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -20
npm run lint 2>&1 | tail -10
```
Expected: 错误数不超过改动前基线。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/stats/StatsPage.tsx web/src/components/stats/index.ts \
        web/src/App.tsx web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx \
        web/src/i18n/locales/en/sidebar.json
git commit -m "feat(stats): /stats 页面骨架 + 路由 + 侧边栏导航入口"
```

---

## Task 13: 端到端验证

**Files:** 无代码改动（除非发现 bug）

- [ ] **Step 1: 跑全部本功能测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test "server/modules/stats/tests/*.test.ts"

cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/format.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 2: 确认后端基线未劣化**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | tail -5
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -5
```
Expected: 错误数与改动前基线一致（后端约 11 个，前端 0 个）。

- [ ] **Step 3: 重启后端并观察回填**

**先问用户**是否可以重启后端（`systemctl --user lovdex` 上跑着别的项目）。获准后：

```bash
systemctl --user restart lovdex
sleep 20
curl -s http://127.0.0.1:3188/health
```
然后轮询回填进度（需带 auth token；未开鉴权时可直接 curl）：

```bash
curl -s http://127.0.0.1:3188/api/stats/token-usage/ingest-status
```
Expected: `scanning` 先是 `true`，`filesTotal` 应在 1200 左右（Claude 主 + subagent 文件数）；
等待至 `scanning: false`。

- [ ] **Step 4: 验证数据合理性**

```bash
# 全项目 24 小时
curl -s "http://127.0.0.1:3188/api/stats/token-usage/summary" | head -c 800
# 单项目 7 天
curl -s "http://127.0.0.1:3188/api/stats/token-usage/summary?projectPath=/mnt/b/workdir/github/lovdex&from=$(($(date +%s000) - 604800000))" | head -c 800
```
Expected: `byModel` 里出现真实模型 id（如 `DeepSeek-V4-Flash-0731`、`claude-opus-4-8`）；
`totalTokens > 0`；`share` 求和约等于 1。

- [ ] **Step 5: 浏览器验证**

用 puppeteer-core + 缓存 chromium 连 `http://172.26.13.41:5188/stats`（见 `lovdex-cli-verification-recipe` 记忆），截图确认：
- 曲线渲染出来且按模型分色堆叠
- 时间范围切换后 x 轴粒度随之变化
- 模型筛选按钮能过滤曲线
- 项目下拉切到「全部项目」后数据变化
- 首次回填中时显示进度而不是空白

- [ ] **Step 6: 提交（若有修复）**

```bash
git add -A
git commit -m "fix(stats): 端到端验证中发现的问题"
```

---

## 已知风险与注意事项

1. **回填耗时**：758MB / ~1200 个 Claude 文件。首扫可能需要数十秒到数分钟。这是设计内的——页面在回填期间显示进度条而不是空白。若实测过慢，优化方向是只对含 `"usage"` 的行做 `JSON.parse`（先 `line.includes('"usage"')` 快速过滤）。

2. **后端重启需要用户确认**：`systemctl --user lovdex` 上跑着其他项目，Task 13 Step 3 必须先问。

3. **不要在 `index.js` 里 await `start()`**：回填必须与服务可用解耦。

4. **`selectedModels` 引用稳定性**：`useTokenStats` 的 `refresh` 依赖它，传入不稳定数组会导致定时器反复重建。

5. **Qoder 不参与统计**：它只上报 credits，没有 token 维度。这是设计决定，不是遗漏。

6. **成本估算不在范围内**：仓库内不存在任何 model→价格映射表，且 transcript 里的 model 是第三方模型 id，价格无从推导。
