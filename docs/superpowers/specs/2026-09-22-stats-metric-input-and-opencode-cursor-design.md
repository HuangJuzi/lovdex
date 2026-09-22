# Lovdex Token 统计页：口径开关可视化 + OpenCode 采集游标修复 设计

- 日期：2026-09-22
- 状态：待评审
- 范围：后端（`stats` 模块的 opencode 采集游标 + 峰值查询加一档）+ 前端（`/stats` 页口径控件的档位与位置）
- 前置文档：`docs/superpowers/specs/2026-09-17-token-usage-stats-design.md`（本设计是其增量修订）

## 1. 背景与目标

Token 统计页上线后，用户反馈两件事：

1. **口径开关找不到**。用户原话是「再加上一个开关，显示总量、只显示输出，只显示输入等」——
   而口径切换其实**早已存在**（`format.ts:257` 的 `METRICS`：全部 / 仅新增 / 仅输出），
   用户没看见它。这是一个**可发现性**问题，不是功能缺失。
2. **OpenCode 采集游标的边界漏读**（见 §2.2）。这是上一轮排查 TPM 量级时顺带发现的潜伏缺陷。

目标：

- 让口径控件在用户看数据的地方就能看到、看懂。
- 补上用户明确点名的「仅输入」档位。
- 修掉 OpenCode 游标的边界漏读，并补上该采集路径**目前为零**的测试覆盖。

## 2. 现状（实测）

### 2.1 口径控件为什么找不到

`StatsPage.tsx:82-174` 的页头是一行 `flex-wrap`，并排塞了**三个外观完全相同的分段控件**
（统一样式 `flex rounded-xl border border-border/70 bg-muted/50 p-0.5` + `aria-pressed`，
与 `ViewSwitcher.tsx:49` / `ScheduledTabBar.tsx:20` / `TaskBoard.tsx:287` 同一惯例），
**且三者都没有任何标题**：

```
[返回] Token 统计 [项目▾] [1时|6时|24时|7天|30天] [全部|仅新增|仅输出] [按模型|按厂商] (模型 chips…)
                            ↑ 时间范围              ↑ 口径（就是它）      ↑ 维度
```

三个控件长得一模一样，口径又恰好在中间。用户分不清哪个管什么，于是完全没注意到口径可切。

### 2.2 OpenCode 游标的边界漏读

`token-usage-ingest.service.ts:225-234` 的增量查询：

```sql
SELECT m.id, m.session_id, m.data, s.directory
FROM message m LEFT JOIN session s ON s.id = m.session_id
WHERE m.time_created > ?          -- ← 游标 lastTsMs
  AND json_extract(m.data, '$.role') = 'assistant'
ORDER BY m.time_created ASC
```

游标推进（同文件 `:243-251`）：

```js
maxTs = Math.max(maxTs, event.tsMs);   // event.tsMs 来自 data.time.created（JSON）
tokenUsageDb.setCursor('opencode', dbPath, { lastTsMs: maxTs });
```

两个缺陷：

**缺陷 1（边界竞态）**：过滤是严格大于。若两条 assistant 消息落在**同一毫秒**，
第二条在本轮扫描之后写入，则它永远满足不了 `time_created > maxTs` → **永久漏读**。

**缺陷 2（两个时钟）**：过滤用列 `m.time_created`，游标推进用 JSON `data.time.created`。
两者是不同的时钟，只是**恰好相等**。一旦出现偏差（JSON 时间更大），游标会越过尚未读到的行 → 漏读。
副作用：解析失败（`parseOpencodeRow` 返回 null）的行不推进游标，会被每轮重复读取。

**实测严重性（必须诚实标注）**：`~/.local/share/opencode/opencode.db` 当前 197 条 assistant 消息，
同毫秒重复 **0 组**，`time_created` 与 `data.time.created` **197/197 完全相等**。
另有 2 条 `time_created` 与插入顺序倒挂的行，但都是 `user` 角色，被 `role='assistant'` 过滤掉。

**结论：两个缺陷目前都未实际造成丢数据，是潜伏缺陷，不是正在丢数据。** 修复的价值是防止将来触发。

### 2.3 现有测试覆盖

`token-usage-ingest.test.ts` 的 7 个 test **全部覆盖 Claude 路径**，OpenCode 与 Codex 路径覆盖为 0。
`scanOpencode` 是本设计要改的函数，目前无任何回归网。

## 3. 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 口径控件位置 | **移进 TPM 卡片标题行**（用户选定） | 控件就在它影响最直接的图旁边；页头减负 |
| 排行卡片的口径可见性 | **只读标注「口径：X」**，不重复渲染控件 | 排行卡片的数字全部随口径变，标注让含义始终可见；避免同屏两个镜像控件被误读成两个独立设置 |
| 游标过滤 | `>` → `>=` | 边界毫秒每轮重读，`dedupe_key` 的 `INSERT OR IGNORE` 保证幂等 |
| 游标时钟 | 改用 `m.time_created` | 与 WHERE 同一时钟，从结构上消除偏差可能 |
| 档位集合 | 全部 / 仅新增 / 仅输入 / 仅输出 | 从「全部」逐步收窄的心智模型；保留「仅新增」因为它给出 input+output 这个不可由其他档组合出的视图 |
| 残留漏读（后插入的早时间戳行） | **不修** | 需要 (time_created, id) 复合游标，当前数据不存在该情况，YAGNI |

## 4. 方案详述 · A 部分：OpenCode 游标

只改 `scanOpencode()`（`token-usage-ingest.service.ts:208-258`），三处：

1. **SELECT 增列** `m.time_created AS time_created`。
2. **WHERE `>` → `>=`**。
3. **游标推进改用 `row.time_created`**，且对**所有取到的行**无条件推进（不再只在解析成功时推进）。

```js
const rows = db.prepare(`...`).all(cursor.lastTsMs) as {
  id: string; session_id: string; data: string;
  directory: string | null; time_created: number;
}[];

const events: TokenUsageEvent[] = [];
let maxTs = cursor.lastTsMs;
for (const row of rows) {
  // 游标与 WHERE 必须用同一个时钟（m.time_created）；
  // 无条件推进，解析失败的行也不该被每轮重读。
  maxTs = Math.max(maxTs, row.time_created);
  const event = parseOpencodeRow(row, row.directory ?? null);
  if (event) events.push(event);
}
```

**行为变化与代价**：

- 每轮多读「`time_created` 恰好等于游标」的行。当前数据下通常 1 行，重复插入被 `INSERT OR IGNORE` 丢弃。
- 事件自身的 `tsMs`（用于图表分桶）仍来自 `data.time.created`，**不变**。游标时钟与事件时钟分离是刻意的：
  前者是采集进度，后者是数据语义。

**残留（明确不修）**：若 opencode 将来把一条 `time_created` **早于当前游标**的 assistant 行后插入，
`>=` 同样救不了——需要 (time_created, id) 复合游标或全表 id 集合。当前数据无此情况。

## 5. 方案详述 · B 部分：口径开关

### 5.1 新增第 4 档

`web/src/components/stats/format.ts`：

```ts
export type TokenMetric = 'all' | 'new' | 'input' | 'output';

export const METRICS: { value: TokenMetric; label: string; hint: string }[] = [
  { value: 'all',    label: '全部',   hint: 'input + output + 缓存读取 + 缓存写入（provider 计费口径）' },
  { value: 'new',    label: '仅新增', hint: 'input + output，排除缓存重读' },
  { value: 'input',  label: '仅输入', hint: '只算 input，不含缓存重读与输出' },
  { value: 'output', label: '仅输出', hint: '只算模型实际生成的内容' },
];
```

`metricValue` 增加 `case 'input': return components.input;`。

新增 `metricLabel(metric: TokenMetric): string`（从 `METRICS` 查表），供排行卡片的只读标注复用，
避免标签文案在两处各写一遍。

### 5.2 后端峰值补一档

`ModelRankCard` 的「峰值 TPM」按口径取 `peakAll` / `peakNew` / `peakOutput`
（`ModelRankCard.tsx:26-35`），新增档位必须有对应峰值，否则切到「仅输入」时峰值列无值。

- `token-usage.db.ts` 的 `ModelPeakRow` 增 `peak_input: number`；
  `aggregateMinutePeaks` 子查询增 `SUM(input_tokens) AS bucket_input`，外层增 `MAX(bucket_input) AS peak_input`。
- `token-usage-query.service.ts` 的 `SummaryModelEntry` 增 `peakInput: number`；`buildSummary` 映射
  `peakInput: peak?.peak_input ?? 0`。
- 前端 `format.ts` 的 `SummaryRow` 增 `peakInput: number`；`mergeSummaryByVendor` 对它取 `max`
  （与其他 `peak*` 一致——瞬时量相加会造出从未发生过的峰值）。

### 5.3 控件搬家

- **`StatsPage.tsx`**：删除页头的 `METRICS` 分段块（`:113-127`），保留 `metric` state 并把
  `metric` / `onMetricChange` 传给 `TpmChartCard`。口径与维度仍是纯前端 state，切换不触发请求。
- **`TpmChartCard.tsx`**：新增 `onMetricChange` prop；在标题行右侧渲染分段控件。
  该行原本是 `flex items-baseline justify-between`（h2 左、回填进度右），改为右侧一个
  `flex flex-wrap items-center gap-2`，容纳「回填进度文本 + 口径控件」，窄屏换行。

### 5.4 排行卡片的只读标注

`ModelRankCard.tsx` 标题行加 muted 后缀：

```
模型用量排行  口径：全部              合计 12.3M tokens
```

文案走 `metricLabel(metric)`。**不渲染可交互控件**——单一真源在 TPM 卡片，避免同屏两个镜像控件。

## 6. 错误处理与边界

- `scanOpencode` 的既有容错（`db.pragma('busy_timeout')`、catch 后本轮跳过、`finally` 里 `db.close()`）
  全部保持；本设计不新增失败模式。
- `rows` 为空时 `maxTs` 保持 `cursor.lastTsMs`，游标不前移，下轮重试——与现状一致。
- 前端新增档位不改变任何请求参数（口径是纯前端换算），因此**后端接口无新增失败路径**。
- 后端新增 `peak_input` 为纯增量字段，旧前端忽略它不受影响。

## 7. 测试

### 后端

**新增 OpenCode 采集测试**（补 `token-usage-ingest.test.ts` 的空白）：

- 夹具：在临时目录用 better-sqlite3 建最小 `opencode.db`，照抄真实 schema 的
  `message`（`id` / `session_id` / `time_created` / `time_updated` / `data`）与 `session`（`id` / `directory`）两表。
- 用例 1（**边界竞态回归**）：插入 ms = T 的 assistant 消息 A → 扫描 → 断言入库 1 条；
  再插入**同一毫秒 T** 的 assistant 消息 B → 扫描 → 断言入库 2 条。
  该用例在修复前必然失败（`>` 使 B 永远读不到）。
- 用例 2（**两个时钟回归**）：插入消息 A，其 `time_created = 1000` 而
  `data.time.created = 999999999`；再插入消息 B，`time_created = 2000`。
  扫描一次后断言 B 已入库——修复前游标会被 A 的 JSON 时间顶到 999999999，B 被永久跳过。
- 用例 3（**幂等**）：连续扫描两次，断言入库数不增。

**峰值查询**：`token-usage-query.test.ts` 补 `buildSummary` 对 `peak_input` 的映射断言。

### 前端

沿用现有 `node:test` + `renderToStaticMarkup`（无 DOM 环境）：

- `format.test.ts`：`metricValue` 对 `'input'` 的取值；`METRICS` 四档顺序与 `metricLabel` 一致性；
  `mergeSummaryByVendor` 对 `peakInput` 取 max。
- `TpmChartCard.test.tsx`：静态渲染断言标题行出现四个档位按钮、当前档带 `aria-pressed="true"`；
  空态分支同样渲染控件（空态下也要能切口径）。
  现有 3 个用例需补传 `onMetricChange`。
- `ModelRankCard`：**新建** `ModelRankCard.test.tsx`（该卡片目前无测试文件）。
  断言标题行出现「口径：仅输出」这类只读标注，且**不含** `aria-pressed` 按钮。

## 8. 范围外（不做）

- 不修「后插入的早时间戳行」漏读（需复合游标）。
- 不改 TPM 归一化规则、分桶阶梯、`cache_read` 占大头的构成条——§7.2 的决策继续有效。
- 不在采集层识别/剔除 thinking-only 重试循环噪声（那是产品语义决策，需另行确认）。
- 不改 Codex 路径（其全量重扫 + 行号去重已天然幂等，无此类游标问题）。

## 9. 验收标准

1. 新增后端测试全绿；`token-usage-ingest.test.ts` 中「同毫秒第二条」用例在修复前失败、修复后通过。
2. `npx tsx --test` 跑 stats 相关测试文件全绿（含前端 format / TpmChartCard / ModelRankCard）。
3. 后端 typecheck 与 lint **零新增**问题（baseline 本就不干净，见既有记忆）。
4. 页头不再出现口径分段控件；TPM 卡片标题行出现四档控件；排行卡片出现「口径：X」只读标注。
5. 切换口径时排行卡片的数字随之变化，且其标注同步更新。
