# Lovdex 定时任务（Scheduled Tasks）设计

- 日期：2026-08-13
- 状态：设计待评审
- 相关：`docs/superpowers/specs/2026-08-11-lovdex-assistant-project-design.md`、`docs/superpowers/specs/2026-08-10-operator-agent-design.md`

## 1. 背景与目标

Lovdex 目前**没有面向用户的定时任务（cron）能力**：

- `tasks` 表只有一次性 `deadline`（`schema.ts:159`，YYYY-MM-DD），仅前端显示用（`taskDeadline.ts` 算"剩几天/已逾期"），不是触发器。
- 代码里所有 "schedule" 均为**内部调度**：`operator-verdict.service.ts` 的 `scheduleAutoVerdict`（会话完成事件驱动）、`sessions-watcher.service.ts` 的 watcher flush。
- 后端是 supervisor 管理的**单常驻 Node 进程** + SQLite；无定时器、无 cron 库、无通知推送模块（schema 有 `push_subscriptions`/`vapid_keys` 表但无代码使用）。

目标：

- 新增**定时任务**：模板化调度，到点自动建任务；支持**定时执行**（自动跑）与**定时提醒**（只建任务不跑）两种语义。
- **Lovdex助手**能理解并管理定时任务（创建/查看/修改/删除、回答"有什么定时任务/待办"）。

### 1.1 已确认决策

| 决策点 | 结论 |
|---|---|
| 执行方式 | 每条模板可配 `auto_run`（默认 1；提醒类=0，只建任务不跑） |
| 提醒渠道 | **待办提醒记录**：触发/错过生成任务进任务板，下次打开或问助手可见；不引入推送模块 |
| 调度粒度 | 预设（一次性/每天/每周/每月）+ 间隔（每 N 小时/天）+ 完整 cron 表达式 |
| 错过策略 | 停机期间跳过不补跑，但**聚合一条提醒任务**通知用户 |
| 作用域 | 模板带 `project_path`，NULL = Lovdex助手工作区 |

## 2. 关键设计决策

**采用方案 A：独立 `scheduled_tasks` 模板表 + 进程内轮询调度器。**

- 调度模板与执行实例彻底分离：一次触发 = 一条真实 task，verdict/生命周期完全复用现有机制（`tasks.service.ts` 的 `createTask` → `startExecution` → `headless-task-run.service.ts` 的 `startHeadlessTaskRun`），零新基建。
- 提醒就是 `auto_run=0` 的定时任务，语义统一。
- 调度器挂在后端进程内 `setInterval`（每 15s），符合 supervisor 单进程模型。

拒绝的替代方案：

- **方案 B（扩展 tasks 表加 cron 字段）**：把"调度"和"执行实例"塞进同一行，循环任务的 done/re-arm 与 verdict/评审语义冲突；错过追踪、`last_task_id` 回链别扭。
- **方案 C（独立调度进程）**：多一个 systemd 进程、共享 SQLite 连接/锁复杂度，对单用户本地服务过重。

cron 解析用 **croner** 库（支持 cron 表达式 + 时区 + next-run 计算）。

## 3. 数据模型

### 3.1 新表 `scheduled_tasks`（调度模板）

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    schedule_id       TEXT PRIMARY KEY NOT NULL,   -- 模板 id（应用侧 UUID，同 tasks）
    title             TEXT NOT NULL,
    description       TEXT,
    project_path      TEXT,                        -- NULL = Lovdex助手工作区
    executor_provider TEXT NOT NULL DEFAULT 'claude',
    executor_model    TEXT,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
    is_operator       INTEGER DEFAULT 0,           -- project_path 为 NULL 时置 1
    auto_run          INTEGER DEFAULT 1,           -- 触发后是否无人值守跑（提醒类=0）
    schedule_type     TEXT NOT NULL,               -- 'once' | 'interval' | 'cron'
    cron_expr         TEXT,                        -- schedule_type='cron'
    interval_seconds  INTEGER,                     -- schedule_type='interval'
    run_at            DATETIME,                    -- schedule_type='once'（固定时刻）
    timezone          TEXT DEFAULT 'local',        -- croner 支持；默认服务器本地时区
    next_run_at       DATETIME NOT NULL,
    last_run_at       DATETIME,
    last_task_id      TEXT,                        -- 上次触发建的任务 id（结果回链）
    enabled           INTEGER DEFAULT 1,           -- once 触发后自动置 0
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(enabled, next_run_at);
```

> `label` 增加 `'reminder'` 值：错过通知生成的提醒任务打这个标签，任务板/助手可按它过滤。

### 3.2 `tasks` 表加一列 `source_schedule_id`

```sql
ALTER TABLE tasks ADD COLUMN source_schedule_id TEXT;  -- 走现有 addColumnToTableIfNotExists
CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id);
```

触发建的任务回链模板 → 前端显示 "⏰ 定时" 徽标、助手回答"这个任务从哪条定时来"、`last_task_id` 反查。

## 4. 后端改动（lovdex-backend）

### 4.1 建表与迁移

- `server/modules/database/schema.ts`：导出 `SCHEDULED_TASKS_TABLE_SCHEMA_SQL`（上述 SQL），并入 `INIT_SCHEMA_SQL`——启动 `db.exec(INIT_SCHEMA_SQL)`（`init-db.ts:9`）自动建表，现有库升级零成本。
- `server/modules/database/migrations.ts` `runMigrations()`：追加 `addColumnToTableIfNotExists(db, 'tasks', …, 'source_schedule_id', 'TEXT')` + 建 `idx_tasks_source_schedule`（仿现有 `started_at`/`deadline` 迁移写法，约 435-444 行）。
- `server/modules/database/repositories/scheduled-tasks.db.ts`：仿 `tasks.db.ts` 的 repository 模式，提供 `createScheduledTask` / `getScheduledTask` / `listScheduledTasks(filter)` / `updateScheduledTask` / `deleteScheduledTask` / `listDueScheduledTasks(now)` / `listMissedSince(now)`。

### 4.2 调度器服务 `server/modules/scheduler/scheduler.service.ts`

`createSchedulerService({ tasksService, scheduledTasksDb, createSession, startHeadlessTaskRun, broadcast })`，返回 `{ start, stop, tickNow, runNow }`：

- `start()`：先 `reconcileMissedRuns()`（错过通知），再起 `setInterval(tick, 15_000)`。
- `tick()`：**防重入**（`ticking` 标志，dispatch 是 async，单进程也要防重叠）。扫 `listDueScheduledTasks(now)`（`enabled=1 AND next_run_at <= now`），逐条：
  1. `tasksService.createTask`（标题/描述/优先级/label/项目、`source_schedule_id=scheduleId`、`is_operator` 派生）；失败 try/catch 记日志不中断整轮（仿 `reconcileFailedTasks`）。
  2. 回写模板：`last_run_at=now`、`last_task_id`、`next_run_at=computeNext()`；`once` 触发后 `enabled=0`。
  3. `auto_run=1` → `tasksService.startExecution` + `startHeadlessTaskRun`（fire-and-forget，仿 `startTaskRun` 在 `index.js:252` 的写法）。
  4. 广播 `scheduled_task_upserted`（模板更新）+ `task_upserted`（新任务）。
- `computeNext(schedule, from)`：`cron` 用 croner `nextRun`（带 `schedule.timezone`）；`interval` **无漂移**——`next_run_at = 上一次计划触发时刻 + interval_seconds`（沿用 store 里的 `next_run_at`，而非 `now`，相位固定）；`once` 为固定 `run_at`（触发即终，之后 `enabled=0`）。
- **`once` 创建时 `run_at` 已过**：`next_run_at` 就存该过去时刻，首个 tick 立即触发一次并停用（自然支持"设定即补跑"）。
- `runNow(scheduleId)`：手动立即触发一次（不经 tick 防重入，直接走派发逻辑）；**不**推进 `next_run_at`——纯调试/补跑，不影响既定调度。
- `reconcileMissedRuns()`：启动时对 `enabled=1` 且 `next_run_at < now` 的模板，**不补跑**；把错过的模板聚合成**一条**提醒任务（`auto_run=0`、`label='reminder'`、标题 `⏰ 错过 N 次定时触发`、描述列明细：模板标题 + 原定触发时间 + 下次触发），建在 Lovdex助手工作区；重算 `next_run_at`——interval 按固定相位（`next_run_at += interval_seconds` 推进到未来）、cron 取下一个 cron 时刻、`once` 已过未触发 → 按错过处理并 `enabled=0`。
- `stop()`：`clearInterval`（测试用）。

### 4.3 路由 `server/modules/scheduler/scheduler.routes.ts`

挂 `authenticateToken` 下（`index.js`），仿 `tasks.routes.ts`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/scheduled-tasks` | 列表，过滤 `projectPath` / `enabled`；返回含 humanized 调度描述 |
| POST | `/api/scheduled-tasks` | 创建（校验 schedule_type + 对应字段；`is_operator` 由 project_path 派生） |
| GET | `/api/scheduled-tasks/:id` | 单条 |
| PATCH | `/api/scheduled-tasks/:id` | 更新；改调度字段则重算 `next_run_at` |
| DELETE | `/api/scheduled-tasks/:id` | 删模板（不动已生成的任务） |
| POST | `/api/scheduled-tasks/:id/run-now` | 手动触发一次（调试/补跑用） |
| POST | `/api/scheduled-tasks/:id/enable` / `disable` | 启停 |

### 4.4 index.js 接线 + WS 事件

- 构造 `scheduledTasksDb`、`schedulerService`；`startServer()` 里 `schedulerService.start()`（`try/catch`，失败不阻塞启动，记日志）。
- WS 广播扩展 `TaskEvent` 类似的 `ScheduledTaskEvent`：`scheduled_task_upserted` / `scheduled_task_deleted`；触发时同时复用 `task_upserted`。
- `initOperatorHeadless` 注入 `scheduledTasks`（见 §6）。

## 5. 前端改动（lovdex-cli）

### 5.1 类型与工具

- `src/types/app.ts`：`ScheduledTask` 类型（对齐后端字段 + `scheduleLabel`）。
- `src/utils/scheduleLabel.ts`：调度 → humanized 文案（`每天 09:00` / `每 6 小时` / `每周一 10:00` / 一次性时间）；cron 无法 humanize 时原样显示。

### 5.2 视图：任务页第三 tab

- `src/components/tasks/ViewSwitcher.tsx`：board/table 之外加 **"⏰ 定时"** → 新 `ScheduledTasksView.tsx`。
- `ScheduledTasksView.tsx` 表格列：标题、调度（humanized）、项目、自动跑开关、下次触发、上次触发→任务链接（`last_task_id`）、启停/删除。
- 创建/编辑弹窗（`ScheduledTaskForm`）：标题/描述/项目（复用 `projectOptions.ts`）/执行器/优先级/label/`auto_run` 开关 + 调度类型预设 tab（一次性/每天/每周/每月/间隔/cron），实时预览 `next_run_at`。
- 复用现有任务页状态管理（筛选、WS 订阅 `scheduled_task_*` 事件实时刷新）。

### 5.3 定时徽标

- `TaskCard.tsx` / `TaskDetail.tsx`：`source_schedule_id` 非空时显示 `⏰ 定时`，点击跳到对应模板。
- 错过通知任务（`label='reminder'`）在任务板正常展示，标签样式沿用现有 label 徽标。

## 6. Lovdex助手（operator agent）

### 6.1 新工具（`server/modules/operators/operator.tools.ts` 加 5 个）

| 工具 | 输入 | 说明 |
|---|---|---|
| `create_scheduled_task` | `title`(必填)、`description`、`projectPath`(可空=助手工作区)、`scheduleType`、`cronExpr`/`intervalSeconds`/`runAt`、`autoRun`(0/1)、`priority`、`label`、`executorModel` | 建模板 |
| `list_scheduled_tasks` | `projectPath?`、`enabled?` | 列模板（含 nextRunAt/humanized） |
| `get_scheduled_task` | `scheduleId` | 单条 |
| `update_scheduled_task` | `scheduleId` + 可改字段 | 改调度/autoRun/启停 |
| `delete_scheduled_task` | `scheduleId` | 删模板 |

- `OperatorToolDeps` 增加 `scheduledTasks` 服务（仿 `tasks` 注入）；`index.js` 的 `initOperatorHeadless` 接上。
- **zod 约束**：`buildOperatorSdkTools`（`claude-sdk.js:1013-1061`）只支持 **string/number** 属性——`autoRun` 用 0/1 number、`scheduleType` 用 string，全部输入走 string/number，**不改转换器**。

### 6.2 system prompt 更新（两处）

`claude-sdk.js:568`（交互式 Lovdex助手）与 `:1191`（headless 判定）的工具清单补上 5 个定时任务工具，并说明语义：

> 定时任务 = 到点自动建任务的模板；`auto_run=1` 无人值守执行，`auto_run=0` 只生成待办（提醒）；停机错过触发会以一条 label=reminder 的提醒任务通知。被问"有什么定时/待办任务"时用 list_scheduled_tasks + list_tasks 回答。

## 7. 测试

- **后端单测**（内存库 + 假时钟，仿 `tasks.service.test` 模式）：`computeNext`（once/interval/cron）；tick 派发（auto_run 0/1、once 自动停用、防重入、单条失败不中断）；`reconcileMissedRuns`（聚合一条 + interval/cron 重算 + once 停用）；`runNow`。
- **API 测试**：CRUD + run-now + enable/disable + 校验。
- **助手工具测试**：5 个定时工具 pass-through（仿 `operator-tools.test.ts`）。
- **前端**：`ScheduledTasksView` 渲染、表单校验、`scheduleLabel` humanize、定时徽标、WS 实时刷新。

## 8. 风险与权衡

- **调度器依赖主进程存活**：后端挂则调度挂（方案 A 固有权衡）；supervisor 常驻已保证可用性。
- **防重入与幂等**：tick 必须 `ticking` 标志防重叠；dispatch 失败记日志逐条继续。
- **时区语义**：默认服务器本地时区，模板可配 `timezone`；UI 需提示"按服务器时区"。
- **错过聚合粒度**：一条提醒任务聚合所有错过，避免刷屏；明细在描述里。
- **删除模板不动已生成任务**：刻意为之，避免破坏任务板/verdict 历史。
- **`label` 加 `reminder` 值**：`isTaskLabel` 校验（`task-status.ts`）与现有 `LABEL_CHECK` 需同步扩展，现有任务不受影响。

## 9. 验收标准

1. 任务页出现第三个 "⏰ 定时" 视图；可创建一次性/每天/每周/每月/间隔/cron 定时任务，实时预览下次触发。
2. 到点自动建任务进对应项目任务板；`auto_run=1` 的无人值守跑完自动回填 verdict/summary；`auto_run=0` 的留在 todo 作待办提醒。
3. 定时任务生成的任务显示 `⏰ 定时` 徽标，可回链模板。
4. 后端重启：停机期间错过的触发**不补跑**，生成一条 `label=reminder` 的聚合提醒任务；interval/cron 从当前时间重算 next_run_at。
5. Lovdex助手 能创建/列出/修改/删除定时任务，并能回答"有什么定时任务/待办"。
6. 后端/前端/助手工具测试全部通过。
