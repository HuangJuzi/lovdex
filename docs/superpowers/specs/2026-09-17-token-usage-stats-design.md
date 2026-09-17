# Lovdex Token 用量统计页（TPM 按模型拆分）设计

- 日期：2026-09-17
- 状态：待评审
- 范围：后端（新表 + 采集引擎 + 新模块 API）+ 前端（新 `/stats` 页面 + recharts 依赖）

## 1. 背景与目标

用户想在一个项目维度上看 **TPM（tokens per minute）随时间的变化**，并且**按模型区分**。
这个页面后续还会持续添加其他统计卡片，因此页面骨架要按「可扩展的卡片网格」设计。

### 1.1 关键现状：Lovdex 库里没有任何 token 数据

`backend/server/modules/database/schema.ts` 的 15 张表（users / projects / sessions / tasks /
scheduled_tasks / …）**没有任何 usage 列，也没有 messages 表**。会话消息从不落库。

现存能力只有单会话维度、按需实时解析：

- `GET /api/projects/:projectId/sessions/:sessionId/token-usage`（`backend/server/index.js:1584-1846`，
  按 provider 四分支读本地文件）
- `/cost` 斜杠命令（`backend/server/routes/commands.js:337-421`）
- 前端 composer 用量徽章（`web/src/components/chat/view/subcomponents/TokenUsageSummary.tsx`）

**没有任何跨会话 / 项目维度的汇总，也没有时间序列。**

因此本设计不是「加一个查询接口」，而是**新建一条采集管道**：把散落在各 provider transcript 里的
用量解析出来、落库、建索引，再在其上做聚合。

### 1.2 各 provider 的数据可得性（已用真实数据抽样验证）

| 来源 | 位置 | 粒度 | 真实 model 字段 | 项目路径字段 |
|---|---|---|---|---|
| Claude | `~/.claude/projects/**/*.jsonl` | 每条 assistant 消息 | `message.model`（如 `DeepSeek-V4-Flash-0731`、`claude-opus-4-8`） | `cwd` |
| Codex | `~/.codex/sessions/**/*.jsonl` | `token_count` 事件（累计值，需差分） | `turn_context.payload.model`（`token_count` 事件本身不带） | `session_meta.payload.cwd` |
| OpenCode | `~/.local/share/opencode/opencode.db` | `message.data.tokens`，epoch 毫秒 | `data.modelID` | `data.path.cwd` / `session.directory` |
| Qoder | — | 只有 credits，**无 token** | — | — |

关键点：**`message.model` / `modelID` 是真实模型 id**，而 `tasks.executor_model` 存的是 UI 别名
（`sonnet` / `default` / `gpt-5.4` / `auto`，见 `web/src/components/chat/view/subcomponents/convertToTaskPayload.ts:23-28`）。
本设计一律以 transcript 里的真实 model id 为准，这正是「区分出模型」诉求的落点。

### 1.3 数据量

`~/.claude/projects` 共 758MB / 23 个项目目录（lovdex 自身 153MB）。其中含 **1178 个嵌套的
subagent transcript**（`<sessionId>/subagents/agent-*.jsonl`）。`~/.codex/sessions` 仅 1.1MB / 9 文件。
所以回填成本基本由 Claude 决定，必须流式 + 断点续扫。

### 1.4 已验证的解析前提

- Claude 主 transcript 的 assistant 条目 `isSidechain` 全为 `false`；
  抽样发现 sidechain 用量**只**出现在 subagent 文件里（`isSidechain: true`）。
  但两种文件都带 `message.id`，因此**用 `message.id` 做去重键**即可自动处理主/子文件的重叠，
  不必依赖文件布局假设。
- Claude 条目带 `cwd` 与 `sessionId`，项目归属精确，**不需要**从目录名
  （`-mnt-b-workdir-github-lovdex`）反推路径——那对含 `-` 的路径本身就是有歧义的。
- `message.model` 取值里存在 `<synthetic>`，非真实 API 调用，必须跳过。

## 2. 关键设计决策

| 决策点 | 结论 |
|---|---|
| 数据来源 | 解析 provider transcript，不依赖 lovdex 现有表 |
| 项目归属 | 用 transcript 里的 `cwd` 精确匹配，**不反推目录名编码** |
| 模型归属 | 用 transcript 里的真实 model id，不用 `tasks.executor_model` UI 别名 |
| 落库方式 | 新表 `token_usage_events`（一行 = 一条 assistant 消息 / 一个用量区间） |
| 幂等 | `dedupe_key` UNIQUE + `INSERT OR IGNORE`，重复扫描天然安全 |
| 增量 | `token_ingest_cursor` 记 byte offset（Claude/Codex）与 epoch ms（OpenCode） |
| 时间存储 | `ts_ms INTEGER`（epoch 毫秒），**分桶用纯整数运算**，绕开 SQLite UTC/本地时区问题 |
| 回填范围 | 全部项目（用户已确认）；后台跑，不阻塞请求 |
| TPM 定义 | 桶内 token ÷ 桶分钟数，y 轴恒为 tokens/分钟 |
| 桶大小 | 按时间范围自适应（见 §3.4） |
| 图表库 | 引入 recharts `^3.10.1`（用户已确认）；peer 支持 React 18 |
| Qoder | 排除（无 token 数据） |
| 成本/费用 | 范围外——仓库内**不存在任何 model→价格映射表** |
| 页面形态 | 卡片网格，后续统计卡片可增量添加 |

## 3. 方案详述

### 3.1 数据库

新增两张表，写入 `backend/server/modules/database/schema.ts` 并拼进 `INIT_SCHEMA_SQL`
（索引同样放 `INIT_SCHEMA_SQL`）：

```sql
CREATE TABLE IF NOT EXISTS token_usage_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  source                TEXT    NOT NULL,          -- 'claude' | 'codex' | 'opencode'
  session_id            TEXT,                      -- provider 侧会话 id
  project_path          TEXT,                      -- 解析自 cwd，解析不到则 NULL
  model                 TEXT    NOT NULL,          -- 真实 model id
  ts_ms                 INTEGER NOT NULL,          -- epoch 毫秒
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  dedupe_key            TEXT    NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_tue_ts          ON token_usage_events (ts_ms);
CREATE INDEX IF NOT EXISTS idx_tue_project_ts  ON token_usage_events (project_path, ts_ms);
CREATE INDEX IF NOT EXISTS idx_tue_model_ts    ON token_usage_events (model, ts_ms);

CREATE TABLE IF NOT EXISTS token_ingest_cursor (
  source      TEXT    NOT NULL,
  file_path   TEXT    NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  last_ts_ms  INTEGER NOT NULL DEFAULT 0,          -- OpenCode 用
  updated_at  TEXT,
  PRIMARY KEY (source, file_path)
);
```

`dedupe_key` 规则（保证跨文件与重复扫描都幂等）：

| source | dedupe_key |
|---|---|
| claude | `claude:<message.id>` — 主/子 transcript 重叠自动去重 |
| codex | `codex:<session_id>:<line_no>` — 差分区间在文件内按行号定位 |
| opencode | `opencode:<message.id>`（`message.id` 是表主键，稳定唯一） |

> 因为表是 `CREATE TABLE IF NOT EXISTS` 且是新增表，**不需要**写 `migrations.ts` 迁移；
> 与 `operator_exec_audit`（`schema.ts:245-260`）同一模式。

### 3.2 各 provider 的 token 归一化

四个 token 列统一语义：`input_tokens` 为**不含缓存**的新增输入。`总 token = 四列之和`。

- **Claude**：`input_tokens` / `output_tokens` / `cache_read_input_tokens` /
  `cache_creation_input_tokens`，直接对应四列（Anthropic 语义下 `input_tokens` 本就不含缓存，
  与 `index.js:1802-1824` 现有实现的 `inputTokens = direct + cacheRead + cacheCreation` 一致）。
  - `model === '<synthetic>'` → 跳过整条。
  - `usage` 形状有三种变体（仅 `input/output`；含 `cache_read`；含全套 `cache_creation`/`iterations` 等），
    一律用**字段存在性判断**逐个读取，缺失按 0。在 stats 模块内自带一个
    `readUsageNumber(value)` 辅助函数（`index.js:1802` 附近有等价的内联实现，但未导出，
    **不要**为了复用它去改动 `index.js` 的既有端点）。
- **Codex**：`payload.info.total_token_usage` 是**会话累计值**，需差分。
  - 同一文件内按行序计算 `delta = 本次累计 − 上次累计`；上次值在扫描过程中内存持有。
  - `input_tokens`（codex 的 `input_tokens` **含** `cached_input_tokens`）→
    落库 `input = max(0, input_tokens − cached_input_tokens)`、`cache_read = cached_input_tokens`。
  - `output_tokens` 落 output（`reasoning_output_tokens` 是 output 的子集，不重复计）。
  - 时间戳用事件自身的 `timestamp`；model 取该文件内**同一 session 内时间戳不晚于该事件**的
    最近一个携带 `payload.model` 的事件（`turn_context`），取不到则标为 `unknown`
    （不回落到 `model_provider`——那是 provider 名不是模型名，回落会污染模型维度）。
  - 文件小（全量 1.1MB），**每次全量重扫 + 差分**，靠 `dedupe_key` 幂等，不依赖 offset；
    避免「cursor 落在文件中间导致丢失上次累计值」这一类 bug。
    重扫时差分基准从文件头重新累积，因此对同一批历史行算出的 delta 恒等，`INSERT OR IGNORE` 安全。
- **OpenCode**：读 `opencode.db`（该库是 WAL 模式且被 provider 进程同时写入，**普通连接 + 只发
  SELECT**，并设 `busy_timeout`；不要用 `readonly` 打开——SQLite 的只读连接仍需要写 `-shm`，
  在 WAL 下会直接报错）：
  `SELECT id, session_id, time_created, data FROM message WHERE json_extract(data,'$.role')='assistant'`。
  - `data.tokens.input/output/cache.read/cache.write` → 四列（`reasoning` 是 output 子集，不重复计）。
    已用真实样本核对语义：`{total:21048, input:19112, output:16, cache:{read:1920, write:0}}`
    满足 `19112 + 16 + 1920 = 21048 = total`，即 **`input` 不含缓存**，与 §3.2 开头的四列定义一致。
  - `ts_ms = data.time.created`（已是 epoch 毫秒）。
  - 增量按 `time_created > cursor.last_ts_ms`。
  - 项目路径取 `data.path.cwd`，缺失回落 `session.directory`。
- **Qoder**：不采集。

### 3.3 采集引擎（`backend/server/modules/stats/services/token-usage-ingest.service.ts`）

单一引擎同时负责回填与增量，避免两套解析逻辑漂移。

**扫描根**（常量，`os.homedir()` 派生）：
- `~/.claude/projects/**/*.jsonl`（递归以覆盖 `subagents/` 嵌套）
- `~/.codex/sessions/**/*.jsonl`
- `~/.local/share/opencode/opencode.db`

**流程**：
1. 枚举文件 → 与 `token_ingest_cursor` 比对。
2. Claude：从 `byte_offset` 起流式读新增字节，按行 `JSON.parse`，逐条 `INSERT OR IGNORE`，
   每 500 条一个事务；扫完更新 offset。
   - 文件「变小」（`size < offset`，说明被轮转/截断）→ offset 归零重扫（幂等，安全）。
3. Codex：全量重扫 + 差分（见 §3.2）。
4. OpenCode：按 `last_ts_ms` 增量查询。
5. 每处理完一个文件 `await new Promise(setImmediate)` 让出事件循环，**不阻塞 express**。

**调度**（入口：`statsService.startIngest()`，由 `index.js` 在 `app.listen` 回调后调用，
不 await——回填必须与「服务已可用」解耦，否则首次启动会被 758MB 扫描卡住）：
- 进程启动后延迟 ~5s 触发一次全量扫描（覆盖回填）。
- 之后每 60s 增量扫描一次。
- `GET /api/stats/token-usage/ingest-status` 被调用且距上次扫描 > 30s 时，**异步触发一次**增量
  （不 await，立刻返回当前状态），保证打开页面时数据新鲜。
- 扫描期间用内存状态对象记录 `{ scanning, filesTotal, filesDone, eventsIndexed, startedAt, lastScanAt }`。

### 3.4 TPM 与分桶

- `bucketMs` 缺省时按时间范围自适应（前端也会按同一张表下发显式值，两端规则一致）：

  | 时间范围 | bucketMs |
  |---|---|
  | ≤ 6h | 60_000（1 分钟） |
  | ≤ 24h | 300_000（5 分钟） |
  | ≤ 7d | 3_600_000（1 小时） |
  | > 7d | 86_400_000（1 天） |

- 聚合 SQL（纯整数运算，无时区依赖）：
  ```sql
  SELECT (ts_ms / :bucketMs) * :bucketMs AS bucket_ts,
         model,
         SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
         SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(cache_creation_tokens) AS cache_creation_tokens
  FROM token_usage_events
  WHERE ts_ms >= :from AND ts_ms < :to
    AND (:projectPath IS NULL OR project_path = :projectPath)
    AND (:modelFilterDisabled OR model IN (...))
  GROUP BY bucket_ts, model
  ORDER BY bucket_ts ASC
  ```
  （`:modelFilterDisabled` 是「未传 `model` 参数」的布尔开关，用于区分「不过滤」与
  「过滤但为空集合」两种语义；`IN (...)` 的占位符按传入模型数动态拼接——照
  `tasks.db.ts:138-152` 的动态 WHERE 惯例。）
- `bucketMs` 缺省时**后端**按 §3.4 表格按范围自动选定；前端显式传值时以后端收到的为准
  （并对非正数 / 非 60000 整数倍的值回落默认）。
- `tpm = tokens / (bucketMs / 60000)`。**桶为空也补零**（后端在 service 层补齐连续桶），
  否则折线图会跨空洞直连，视觉上失真。
- 前端 x 轴按本地时区格式化 `bucket_ts`（recharts 传 `ts_ms` 数值即可）。

### 3.5 后端模块

新增 `backend/server/modules/stats/`，遵循既有模块骨架
（`index.ts` barrel + `<name>.routes.ts` + `services/` + `tests/`，参照 `modules/scheduler/`）：

```
modules/stats/
├── index.ts
├── stats.routes.ts
├── services/
│   ├── token-usage-ingest.service.ts   # 采集引擎
│   └── token-usage-query.service.ts    # 聚合查询
└── tests/
    ├── token-usage-ingest.test.ts
    └── stats.routes.test.ts
```

`backend/server/index.js` 挂载（`:608` 附近，与 tasks/scheduler 并列）：
```js
app.use('/api/stats', authenticateToken, buildStatsRouter(statsService));
```
路由顺序注意：所有 `/token-usage/...` 子路径必须注册在全局错误中间件（`index.js:1849`）之前。

**端点**：

`GET /api/stats/token-usage/timeseries?projectPath=&from=&to=&bucketMs=&model=`
```json
{
  "range": { "from": 1758000000000, "to": 1758086400000 },
  "bucketMs": 300000,
  "models": ["DeepSeek-V4-Flash-0731", "claude-opus-4-8"],
  "buckets": [
    { "ts": 1758000000000, "total": 123456, "tpm": 411.5,
      "byModel": { "DeepSeek-V4-Flash-0731": 100000, "claude-opus-4-8": 23456 } }
  ],
  "ingest": { "scanning": false, "lastScanAt": "2026-09-17T08:00:00.000Z" }
}
```
`model` 为可重复 query 参数，用于筛选。

`GET /api/stats/token-usage/summary?projectPath=&from=&to=`
```json
{
  "totalTokens": 12345678,
  "range": { "from": 0, "to": 0 },
  "byModel": [
    { "model": "DeepSeek-V4-Flash-0731", "tokens": 10000000, "share": 0.81,
      "tpmAvg": 120.5, "tpmPeak": 3400.0, "sessions": 12, "lastUsedAt": 1758000000000 }
  ]
}
```
`share = 该模型 tokens / totalTokens`；`tpmAvg = 该模型 tokens / 范围分钟数`；
`tpmPeak` 走一条**独立的 1 分钟粒度聚合查询**取该模型单分钟最大值（不能用响应里的
`bucketMs` 桶——1 小时桶算不出真实峰值）；`sessions = COUNT(DISTINCT session_id)`。

`GET /api/stats/token-usage/models` → 去重模型列表（供筛选器）：
`[{ "model": "...", "tokens": 123, "lastUsedAt": 1758000000000 }]`

`GET /api/stats/token-usage/ingest-status` → §3.3 的内存状态对象。

参数校验照 `modules/projects/projects.routes.ts:42-57` 的 `parseNonNegativeIntQuery` 风格手写；
`from/to` 缺省为「最近 24 小时」。非法 `bucketMs` 回落默认值而不报错。
DB 访问放 `modules/database/repositories/token-usage.db.ts`，并在
`modules/database/index.ts:6-14` 加 export；行类型 `TokenUsageRow` 加进 `server/shared/types.ts`。

### 3.6 前端

**依赖**：`web/package.json` 加 `recharts@^3.10.1`（peer 兼容 React 18；仓库当前无任何图表库）。

**路由与入口**：
- `web/src/App.tsx:128-137` 加 `<Route path="/stats" element={<StatsPage />} />`。
- 导航入口加在 `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx` 里
  两个 `navigate('/tasks')` 按钮（约 `:88` 桌面版、约 `:187` 移动版）旁边，各加一个统计按钮。
  **不要动 `web/src/components/tasks/ViewSwitcher.tsx`**——全仓除自身文件外零引用，是死代码。

**文件**：
```
web/src/components/stats/
├── index.ts
├── StatsPage.tsx              # 页面骨架：项目选择器 + 时间范围 + 卡片网格
├── useTokenStats.ts           # 数据层：拉取 + 30s 轮询 + 可见性暂停
├── format.ts                  # token 数 K/M 缩写、TPM 格式化、bucketMs 选择
└── widgets/
    ├── TpmChartCard.tsx       # recharts 堆叠面积图，按模型
    └── ModelRankCard.tsx      # 模型排行表
```

- `web/src/utils/api.js` 加 `stats` 命名空间（照 `tasks:` 段 `:306-326` 的写法）。
- 类型加进 `web/src/types/app.ts`。
- 页面**正文**文案硬编码中文，与 `TaskTableView.tsx:21-37` 的既有惯例一致。
  导航按钮的 `title` **必须**走 i18n（`SidebarHeader.tsx` 用的是 `t('tooltips.*')`），
  所以在 `web/src/i18n/locales/en/sidebar.json` 的 `tooltips` 段加 `stats` 键
  （仓库当前**只有 `en` 一个 locale**，无需补其他语言）。
- 空态：无数据时显示「暂无用量数据」+ 回填进度，而不是空白图表。这是**必须**的——
  首次打开时回填很可能还在跑，展示进度比展示空图更有用。

**卡片网格**：`StatsPage` 用 `grid grid-cols-1 xl:grid-cols-2 gap-4` 承载卡片，
每张卡片自包含（自己拉自己的数据或接收 props）。后续追加统计卡片时只加
`widgets/XxxCard.tsx` + 在网格里插一行，不改页面骨架。窄屏单列（与
`web/src/components/tasks/TaskTableView.tsx` 的响应式惯例一致）。

**图表**：recharts `AreaChart` + `stackId` 按模型堆叠，`XAxis` 传 `dataKey="ts"` +
`type="number"` + `domain={['dataMin','dataMax']}` + `tickFormatter` 本地时间，
`Tooltip` 自定义以显示各模型 TPM 与合计。

**刷新**：30s 轮询；`document.visibilityState === 'hidden'` 时暂停（避免后台标签页空转）。

## 4. 错误处理与边界

| 场景 | 处理 |
|---|---|
| transcript 文件正在被写入（读到半行 JSON） | 逐行 `JSON.parse` 失败即跳过该行；offset 只推进到**最后一个成功解析的换行符**，半行留到下次扫描 |
| 文件被轮转/截断（size < cursor offset） | offset 归零重扫；`dedupe_key` 保证不重复计数 |
| transcript 缺 `cwd` | `project_path` 存 NULL；仍参与「全部项目」口径，但不出现在按项目筛选里 |
| `model` 为 `<synthetic>`（Claude） | 整条跳过 |
| Codex `token_count` 首次出现（无上次累计值） | 首次差分基准为 0，即把首个累计值当作增量；codex 会话首条通常很小，误差可忽略 |
| Codex 取不到 model | 标为 `unknown`（仍计数，不静默丢弃） |
| OpenCode DB 被 provider 写入中 | 只读连接 + `busy_timeout`；查询失败则本轮跳过并记日志，不影响其他来源 |
| `~/.claude/projects` 不存在（全新机器） | 视为空集合，不报错；页面显示空态 |
| DB 里 usage 行数远小于预期 | 属正常（回填中）；由 `ingest-status` 显式暴露进度，不静默 |
| 回填与实时写入并发 | 全部走 `INSERT OR IGNORE` + 单连接同步写，better-sqlite3 串行化，无竞态 |
| 时间范围内无数据 | 返回 `buckets: []`，前端显示空态而非报错 |

## 5. 测试

### 后端（`node --test`，需真实临时目录，参照 `modules/tasks/tests/tasks.routes.test.ts:11-35`）

1. **归一化**：给定各 provider 的**真实样本行**（从本机 transcript 摘录的 fixture 字符串），
   断言四列 token 与 `ts_ms` 解析正确；含 Claude 的三种 usage 形状变体、`<synthetic>` 跳过、
   Codex 累计值差分成区间、OpenCode `data.tokens` 映射。
2. **幂等**：同一批 fixture 扫描两遍，`token_usage_events` 行数不变。
3. **跨文件去重**：同一 `message.id` 同时出现在主 transcript 与 subagent 文件，只落一行。
4. **cursor 断点**：扫一半后重置进程状态再扫，结果与一次扫完一致；
   文件截断（size < offset）时 offset 归零重扫且总数不变。
5. **半行处理**：在文件末尾追加不完整 JSON 行，扫描不抛错且不吞掉该行（补齐后再扫能入库）。
6. **聚合查询**：构造跨桶数据，断言 `bucket_ts` 对齐、空桶补零、`tpm` 换算正确、
   `projectPath` 与 `model` 过滤生效、`summary` 的 `share`/`tpmPeak` 正确。
7. **路由**：非法 `bucketMs` 回落默认、缺省时间范围为最近 24 小时、
   404/400 走既有 `AppError` 形状。

### 前端

8. `format.ts` 纯函数单测（`web` 无 DOM 环境，参照既有测试方式）：
   bucketMs 选择边界、token 缩写、TPM 格式化。

## 6. 范围外（不做）

- **成本/费用估算**：仓库内不存在任何 model→价格映射表，且 Claude transcript 的 model 是第三方
  模型 id（`DeepSeek-V4-Flash-0731` 等），价格无从推导。后续若要做需单独引入价目表。
- **Qoder 用量**：只有 credits，无 token 维度。
- **实时推送**：用轮询（30s）而非 WebSocket，先不做增量推送。
- **按会话/任务维度下钻**：本期只到「项目 × 模型 × 时间」。
- **数据保留策略 / 清理任务**：`token_usage_events` 会持续增长，暂不做 TTL 与归档。
- **远程主机（remote-projects）的用量**：只采集本机 transcript。
- **历史回填的可中断/可恢复 UI 控制**：回填自动跑，页面只读进度，不提供暂停/重扫按钮。

## 7. 上线后修订：TPM 口径与模型分组（2026-09-17 第二轮）

后端落地后在真实数据上冒烟（1392 个文件 / 55,813 事件 / 29 秒），发现两个必须先定的产品语义问题。
以下修订**覆盖**前文对应部分。

### 7.1 实测数据构成（全量 130,653 条 assistant 记录，168 亿 token）

| 类别 | 占比 |
|---|---|
| cache_read | **74.2%** |
| input | 24.9% |
| cache_creation | 0.6% |
| **output** | **0.3%** |

即「全部 token 求和」这条曲线画的其实是**上下文被重读了多少**，而非「干了多少活」——
output 被完全淹没。另发现大量成对记录（同样的 `input=967,227`，一次 `output=668`、一次 `output=1`），
来自第三方模型走 claude provider 时的 thinking-only 重试循环，同一份大 context 被重复计入。

（已用独立 Python 脚本直接解析原始 transcript 交叉验证：采集管道的解析是正确的，
上述构成是数据本身的真实形态，不是解析 bug。）

### 7.2 决策：TPM 口径

**默认统计全部 token（input + output + cache_read + cache_creation），但：**

- 页面上提供口径切换：**全部 / 仅新增（input + output，排除缓存）/ 仅输出**。
- **图下始终显示四类构成比例**——cache_read 占 74% 这件事必须可见，不能藏起来。
- 因此 API 不能只返回一个 `tokens` 总数，必须返回**四个分量**，让前端本地换算口径，
  切换时无需重新请求。

### 7.3 决策：模型分组

实测同一族模型因**用户配置别名**被拆成多行：

| 出现的 id | 来源 |
|---|---|
| `DeepSeek-Flash` | `app.config.json` → `providers.claude.defaultModel` |
| `DeepSeek-V4-Pro-0813` | 同上 → `opusModel` |
| `DeepSeek-V4-Pro` | `backend/llm-proxy/main.go:144` `ensureRoute("sonnet", ...)` |
| `DeepSeek-V4-Flash-0731` | 同上 → `disableThinkingModels` |

这些是**真实存在的不同配置项**，是否同一上游模型无法从代码推断，因此：

- **原始 model id 完整保留，不做有损归一化**（数据层不丢信息）。
- 页面提供**「按模型 / 按厂商」双维度切换**；厂商维度用启发式前缀规则归并
  （DeepSeek / GLM / Kimi / Claude / GPT / MiniMax …），在**前端**实现为纯函数——
  后端不变，切换即时生效，规则可随时调整而无需重新采集。
