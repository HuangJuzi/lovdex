# 任务生命周期时间戳

## 目标

任务页面（看板卡片 + 详情页）的每个任务，无论处于什么状态，都展示一个与当前状态语义对应的时间戳。当前卡片和详情页都没有展示任何时间，尽管后端 `tasks` 表已存有 `created_at` / `updated_at`。

## 语义：每个状态展示最相关的时间点

| 状态 | 卡片展示 | 取值字段（按优先级，第一个非空者） |
|---|---|---|
| backlog / todo | 创建于 X | `created_at` |
| in_progress | 开始于 X | `started_at` → `updated_at` → `created_at` |
| in_review | 完成于 X | `updated_at` → `created_at` |
| done | 完成于 X | `completed_at` → `updated_at` → `created_at` |

兜底链保证**任何任务、任何状态必然能渲染出一个时间戳**。`created_at` 由后端建表保证非空，是最终兜底。

新增两个字段 `started_at` / `completed_at`（可空），在状态流转时写入；不用单一 `status_changed_at`，是为了保留"开始时间"历史，详情页可据此展示执行耗时。

## 后端改动

### 1. `server/modules/database/schema.ts`
`TASKS_TABLE_SCHEMA_SQL` 建表语句增加：
```sql
started_at    DATETIME,
completed_at  DATETIME,
```
（可空，无 DEFAULT）

### 2. `server/modules/database/migrations.ts`
`migrateTasksTable` 中，对已存在的 `tasks` 表用现有 `addColumnToTableIfNotExists` 补两列。存量任务这两列为 NULL，靠兜底链正常显示，后续状态流转时才开始记录。新建表走 schema 已含两列，无需重复 ALTER。

### 3. `server/modules/database/repositories/tasks.db.ts`
仅在状态流转时写入新字段。状态流转只有两个入口：`updateTaskStatus` 和 `moveTask`。集中在一个内部函数 `applyStatusTimestampSideEffects`，按目标 status 决定 SET 片段：
- 目标 `in_progress` → `started_at = CURRENT_TIMESTAMP`（每次重新开始刷新为最近一次开始时间）
- 目标 `done` → `completed_at = CURRENT_TIMESTAMP`
- 目标非 done 且当前为 done → `completed_at = NULL`（任务被重开，完成时间失效）
- 其余不触碰新字段

`updateTaskStatus` / `moveTask` 改为先读当前行（拿旧 status 判断是否离开 done），再带 side-effect SET 一起 UPDATE。`normalizeTaskRow` 扩展覆盖 `started_at` / `completed_at`（同样走 `normalizeTimestamp`，NULL 透传）。

### 4. `server/shared/types.ts`
`TaskRow` 增加：
```ts
started_at: string | null;
completed_at: string | null;
```

## 前端改动

### 1. `src/types/app.ts`
`Task` 增加同样两个字段（`string | null`）。

### 2. 新 helper `src/components/tasks/taskTimestamp.ts`
- `taskTimeLabel(task: Task): { label: string; iso: string }` — 按上面表格返回中文 label 与对应 ISO 时间。
- `formatRelativeTime(iso: string, now: Date): string` — 中文相对时间：刚刚 / X 分钟前 / X 小时前 / X 天前；超过 7 天回退到绝对日期 `YYYY-MM-DD`。非法日期返回 `—`。
- `formatAbsoluteTime(iso: string): string` — 本地 `YYYY-MM-DD HH:mm`。非法日期返回 `—`。

不复用 `src/utils/dateUtils.ts` 的 `formatTimeAgo`：它依赖 i18next `TFunction` 且无中文 locale，任务组件目前是纯中文硬编码（与 `taskStatus.ts` 的 `STATUS_META` 一致），新 helper 保持同一风格、零外部依赖。

### 3. `src/components/tasks/TaskCard.tsx`
在底部 meta 行（project / 引擎 / model 那一行）之后新增一行时间戳：
```tsx
<span className="text-[11px] text-muted-foreground/80" title={formatAbsoluteTime(iso)}>
  {label} {formatRelativeTime(iso, now)}
</span>
```
`now` 用 `new Date()`（卡片是 memo 静态快照，相对时间在每次重渲染时刷新即可，不引入定时器）。

### 4. `src/components/tasks/TaskDetail.tsx`
属性面板（"属性" 卡片）增加时间块，固定显示：
- 创建时间（`created_at`，必有）
- 更新时间（`updated_at`，必有）
- 开始时间（`started_at`，有值才显示）
- 完成时间（`completed_at`，有值才显示）
均用 `formatAbsoluteTime`。

## 测试

### 后端
- `server/modules/database/tests/tasks.db.integration.test.ts`：补用例 — `updateTaskStatus` 进入 in_progress 后 `started_at` 非空；进入 done 后 `completed_at` 非空；从 done 回到 todo 后 `completed_at` 为 null；`moveTask` 同样覆盖。
- `server/modules/tasks/tests/execution-linkage.test.ts`：若已有 in_progress 流转用例，补断言 `started_at` 已写入。

### 前端
- 新增 `src/components/tasks/taskTimestamp.test.ts`：覆盖 `taskTimeLabel` 在 5 个状态下的字段选择与兜底、`formatRelativeTime` 各档位与非法输入、`formatAbsoluteTime`。

## 不在范围内
- 不引入定时器让卡片相对时间逐秒刷新（重渲染时刷新足够）。
- 不改 `formatTimeAgo` / i18n locale。
- 不改任务创建表单、不增加用户可填的时间字段。
- 不展示执行耗时（duration）——仅保留字段供未来扩展，本次详情页只列绝对时间点。

## 风险与回滚
- 新字段为可空 + 兜底链，老库迁移后存量任务立即正常显示，无数据修复脚本需求。
- 迁移用现有 `addColumnToTableIfNotExists`，幂等、可重入。
- 回滚：撤销前端展示即可；后端两列留存无害。
