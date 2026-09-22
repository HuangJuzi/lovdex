# Token 统计：口径开关可视化 + OpenCode 游标修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 OpenCode 采集游标的两个潜伏漏读缺陷并补上该路径的测试；把口径控件从统计页页头移进 TPM 卡片、新增「仅输入」档，并让排行卡片显式标注当前口径。

**Architecture:** 后端改动局限于 `stats` 模块的 `scanOpencode()` 与峰值聚合 SQL，均为纯增量。前端把口径控件从 `StatsPage` 页头搬到 `TpmChartCard` 标题行，口径 state 仍由 `StatsPage` 持有（两卡片共用），`ModelRankCard` 只加一个只读标注。档位从 3 档扩到 4 档，后端峰值同步补一档。

**Tech Stack:** TypeScript、Express、better-sqlite3、React 18、recharts、`node --test`（后端用 `tsx --tsconfig server/tsconfig.json`，前端用 `tsx` + `renderToStaticMarkup`，**无 DOM 环境**）。

**规格来源：** `docs/superpowers/specs/2026-09-22-stats-metric-input-and-opencode-cursor-design.md`

---

## 提交策略（偏离默认）

用户明确要求**最后统一提交**，因此本计划的每个 Task **不以 commit 结尾**，改为以「跑测试确认通过」结尾。全部 Task 完成后由 Task 8 做一次统一提交。

---

## 环境准备（每个 Bash 调用都要带）

`TSX_TSCONFIG_PATH` 在 shell 里被全局 export，会劫持 `npx tsx` 的 tsconfig 解析，**必须 unset**。

**后端测试**（工作目录 `backend/`）：
```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --test --tsconfig server/tsconfig.json <测试文件>
```

**前端测试**（工作目录 `web/`）：
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test <测试文件>
```

**基线（已实测，勿当成回归）**：后端 `token-usage-ingest.test.ts` 现有 **7** 个 test 全绿；前端 `format.test.ts` + `TpmChartCard.test.tsx` 现有 **44** 个 test 全绿。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `backend/server/modules/stats/services/token-usage-ingest.service.ts` | 修改 `scanOpencode()` | 游标过滤与推进 |
| `backend/server/modules/stats/tests/token-usage-ingest.test.ts` | 追加 | 新建 opencode.db 夹具 + 2 个回归 test |
| `backend/server/modules/database/repositories/token-usage.db.ts` | 修改 | `ModelPeakRow` + `aggregateMinutePeaks` SQL 补 `peak_input` |
| `backend/server/modules/stats/services/token-usage-query.service.ts` | 修改 | `SummaryModelEntry` + `buildSummary` 补 `peakInput` |
| `backend/server/modules/stats/tests/token-usage-query.test.ts` | 修改 | 既有 buildSummary 测试补第 4 档断言 |
| `backend/server/modules/stats/tests/token-usage.db.test.ts` | 修改 | 既有 `aggregateMinutePeaks` 的 `deepEqual` 补 `peak_input` |
| `web/src/components/stats/format.ts` | 修改 | 第 4 档 `input`、`metricLabel()`、`SummaryRow.peakInput`、`mergeSummaryByVendor` |
| `web/src/components/stats/format.test.ts` | 修改 | `summaryRow` 工厂改 4 元组（14 个调用点）+ 第 4 档断言 |
| `web/src/components/stats/useTokenStats.ts` | 修改 | `SummaryModelEntry` 补 `peakInput` |
| `web/src/components/stats/segmented.ts` | **新建** | 分段控件按钮样式常量（StatsPage 与 TpmChartCard 共用） |
| `web/src/components/stats/widgets/TpmChartCard.tsx` | 修改 | 承载口径控件 |
| `web/src/components/stats/widgets/TpmChartCard.test.tsx` | 修改 | 补 `onMetricChange` 传参 + 控件渲染断言 |
| `web/src/components/stats/StatsPage.tsx` | 修改 | 移除页头口径块，改为传参 |
| `web/src/components/stats/widgets/ModelRankCard.tsx` | 修改 | 标题行加只读「口径：X」 |
| `web/src/components/stats/widgets/ModelRankCard.test.tsx` | **新建** | 只读标注断言 |

共 15 个文件（13 改 + 2 新建）。

---

## Task 1: OpenCode 采集夹具与边界竞态回归测试

**Files:**
- Modify: `backend/server/modules/stats/tests/token-usage-ingest.test.ts`

- [ ] **Step 1: 加 import 与夹具函数**

`better-sqlite3` 是第三方依赖，按文件现有的 import 分组惯例，加在 `node:` 那组的**后面**、`@/` 别名那组的**前面**：

```ts
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
```

在 `makeTempRoot()` 函数之后加两个夹具：

```ts
/** 一条 opencode assistant 消息的 data 载荷（形状照抄真实 opencode.db）。 */
function opencodeAssistant(
  createdMs: number,
  input: number,
  output: number,
): Record<string, unknown> {
  return {
    role: 'assistant',
    modelID: 'm-oc',
    path: { cwd: '/proj/oc' },
    time: { created: createdMs },
    tokens: { input, output, cache: { read: 0, write: 0 } },
  };
}

/**
 * 建一个最小 opencode.db：只含 scanOpencode 用到的那几列。
 * 列定义照抄真实 schema（见 ~/.local/share/opencode/opencode.db 的 `.schema message`），
 * 但刻意不加外键约束——测试不需要，加了反而要按顺序插。
 */
function makeOpencodeDb(
  dir: string,
  rows: { id: string; timeCreated: number; data: Record<string, unknown> }[],
): string {
  const dbPath = path.join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, directory text);
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('sess-oc', '/proj/oc');
  insertOpencodeMessage(db, 'sess-oc', rows);
  db.close();
  return dbPath;
}

/** 往已存在的 opencode.db 追加 assistant 消息（供「扫描后再写入」的用例复用）。 */
function insertOpencodeMessage(
  db: Database.Database,
  sessionId: string,
  rows: { id: string; timeCreated: number; data: Record<string, unknown> }[],
): void {
  const insert = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.id, sessionId, row.timeCreated, row.timeCreated, JSON.stringify(row.data));
  }
}
```

- [ ] **Step 2: 写第一个失败测试（边界竞态）**

在文件末尾追加：

```ts
test('OpenCode：同一毫秒的第二条 assistant 消息不会被游标跳过', async () => {
  await withIsolatedDatabase(async () => {
    const dir = makeTempRoot();
    const T = 1_700_000_000_000;
    const dbPath = makeOpencodeDb(dir, [
      { id: 'msg-a', timeCreated: T, data: opencodeAssistant(T, 100, 10) },
    ]);

    const ingest = createTokenUsageIngestService({
      claudeRoot: null,
      codexRoot: null,
      opencodeDbPath: dbPath,
    });
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 1, '第一条应入库');
    assert.equal(tokenUsageDb.getCursor('opencode', dbPath).lastTsMs, T);

    // 关键：与第一条**同一毫秒**的第二条，在本轮扫描之后才写入。
    // 旧实现过滤条件是 `time_created > lastTsMs`，这一条永远满足不了，会永久漏读。
    const db = new Database(dbPath);
    insertOpencodeMessage(db, 'sess-oc', [
      { id: 'msg-b', timeCreated: T, data: opencodeAssistant(T, 200, 20) },
    ]);
    db.close();

    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 2, '同一毫秒的第二条必须入库');

    // 边界毫秒每轮都会被重读，但 dedupe_key 必须保证不重复入库
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 2, '重读边界毫秒不得重复计数');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --test --tsconfig server/tsconfig.json server/modules/stats/tests/token-usage-ingest.test.ts
```

Expected: **FAIL**，失败信息为 `同一毫秒的第二条必须入库`，实际 `1`、期望 `2`。其余 7 个 test 仍绿。

---

## Task 2: 修复 scanOpencode 的游标过滤与时钟

**Files:**
- Modify: `backend/server/modules/stats/services/token-usage-ingest.service.ts`（`scanOpencode()` 内，约 225-251 行）

- [ ] **Step 1: 替换查询与游标推进代码**

把 `scanOpencode()` 里从 `const rows = db` 到 `tokenUsageDb.setCursor('opencode', dbPath, { lastTsMs: maxTs });` **之前**的这段整体替换：

**替换前：**
```ts
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
```

**替换后：**
```ts
      const rows = db
        .prepare(`
          SELECT m.id AS id, m.session_id AS session_id, m.data AS data,
                 m.time_created AS time_created, s.directory AS directory
          FROM message m
          LEFT JOIN session s ON s.id = m.session_id
          WHERE m.time_created >= ?
            AND json_extract(m.data, '$.role') = 'assistant'
          ORDER BY m.time_created ASC
        `)
        .all(cursor.lastTsMs) as {
          id: string;
          session_id: string;
          data: string;
          time_created: number;
          directory: string | null;
        }[];

      const events: TokenUsageEvent[] = [];
      let maxTs = cursor.lastTsMs;
      for (const row of rows) {
        // 游标与 WHERE 必须用**同一个时钟**：列 m.time_created，而不是 JSON 里的
        // data.time.created（那是事件的语义时间，走 parseOpencodeRow 单独取）。
        // 两个时钟实测相等但那是巧合不是契约，一旦 JSON 时间偏大，游标会越过尚未读到的行。
        //
        // 无条件推进（不只在解析成功时）：解析失败的行不该被每轮重读。
        maxTs = Math.max(maxTs, row.time_created);
        const event = parseOpencodeRow(row, row.directory ?? null);
        if (event) {
          events.push(event);
        }
      }
```

同时在 `WHERE m.time_created >= ?` 上方补一条说明 `>=` 为何必须的注释：

```ts
      // `>=` 而不是 `>`：严格大于时，与游标同一毫秒、但在本轮扫描之后写入的消息
      // 永远读不到（永久漏读）。`>=` 让边界毫秒每轮重读，靠 dedupe_key 的
      // INSERT OR IGNORE 保证幂等，代价是每轮多读「恰好等于游标那一毫秒」的行。
```

- [ ] **Step 2: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --test --tsconfig server/tsconfig.json server/modules/stats/tests/token-usage-ingest.test.ts
```

Expected: **PASS**，8 个 test 全绿（原 7 + 新增 1）。

- [ ] **Step 3: 加第二个回归测试（两个时钟）**

在文件末尾追加：

```ts
test('OpenCode：游标按 m.time_created 推进，不被 data.time.created 顶飞', async () => {
  await withIsolatedDatabase(async () => {
    const dir = makeTempRoot();
    // msg-a 的列时间是 1000，但 JSON 时间被写到极远（模拟两个时钟不一致）。
    // 旧实现用 event.tsMs（JSON 时间）推进游标，会把游标顶到 9999999999999。
    const dbPath = makeOpencodeDb(dir, [
      { id: 'msg-a', timeCreated: 1000, data: opencodeAssistant(9_999_999_999_999, 100, 10) },
    ]);

    const ingest = createTokenUsageIngestService({
      claudeRoot: null,
      codexRoot: null,
      opencodeDbPath: dbPath,
    });
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 1);
    assert.equal(
      tokenUsageDb.getCursor('opencode', dbPath).lastTsMs,
      1000,
      '游标必须按列 m.time_created 推进，而不是 JSON 的 data.time.created',
    );

    // 游标若被顶到 9999999999999，这一条（time_created=2000）会被永久跳过
    const db = new Database(dbPath);
    insertOpencodeMessage(db, 'sess-oc', [
      { id: 'msg-b', timeCreated: 2000, data: opencodeAssistant(2000, 200, 20) },
    ]);
    db.close();

    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 2, 'msg-b 不得被顶飞的游标跳过');
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --test --tsconfig server/tsconfig.json server/modules/stats/tests/token-usage-ingest.test.ts
```

Expected: **PASS**，9 个 test 全绿。

---

## Task 3: 后端峰值补第 4 档 peak_input

**Files:**
- Modify: `backend/server/modules/database/repositories/token-usage.db.ts`
- Modify: `backend/server/modules/stats/services/token-usage-query.service.ts`
- Test: `backend/server/modules/stats/tests/token-usage-query.test.ts`

- [ ] **Step 1: 改 `ModelPeakRow` 类型与 SQL**

`token-usage.db.ts` 里 `ModelPeakRow` 类型：

```ts
/** 一个模型在 1 分钟粒度上的峰值，按四种口径各给一个。 */
export type ModelPeakRow = {
  model: string;
  peak_all: number;
  peak_new: number;
  peak_input: number;
  peak_output: number;
};
```

`aggregateMinutePeaks` 的 SQL 改为（内层多一个 `SUM(input_tokens) AS bucket_input`，外层多一个 `MAX(bucket_input) AS peak_input`）：

```sql
SELECT model,
       MAX(bucket_all)    AS peak_all,
       MAX(bucket_new)    AS peak_new,
       MAX(bucket_input)  AS peak_input,
       MAX(bucket_output) AS peak_output
FROM (
  SELECT model,
         (ts_ms / 60000) * 60000 AS bucket_ts,
         SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS bucket_all,
         SUM(input_tokens + output_tokens) AS bucket_new,
         SUM(input_tokens) AS bucket_input,
         SUM(output_tokens) AS bucket_output
  FROM token_usage_events
  WHERE ${where}
  GROUP BY bucket_ts, model
)
GROUP BY model
```

- [ ] **Step 2: 改 service 的 `SummaryModelEntry` 与 `buildSummary`**

`token-usage-query.service.ts` 里 `SummaryModelEntry`：

```ts
export type SummaryModelEntry = {
  model: string;
  tokens: TokenComponents;
  /** 1 分钟粒度峰值，四档口径各一个（前端按当前口径选）。 */
  peakAll: number;
  peakNew: number;
  peakInput: number;
  peakOutput: number;
  sessions: number;
  lastUsedAt: number;
};
```

`buildSummary` 的返回对象里，在 `peakNew` 之后插入一行：

```ts
        peakInput: peak?.peak_input ?? 0,
```

- [ ] **Step 3: 更新既有测试**

`token-usage-query.test.ts` 的 `buildSummary 按模型返回四类分量 / 三档峰值 / 会话数` test：

把 test 名改为 `buildSummary 按模型返回四类分量 / 四档峰值 / 会话数`，把 fixture 的峰值行改为：

```ts
    [{ model: 'm-a', peak_all: 300, peak_new: 120, peak_input: 90, peak_output: 30 }],
```

在 `assert.equal(a.peakNew, 120);` 之后加：

```ts
  assert.equal(a.peakInput, 90);
```

在 `assert.equal(b.peakNew, 0);` 之后加：

```ts
  assert.equal(b.peakInput, 0);
```

- [ ] **Step 4: 更新 `token-usage.db.test.ts` 的 deepEqual 断言（**必做，否则必挂**）**

`aggregateMinutePeaks 在 1 分钟粒度上给出三档峰值` 这个 test 用 `deepEqual` 断言**整行对象**，
SQL 多出一列 `peak_input` 会让它失败。改动：

test 名改为 `aggregateMinutePeaks 在 1 分钟粒度上给出四档峰值`。

第 264 行：
```ts
    assert.deepEqual(a, { model: 'm-a', peak_all: 2000, peak_new: 100, peak_input: 90, peak_output: 10 });
```
（`peak_input: 90` 的来源：m-a 第 1 分钟 `input=90` → 该分钟 `bucket_input=90`；
第 2 分钟两条事件的 `input` 都是 0 → `bucket_input=0`；峰值取 max = 90。
四个值 2000/100/90/10 **互不相同**，所以这一行能真正证明 `peak_input` 接对了列。）

第 266 行：
```ts
    assert.deepEqual(b, { model: 'm-b', peak_all: 307, peak_new: 7, peak_input: 0, peak_output: 7 });
```
（m-b 的事件 `input=0`，所以 `peak_input` 就是 0。这一行只保证字段存在，判别力由 m-a 那行承担。）

第 267 行的 `assert.ok(peaks.every((p) => !('peak' in p)))` **不用改**：它查的是名为 `peak` 的键，
`peak_input` 不会命中。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --test --tsconfig server/tsconfig.json server/modules/stats/tests/token-usage-query.test.ts server/modules/stats/tests/token-usage.db.test.ts
```

Expected: **PASS**。若漏改 `buildSummary` 则 `a.peakInput` 为 `undefined`；若漏改 `token-usage.db.test.ts`
则 `deepEqual` 报「多了 peak_input 字段」。两者都会在此步暴露。

- [ ] **Step 6: 后端全量回归 + typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --test --tsconfig server/tsconfig.json server/modules/stats/tests/*.test.ts
```

Expected: 全绿（ingest 9 + query + routes + parsers 三份 + db）。

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | tail -20
```

Expected: **零新增错误**。基线本就不干净（存在 pre-existing 错误），只对比改动前后的错误条数是否一致。

---

## Task 4: 前端 format.ts 新增第 4 档与相关工具

**Files:**
- Modify: `web/src/components/stats/format.ts`
- Test: `web/src/components/stats/format.test.ts`

- [ ] **Step 1: 改造既有 `summaryRow` 工厂为 4 元组（**必做，否则 typecheck 必挂**）**

`format.test.ts:467-484` 的工厂用 3 元组 `peaks: [number, number, number]` 构造 `SummaryRow`。
`peakInput` 变成必填后，这个工厂的返回字面量会缺字段 → typecheck 报错，且 **14 个调用点**的数组字面量长度不匹配。

把工厂整体替换为（元组顺序改为 `[all, new, input, output]`，与 `METRICS` 档位顺序对齐）：

```ts
/** 构造一行 summary 记录，省得每处都写全字段。peaks 顺序：all / new / input / output。 */
function summaryRow(
  model: string,
  tokens: TokenComponents,
  peaks: [number, number, number, number],
  sessions: number,
  lastUsedAt: number,
): SummaryRow {
  return {
    model,
    tokens,
    peakAll: peaks[0],
    peakNew: peaks[1],
    peakInput: peaks[2],
    peakOutput: peaks[3],
    sessions,
    lastUsedAt,
  };
}
```

然后**逐个**更新下列 14 个调用点（在原第 3 个元素前插入 input 值）：

| 行 | 改动 |
|---|---|
| 488 | `[500, 50, 10]` → `[500, 50, 45, 10]` |
| 489 | `[900, 80, 20]` → `[900, 80, 70, 20]` |
| 490 | `[700, 70, 30]` → `[700, 70, 60, 30]` |
| 517 | `[1, 1, 1]` → `[1, 1, 1, 1]` |
| 518 | `[1, 1, 1]` → `[1, 1, 1, 1]` |
| 519 | `[1, 1, 1]` → `[1, 1, 1, 1]` |
| 527 | `[1, 1, 1]` → `[1, 1, 1, 1]` |
| 528 | `[2, 2, 2]` → `[2, 2, 2, 2]` |
| 538 | `[500, 50, 10]` → `[500, 50, 45, 10]` |
| 539 | `[900, 80, 20]` → `[900, 80, 70, 20]` |
| 540 | `[700, 70, 30]` → `[700, 70, 60, 30]` |
| 541 | `[800, 90, 40]` → `[800, 90, 75, 40]` |
| 563 | `[9, 8, 7]` → `[9, 8, 6, 7]` |
| 568 | `[9, 8, 7]` → `[9, 8, 6, 7]` |

在 `mergeSummaryByVendor 把同族模型归并成一行` test 的 `assert.equal(claude.peakOutput, 20);` 之后补：

```ts
  assert.equal(claude.peakInput, 70, 'peakInput 取 max（45 vs 70）');
```

在 `mergeSummaryByVendor 归并是无损的：各口径总量守恒` test 的循环里加上新档位：

```ts
  for (const metric of ['all', 'new', 'input', 'output'] as const) {
```

- [ ] **Step 2: 写新测试**

`format.test.ts` 的 import 列表里**只需补 `metricLabel`**——`METRICS` / `metricValue` / `mergeSummaryByVendor` /
`EMPTY_COMPONENTS` / `SummaryRow` 都已经 import 过了，不要重复添加。

在文件末尾追加（复用既有的 `components()` 与 `summaryRow()` 两个工厂）：

```ts
test('METRICS 四档顺序为 全部 / 仅新增 / 仅输入 / 仅输出', () => {
  assert.deepEqual(
    METRICS.map((m) => m.value),
    ['all', 'new', 'input', 'output'],
  );
  assert.deepEqual(
    METRICS.map((m) => m.label),
    ['全部', '仅新增', '仅输入', '仅输出'],
  );
  for (const m of METRICS) {
    assert.ok(m.hint.length > 0, `${m.value} 必须有 hint`);
  }
});

test('metricLabel 与 METRICS 标签一致', () => {
  for (const m of METRICS) {
    assert.equal(metricLabel(m.value), m.label);
  }
});

test('metricValue 的仅输入档只取 input', () => {
  const c = components(600, 10, 1000, 5);
  assert.equal(metricValue(c, 'all'), 1615);
  assert.equal(metricValue(c, 'new'), 610);
  assert.equal(metricValue(c, 'input'), 600);
  assert.equal(metricValue(c, 'output'), 10);
});

test('mergeSummaryByVendor 对 peakInput 取 max（瞬时量不能相加）', () => {
  const merged = mergeSummaryByVendor([
    summaryRow('deepseek-a', components(0, 0, 0, 0), [10, 5, 3, 1], 1, 100),
    summaryRow('deepseek-b', components(0, 0, 0, 0), [7, 2, 9, 4], 1, 200),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].peakInput, 9, 'peakInput 取 max 而不是相加');
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/format.test.ts
```

Expected: **FAIL** — `metricLabel` 未导出（`SyntaxError`/`TypeError`），`METRICS` 只有 3 档。

- [ ] **Step 4: 实现**

`format.ts` 的 `TokenMetric` 与 `METRICS`：

```ts
/** TPM 口径。默认 `all`——与 provider 计费/限流口径一致。 */
export type TokenMetric = 'all' | 'new' | 'input' | 'output';

export const METRICS: { value: TokenMetric; label: string; hint: string }[] = [
  { value: 'all', label: '全部', hint: 'input + output + 缓存读取 + 缓存写入（provider 计费口径）' },
  { value: 'new', label: '仅新增', hint: 'input + output，排除缓存重读' },
  { value: 'input', label: '仅输入', hint: '只算 input，不含缓存重读与输出' },
  { value: 'output', label: '仅输出', hint: '只算模型实际生成的内容' },
];

/** 口径的中文标签。排行卡片用它做只读标注，避免文案两处各写一遍。 */
export function metricLabel(metric: TokenMetric): string {
  return METRICS.find((m) => m.value === metric)?.label ?? metric;
}
```

`metricValue` 增加一档（**顺序**：把 `input` 插在 `new` 之后）：

```ts
export function metricValue(components: TokenComponents, metric: TokenMetric): number {
  switch (metric) {
    case 'all':
      return components.input + components.output + components.cacheRead + components.cacheCreation;
    case 'new':
      return components.input + components.output;
    case 'input':
      return components.input;
    case 'output':
      return components.output;
  }
}
```

`SummaryRow` 类型增加 `peakInput`：

```ts
export type SummaryRow = {
  model: string;
  tokens: TokenComponents;
  peakAll: number;
  peakNew: number;
  peakInput: number;
  peakOutput: number;
  sessions: number;
  lastUsedAt: number;
};
```

`mergeSummaryByVendor` 的合并分支里，在 `peakNew` 之后插入：

```ts
      peakInput: Math.max(existing.peakInput, row.peakInput),
```

同时更新该函数上方注释里的字段枚举（原文是「`peak*` 与 `lastUsedAt` 取 **max**」，无需改动，`peakInput` 已含在 `peak*` 里）。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/format.test.ts
```

Expected: **PASS**（原有用例 + 新增 4 个）。

- [ ] **Step 6: 同步前端响应类型**

`web/src/components/stats/useTokenStats.ts` 的 `SummaryModelEntry` 增加 `peakInput`：

```ts
export type SummaryModelEntry = {
  model: string;
  tokens: TokenComponents;
  peakAll: number;
  peakNew: number;
  peakInput: number;
  peakOutput: number;
  sessions: number;
  lastUsedAt: number;
};
```

---

## Task 5: 抽出分段控件样式常量

**Files:**
- Create: `web/src/components/stats/segmented.ts`
- Modify: `web/src/components/stats/StatsPage.tsx`

- [ ] **Step 1: 新建共享常量文件**

```ts
/**
 * 分段控件（segmented control）的按钮样式。
 *
 * 全站惯例见 `ViewSwitcher.tsx:49` / `ScheduledTabBar.tsx:20` / `TaskBoard.tsx:287`：
 * 外层 `flex rounded-xl border border-border/70 bg-muted/50 p-0.5`，内层按钮用这两个类。
 *
 * 抽出来是因为统计页的「范围」「维度」留在页头、「口径」搬进了 TPM 卡片，
 * 两处需要同一份样式。
 */
export const SEGMENT_ACTIVE =
  'rounded-lg bg-card px-2 py-1 text-xs font-normal text-card-foreground shadow-sm';
export const SEGMENT_IDLE =
  'rounded-lg px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground';
```

- [ ] **Step 2: StatsPage 改为 import**

删除 `StatsPage.tsx` 顶部的这两行常量定义：

```ts
const SEGMENT_ACTIVE =
  'rounded-lg bg-card px-2 py-1 text-xs font-normal text-card-foreground shadow-sm';
const SEGMENT_IDLE =
  'rounded-lg px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground';
```

在 import 区加入：

```ts
import { SEGMENT_ACTIVE, SEGMENT_IDLE } from './segmented';
```

- [ ] **Step 3: 跑前端测试确认无回归**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/format.test.ts src/components/stats/widgets/TpmChartCard.test.tsx
```

Expected: **PASS**（44 个）。

---

## Task 6: TpmChartCard 承载口径控件

**Files:**
- Modify: `web/src/components/stats/widgets/TpmChartCard.tsx`
- Modify: `web/src/components/stats/widgets/TpmChartCard.test.tsx`

- [ ] **Step 1: 写失败测试**

`TpmChartCard.test.tsx`：先把现有 3 个 test 的 `<TpmChartCard ... />` 都补上 `onMetricChange={() => {}}`（否则 TypeScript 报缺少必填 prop）。然后在文件末尾追加：

```tsx
test('标题行渲染四个口径档位，当前档 aria-pressed=true', () => {
  const html = renderToStaticMarkup(
    <TpmChartCard
      timeseries={null}
      ingest={null}
      metric="input"
      dimension="model"
      onMetricChange={() => {}}
    />,
  );
  for (const label of ['全部', '仅新增', '仅输入', '仅输出']) {
    assert.match(html, new RegExp(`>${label}<`), `缺少档位 ${label}`);
  }
  // 只有「仅输入」是按下态
  const pressed = html.match(/aria-pressed="true"[^>]*>([^<]+)</g) ?? [];
  assert.equal(pressed.length, 1, '只能有一个按下态');
  assert.match(pressed[0], /仅输入/);
});

test('空态（暂无用量）下口径控件仍渲染', () => {
  const html = renderToStaticMarkup(
    <TpmChartCard
      timeseries={null}
      ingest={null}
      metric="all"
      dimension="model"
      onMetricChange={() => {}}
    />,
  );
  assert.match(html, /暂无用量数据/);
  assert.match(html, /仅输出/, '空态也要能切口径');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/widgets/TpmChartCard.test.tsx
```

Expected: **FAIL** — 未定义的 prop `onMetricChange`，且渲染结果里没有档位按钮。

- [ ] **Step 3: 实现**

`TpmChartCard.tsx` import 区补：

```ts
import { METRICS } from '../format';
import { SEGMENT_ACTIVE, SEGMENT_IDLE } from '../segmented';
```

（`METRICS` 加进已有的 `from '../format'` import 列表，不要新建重复 import。）

组件签名增加 `onMetricChange`：

```tsx
export function TpmChartCard({
  timeseries,
  ingest,
  metric,
  dimension,
  onMetricChange,
}: {
  timeseries: TimeseriesResponse | null;
  ingest: IngestStatus | null;
  metric: TokenMetric;
  dimension: TokenDimension;
  onMetricChange: (metric: TokenMetric) => void;
}) {
```

把 `<header>` 整块替换为：

```tsx
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          TPM 变化（{dimension === 'vendor' ? '按厂商' : '按模型'}）
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {backfilling && ingest && (
            <span className="text-xs text-muted-foreground">
              {hasFileCount
                ? `正在回填历史 ${ingest.filesDone}/${ingest.filesTotal} 个文件…`
                : '正在回填历史…'}
            </span>
          )}
          {/* 口径控件住在这里而不是页头：页头原本并排三个外观完全相同的分段控件且都无标题，
              口径夹在中间，用户根本找不到。放在图旁边，它影响的曲线就在眼皮底下。 */}
          <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
            {METRICS.map((m) => (
              <button
                key={m.value}
                type="button"
                title={m.hint}
                aria-pressed={metric === m.value}
                onClick={() => onMetricChange(m.value)}
                className={metric === m.value ? SEGMENT_ACTIVE : SEGMENT_IDLE}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>
```

同时更新组件上方文档注释里「口径与维度都由 `StatsPage` 持有」一段，补一句：口径控件渲染在本卡片内，维度控件仍在页头。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/widgets/TpmChartCard.test.tsx
```

Expected: **PASS**，5 个 test（原 3 + 新 2）。

---

## Task 7: StatsPage 移除页头口径块并传参

**Files:**
- Modify: `web/src/components/stats/StatsPage.tsx`

- [ ] **Step 1: 删除页头的口径分段块**

删除 `StatsPage.tsx` 里这一整块（含上方注释）：

```tsx
        {/* 口径：决定「什么算一个 token」 */}
        <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
          {METRICS.map((m) => (
            <button
              key={m.value}
              type="button"
              title={m.hint}
              aria-pressed={metric === m.value}
              onClick={() => setMetric(m.value)}
              className={metric === m.value ? SEGMENT_ACTIVE : SEGMENT_IDLE}
            >
              {m.label}
            </button>
          ))}
        </div>
```

- [ ] **Step 2: 传参给 TpmChartCard**

`<TpmChartCard ... />` 补一个 prop：

```tsx
            <TpmChartCard
              timeseries={timeseries}
              ingest={timeseries?.ingest ?? null}
              metric={metric}
              dimension={dimension}
              onMetricChange={setMetric}
            />
```

- [ ] **Step 3: 清理 import**

`METRICS` 不再被 `StatsPage` 使用，从 `./format` 的 import 列表里删掉（`DIMENSIONS`、`TIME_RANGES`、`TokenDimension`、`TokenMetric` 仍在使用，保留）。若 `SEGMENT_ACTIVE` / `SEGMENT_IDLE` 仍被「范围」「维度」两处使用则保留 import。

- [ ] **Step 4: typecheck 确认没有未使用 import**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -20
```

Expected: 无 `METRICS` 相关的未使用报错，且错误数不超过改动前基线。

---

## Task 8: ModelRankCard 只读口径标注

**Files:**
- Modify: `web/src/components/stats/widgets/ModelRankCard.tsx`
- Test: `web/src/components/stats/widgets/ModelRankCard.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

新建 `web/src/components/stats/widgets/ModelRankCard.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ModelRankCard } from './ModelRankCard';

const SUMMARY = {
  range: { from: 1_700_000_000_000, to: 1_700_000_600_000 },
  byModel: [
    {
      model: 'm-a',
      tokens: { input: 600, output: 10, cacheRead: 1000, cacheCreation: 0 },
      peakAll: 300,
      peakNew: 120,
      peakInput: 90,
      peakOutput: 30,
      sessions: 2,
      lastUsedAt: 1_700_000_300_000,
    },
  ],
};

test('标题行标注当前口径，且不渲染可交互控件', () => {
  const html = renderToStaticMarkup(
    <ModelRankCard summary={SUMMARY} metric="output" dimension="model" />,
  );
  assert.match(html, /口径：仅输出/, '必须显示当前口径，否则数字变了会莫名其妙');
  assert.doesNotMatch(html, /aria-pressed/, '排行卡片只读，不能有第二个口径控件');
});

test('标注随口径切换而更新', () => {
  const html = renderToStaticMarkup(
    <ModelRankCard summary={SUMMARY} metric="input" dimension="vendor" />,
  );
  assert.match(html, /口径：仅输入/);
});

test('无数据时仍是空态，不抛错', () => {
  const html = renderToStaticMarkup(
    <ModelRankCard summary={null} metric="all" dimension="model" />,
  );
  assert.match(html, /暂无用量数据/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/widgets/ModelRankCard.test.tsx
```

Expected: **FAIL** — 渲染结果里没有「口径：」。

- [ ] **Step 3: 实现**

`ModelRankCard.tsx` 的 import 补 `metricLabel`：

```ts
import {
  formatTokenCount,
  formatTpm,
  mergeSummaryByVendor,
  metricLabel,
  metricValue,
  type SummaryRow,
  type TokenDimension,
  type TokenMetric,
} from '../format';
```

把 `<header>` 替换为：

```tsx
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">
          {dimensionLabel}用量排行
          {/* 只读标注：这张表的总量 / 占比 / 平均 TPM / 峰值 TPM 全部随口径变，
              而控件在 TPM 卡片里。不标注的话，数字在无控件的地方悄悄变会让人莫名其妙。
              刻意不渲染第二个可交互控件——单一真源在 TPM 卡片。 */}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            口径：{metricLabel(metric)}
          </span>
        </h2>
        <span className="text-xs text-muted-foreground">
          合计 {formatTokenCount(grandTotal)} tokens
        </span>
      </header>
```

`peakFor` 增加一档：

```ts
function peakFor(row: SummaryRow, metric: TokenMetric): number {
  switch (metric) {
    case 'all':
      return row.peakAll;
    case 'new':
      return row.peakNew;
    case 'input':
      return row.peakInput;
    case 'output':
      return row.peakOutput;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/widgets/ModelRankCard.test.tsx
```

Expected: **PASS**，3 个 test。

---

## Task 9: 全量验证与统一提交

**Files:** 无新增，仅验证与提交

- [ ] **Step 1: 后端全量测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --test --tsconfig server/tsconfig.json server/modules/stats/tests/*.test.ts
```

Expected: 全绿，其中 `token-usage-ingest.test.ts` 为 9 个 test。

- [ ] **Step 2: 前端全量测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/stats/format.test.ts src/components/stats/widgets/TpmChartCard.test.tsx src/components/stats/widgets/ModelRankCard.test.tsx
```

Expected: 全绿。

- [ ] **Step 3: 两端 typecheck 对比基线**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | tail -20
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -20
```

Expected: **零新增**错误（基线本就不干净，只对比条数）。

- [ ] **Step 4: 人工确认页面**

启动前端（`web/` 下 `npm run dev`，连后端 `:3188`），打开 `/stats`：

1. 页头**不再**出现口径分段控件（只剩 范围 / 维度）。
2. TPM 卡片标题行右侧出现 **全部 / 仅新增 / 仅输入 / 仅输出** 四档。
3. 点「仅输入」，曲线量级明显低于「全部」（按实测 input 占 25.2%、cache_read 占 74.2%）。
4. 排行卡片标题旁显示「口径：仅输入」，且总量/占比/平均TPM/峰值TPM 同步变化。
5. 切到 30 天档仍不报错。

- [ ] **Step 5: 统一提交**

**先看状态，再按显式路径 add**。不要用 `git add -A`——这个工作区可能被并发会话共用，
`-A` 会把别的会话的 WIP 一起扫进来。

```bash
cd /mnt/b/workdir/github/lovdex && git status --short
```

若除下列 15 个文件外还有别的改动，**停下来问用户**，不要自作主张提交。

```bash
cd /mnt/b/workdir/github/lovdex && git add \
  backend/server/modules/stats/services/token-usage-ingest.service.ts \
  backend/server/modules/stats/tests/token-usage-ingest.test.ts \
  backend/server/modules/database/repositories/token-usage.db.ts \
  backend/server/modules/stats/services/token-usage-query.service.ts \
  backend/server/modules/stats/tests/token-usage-query.test.ts \
  backend/server/modules/stats/tests/token-usage.db.test.ts \
  web/src/components/stats/format.ts \
  web/src/components/stats/format.test.ts \
  web/src/components/stats/useTokenStats.ts \
  web/src/components/stats/segmented.ts \
  web/src/components/stats/StatsPage.tsx \
  web/src/components/stats/widgets/TpmChartCard.tsx \
  web/src/components/stats/widgets/TpmChartCard.test.tsx \
  web/src/components/stats/widgets/ModelRankCard.tsx \
  web/src/components/stats/widgets/ModelRankCard.test.tsx
```

然后提交：

```bash
git commit -F - <<'EOF'
fix(stats): stop the opencode cursor dropping same-millisecond messages

The ingest filter used a strict `time_created > cursor`, so an assistant
message sharing a millisecond with the cursor and arriving after the scan
could never be read again. The cursor also advanced on a different clock
than the filter used (`data.time.created` vs the `m.time_created` column),
so any skew between the two would skip unread rows. Both are latent: the
live database shows zero duplicate-millisecond groups and 197/197 clock
agreement, so no data was actually lost.

Adds the opencode ingest path's first tests, including regressions for
both defects.

Also moves the metric control out of the stats page header into the TPM
card. The header held three identically-styled, unlabelled segmented
controls with the metric one in the middle, which is why it went
unnoticed. Adds a fourth "input only" metric with its backend peak, and
labels the rank card with the active metric since all of its numbers
follow it.
EOF
```

提交信息**不加** `Co-Authored-By` 署名行（用户约定）。

- [ ] **Step 6: 确认提交内容**

```bash
git show --stat HEAD
```

Expected: 恰好上表列出的 **15** 个文件（13 改 + 2 新建）。

---

## 完成标准

1. `token-usage-ingest.test.ts` 的「同一毫秒」用例在 Task 1 后失败、Task 2 后通过（红→绿可验证）。
2. 后端 stats 测试全绿（ingest 9 个）；前端 stats 测试全绿。
3. 两端 typecheck 零新增错误。
4. 页头无口径控件；TPM 卡片四档；排行卡片「口径：X」只读标注。
5. 单次提交，无 `Co-Authored-By`。
