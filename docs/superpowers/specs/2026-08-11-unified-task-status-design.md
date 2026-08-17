# 统一任务状态（两层模型）设计

**日期**：2026-08-11
**状态**：设计待评审
**范围**：`lovdex-backend` + `lovdex-cli` 跨仓

## 1. 背景与问题

任务域当前存在 4 套互不相通的"状态"概念叠加在同一张卡片上：

| 概念 | 取值 | 存储 | 写入方 |
|---|---|---|---|
| 列状态 `TaskStatus` | `backlog / todo / in_progress / in_review / done` | `tasks.status` | 人拖列 / PATCH / 状态机 |
| AI 判定 `TaskVerdict` | `done / only_plan / needs_review / blocked` | `tasks.verdict` | 头less Claude |
| 实时浮层 | `failed`、`approval_pending`+`pending_tool` | 不落库 | 状态机 / WS |
| 聊天层 | `pending / in_progress / completed` | 无 | chat 工具 |

由此产生的不对齐：

1. `'done'` 一词双义（列状态 vs verdict）；`blocked`/`needs_review`/`only_plan` 无列、不可筛。
2. 同一 5 值 status 列表在后端 3 份、前端 2 份；verdict 4 值后端 3 份。改动漏一处即静默漂移。
3. `failed` 是伪状态（实时由"会话无存活 run"现算），后端重启后所有 in_progress 任务全显失败、无法持久化失败时间、不可筛。
4. AI 判定时机不统一：只有 session exit 0 的会话触发判定；`failed`/`aborted` 无 AI 闭环（本设计保留现状：失败不判 AI）。
5. 前端颜色/文案多份拷贝且不一致（`VerdictBadge` vs `VERDICT_HEADER_*` vs `STATUS_META` 颜色不一致）；`in_review` 时间标签写"完成于"语义矛盾。
6. 详情页"状态"一个页面两种口径：下拉框（列状态）vs 头部实时徽标（含 verdict/失败/审批浮层），可出现打架。
7. `backlog` 与 `todo` 语义几乎无区别，两个列徒增复杂度。

## 2. 目标模型（已确认）

**任务状态分两层**：

- **第一层 `status` — 看板列（4 值，持久化）**：`todo | in_progress | in_review | done`，即 `待办 / 进行中 / 评审 / 完成`。`backlog` 合并进 `todo`。
- **第二层 `sub_status` — 卡片左下角标签**：列内的更细粒度状态，完整枚举含实时派生值与 AI 判定值。

### 2.1 `status`（4 值）

| status | 含义 | 谁能写入 |
|---|---|---|
| `todo` | 待办（含原 backlog） | 创建（默认）、`aborted` 回滚、人拖列 |
| `in_progress` | 执行中，会话存活 | `onSessionStatus('running')`、人拖列 |
| `in_review` | 会话 exit 0，待人验收 | `onSessionStatus('completed')`、人拖列 |
| `done` | 已完成 | 人手动（唯一入口，`applyStatusChange('done')`）|

状态机迁移图（第一层）：

```
todo ──running──> in_progress ──completed──> in_review ──人验收──> done
in_progress ──aborted──> todo
in_progress ──failed──>（status 不动，sub_status='failed'，见 §2.2）
任意 ──人拖列/PATCH──> 任意（项目变更仅限 todo）
```

### 2.2 `sub_status`（完整枚举）

| 值 | 文案 | 归属列 | 来源 |
|---|---|---|---|
| `running` | 会话运行中 | 进行中 | 实时派生 |
| `failed` | 执行失败 | 进行中 | 持久化 |
| `waiting_answer` | 等你回答 | 进行中 | 实时派生（`AskUserQuestion`）|
| `waiting_plan` | 等你确认计划 | 进行中 | 实时派生（`ExitPlanMode`/`exit_plan_mode`）|
| `waiting_approval` | 等你批准 | 进行中 | 实时派生（其它工具）|
| `only_plan` | 计划待执行 | 进行中 | AI 判定，持久化 |
| `needs_review` | 待你决策 | 进行中 | AI 判定，持久化 |
| `blocked` | 需协助 | 进行中 | AI 判定，持久化 |
| `pending_acceptance` | 待你验收 | 评审 | 实时派生 |
| `done` | 已完成 | 评审 | AI 判定，持久化 |

**持久化子集**（DB `tasks.sub_status` 列，CHECK 限定）：`NULL | failed | done | only_plan | needs_review | blocked`

**实时派生值**（后端 `decorate()` 每次读时算，不落库）：`running | waiting_answer | waiting_plan | waiting_approval | pending_acceptance`

### 2.3 有效 `sub_status` 的派生规则（`decorate()`）

按 `status` 分支：

- `status = 'in_progress'`：
  1. `approval_pending` → `waiting_answer` / `waiting_plan` / `waiting_approval`（按 `pending_tool` 分类，operator 关闭时统一 `waiting_approval`）
  2. 否则：持久化 `sub_status` 非空（`failed`/`only_plan`/`needs_review`/`blocked`）→ 该值
  3. 无 → `running`
- `status = 'in_review'`：
  1. 持久化 `sub_status` = `done` → `done`
  2. 无 → `pending_acceptance`
- `status = 'todo' | 'done'`：返回持久化值（可为 `null`）；前端不渲染标签。

### 2.4 门控

- **项目变更**：仅 `status = 'todo'` 允许改 project（原为 backlog/todo）。
- **AI 判定与 status**：
  - verdict = `done` → status **不动**（留在 `in_review`），`sub_status='done'`，人 gate 进完成列。
  - verdict ∈ `{only_plan, needs_review, blocked}` → status **移回 `in_progress`**，`sub_status` = 该值（"进行中的子状态"语义）。
- **人手动状态变更**：`PATCH /move` 只写 `status`，不写 `sub_status`（标签作为历史保留；前端只在进行中/评审列渲染）。

## 3. 数据模型与迁移

### 3.1 新 schema（`tasks` 表）

- `status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','in_review','done'))`
- 新增 `sub_status TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked'))`
- 删除 `verdict` 列；保留 `ai_summary` / `verdict_reason` / `verdict_at`（审计字段，不改名）。

### 3.2 迁移（一次性，`migrateTasksTable` 内）

对每行：
1. `status = 'backlog'` → `status = 'todo'`。
2. `sub_status = verdict`（verdict 非空时），否则 `NULL`。
3. 删除 `verdict` 列。

实现方式：SQLite 改 CHECK + 删列需重建表。单事务内：`RENAME TO tasks_legacy` → 用新 `TASKS_TABLE_SCHEMA_SQL` 建新表 → `INSERT ... SELECT`（含上述映射）→ `DROP TABLE tasks_legacy` → 重建索引。检测用 `sub_status` 列是否存在作为"已迁移"标记（幂等）。

> 与上一版（flat-9）的差异：status CHECK 收为 4 值而非扩到 9；verdict 折进新增的 sub_status 列而非 status。

## 4. 后端机制

### 4.1 定义收口

- `server/shared/task-status.ts`：`TASK_STATUSES`（4 值）、`TaskStatus`、`SUB_STATUSES`（完整 10 值）、`PERSISTED_SUB_STATUSES`（5 值）、`SubStatus`、`isTaskStatus`、`isSubStatus`、`isPersistedSubStatus`、`STATUS_ORDER`。
- `shared/types.ts` / `tasks.db.ts` / `schema.ts` 从该模块引用；verdict 相关类型（`TaskVerdict`/`TASK_VERDICTS`/`isTaskVerdict`）删除。

### 4.2 状态机（`tasks.service.ts`）

- `onSessionStatus('failed')`：`status` 不动，持久化 `sub_status = 'failed'`（调 db 层 `updateTaskSubStatus`）；若已是 failed 则只 emit。
- `onSessionStatus('running')`：原逻辑（status → in_progress），并**清除**持久化 `sub_status = 'failed'`（重试已开始）。
- `onSessionStatus('completed')`：原逻辑（in_progress → in_review），`sub_status` 保持 `NULL`（待 AI 判定）。
- `writeSummary(taskId, { summary, verdict, reason })`：写 `ai_summary`/`verdict_reason`/`verdict_at`，并持久化 `sub_status = verdict`。然后按 §2.4 处理 status：`verdict = 'done'` → status 不动（留在 `in_review`）；`verdict ∈ {only_plan, needs_review, blocked}` → `applyStatusChange(taskId, 'in_progress', 'engine')`（移回进行中列）。删除 `applyVerdict` 与 `auto_move_*` 逻辑。
- `decorate()`：按 §2.3 派生有效 `sub_status`，替换当前分散的 `failed`/`approval_pending`/`pending_tool` 装饰（`approval_pending`/`pending_tool` 字段仍保留供派生与前端分类，但渲染统一走 `sub_status`）。
- `reconcileFailedTasks(getRunningSessionIds)`：启动时把 `status='in_progress'` 且会话无存活 run 的任务持久化 `sub_status='failed'`（取代实时 `failed` flag）。
- `startExecution`：移除 backlog→todo 推进（无 backlog 了）；`createTask` 默认 `status='todo'`。

### 4.3 API

- `TaskRow`：删 `verdict`；增 `sub_status: SubStatus | null`（decorate 后的有效值）。`approval_pending`/`pending_tool` 保留。
- `tasks.routes.ts`：`?status=` 过滤仍用 4 值校验；无其它逻辑变化。
- `operator.tools.ts`：`create_task` 默认 `'todo'`（与 REST 统一）；`write_task_summary` 调 `writeSummary`（写 sub_status）；`move_task` 仍只动 status。

### 4.4 配置

`operator.config.ts`：删除 `auto_move_enabled` / `auto_move_done` / `auto_move_only_plan_to_todo` 三字段（AI 判定不再移列）。`enabled`/`auto_verdict_enabled` 保留。

## 5. 前端渲染

### 5.1 常量收口

- `src/components/tasks/taskStatus.ts`（或 `src/shared/taskStatus.ts`）：
  - `STATUS_ORDER`（4）、`STATUS_META`（4 列 label/color）。
  - `SUB_STATUS_ORDER`（10）、`SUB_STATUS_META`（10 值 label/color，吸收 VerdictBadge + VERDICT_HEADER + 现有实时标签的颜色，全站统一）。
  - `COLUMN_DEFS` 不需要（status 即列，4 列）。

### 5.2 组件

- 新建 `SubStatusBadge.tsx`：输入 `task.sub_status`，输出徽标（label/color 来自 `SUB_STATUS_META`）。替换 `VerdictBadge`、`waitReasonLabel`、`liveHeaderBadge` 的 verdict/失败分支。
- `TaskCard.tsx`：左下角徽标统一 `<SubStatusBadge subStatus={task.sub_status} />`；动作区 `task.status === 'failed'` → `task.sub_status === 'failed'`；`waitReasonLabel` 删除（由 sub_status 覆盖）。
- `TaskDetail.tsx`：头部徽标改读 `task.sub_status`；状态 `<select>` 列 `STATUS_ORDER`（4 值）；"完成度"卡保留（`ai_summary`/`verdict_reason`/`verdict_at`），徽标用 `SubStatusBadge`；删 `VERDICT_HEADER_LABEL/COLOR`、`liveHeaderBadge` 的 verdict 分支、`task.failed` 分支。
- `TaskBoard.tsx`：列 = `STATUS_ORDER`（4 列）；`runTask` 重试判断改 `task.sub_status === 'failed'`。
- 删 `VerdictBadge.tsx`。
- `OperatorSettingsPage.tsx`：删 auto_move 三项设置。
- `taskTimestamp.ts`：`in_review` 标签改"评审于"；新增状态分支。

### 5.3 卡片左下角展示对照（目标）

| status | sub_status | 卡片左下角徽标 |
|---|---|---|
| todo | — | （无）|
| in_progress | running | 会话运行中 |
| in_progress | failed | 执行失败（红）|
| in_progress | waiting_answer | 等你回答（琥珀）|
| in_progress | waiting_plan | 等你确认计划（靛蓝）|
| in_progress | waiting_approval | 等你批准（琥珀）|
| in_progress | only_plan | 计划待执行（蓝）|
| in_progress | needs_review | 待你决策（黄）|
| in_progress | blocked | 需协助（红）|
| in_review | pending_acceptance | 待你验收（紫）|
| in_review | done | 已完成（绿）|
| done | — | （无）|

## 6. 受影响文件清单

**后端 `lovdex-backend/server/`**：
- 新增 `shared/task-status.ts`（status + sub_status 单一来源）
- `shared/types.ts`（`TaskStatus` 4 值、删 `TaskVerdict`、`TaskRow` 增 `sub_status` 删 `verdict`）
- `modules/database/schema.ts`（status CHECK 4 值、增 sub_status 列、删 verdict 列）
- `modules/database/migrations.ts`（`migrateTasksTable`：backlog→todo + verdict→sub_status + 删 verdict 列）
- `modules/database/repositories/tasks.db.ts`（`TASK_STATUSES` 引用、`createTask` 默认 todo、`writeSummary` 写 sub_status、`statusTimestampSets`）
- `modules/tasks/services/tasks.service.ts`（状态机、decorate 派生 sub_status、删 applyVerdict、reconcileFailedTasks、startExecution）
- `modules/tasks/tasks.routes.ts`（类型跟随）
- `modules/operators/operator.tools.ts`（create_task 默认 todo、write_task_summary）
- `modules/operators/operator.config.ts`（删 auto_move_*）
- `index.js`（启动对账接线）

**前端 `lovdex-cli/src/`**：
- `types/app.ts`（`TaskStatus` 4 值、删 `TaskVerdict`、`Task` 增 `sub_status` 删 `verdict`/`verdict_reason`/`verdict_at`？——审计字段是否仍展示待定，见 §8 Q2）
- `components/tasks/taskStatus.ts` / `taskTimestamp.ts`（常量收口）
- `components/tasks/SubStatusBadge.tsx`（新）
- `components/tasks/TaskCard.tsx`、`TaskDetail.tsx`、`TaskBoard.tsx`（渲染统一）
- 删 `components/tasks/VerdictBadge.tsx`
- `components/operators/OperatorSettingsPage.tsx`（删 auto_move 项）

## 7. 测试要点

- **迁移**：构造旧库（含 `backlog` 行、`in_review+verdict=done`、`in_review+verdict=null`、`in_progress`、`done`），跑迁移断言：backlog→todo、verdict→sub_status、verdict 列删除、sub_status CHECK 限定 5 值、幂等。
- **状态机**：`onSessionStatus` 四态；`writeSummary` 写 sub_status 不动 status；`running` 清 failed；`aborted` 回 todo；`reconcileFailedTasks` 标 failed。
- **decorate**：in_progress 各分支（running/failed/waiting_*/only_plan/needs_review/blocked）、in_review 各分支（pending_acceptance/done）的派生正确。
- **前端**：`SUB_STATUS_META` 覆盖完整枚举；卡片/详情徽标单一来源；4 列看板。

## 8. 待决问题（写实现计划前确认）

1. **`verdict_reason`/`verdict_at`/`ai_summary` 是否保留展示**：审计字段保留在 DB；前端"完成度"卡是否继续展示 `verdict_reason`/`verdict_at`？倾向：保留展示（有信息量），但字段名从 `verdict_reason` 改为 `sub_status_reason`？——倾向**保留原名**（verdict_reason/verdict_at/ai_summary 不动，仅前端文案按 sub_status 语义解释）。
2. **前端 `Task` 类型是否删 `verdict` 相关字段**：`verdict` 字段删；`verdict_reason`/`verdict_at` 保留（审计展示），`ai_summary` 保留。倾向：保留三个审计字段，仅删 `verdict`。
3. **`done` 标签与"完成列"同名同文案**：评审列里 AI 判定 done 显示"已完成"（绿），完成列也叫"已完成"。视觉上同文案不同位置，是否需区分（如评审列标签加"AI 判定"前缀）？倾向：不加，保持简洁。

## 9. 风险与回滚

- **迁移重建表**：单事务 + 迁移前备份 `*.db`。检测 `sub_status` 列存在即跳过（幂等）。
- **跨仓协调**：P2 迁移一次重建表，删除 `verdict` 列、新增 `sub_status`。后端先发新字段，旧前端读 `verdict` 会短暂退化（评审列 AI 判定标签显示异常）。缓解：**P2 与 P3 同一轮 ff-merge 两仓到 main + push**，避免长期窗口。
- **backlog→todo 是行为变化**：影响项目变更门控、create 默认、看板列数。迁移一次性完成，回滚需恢复备份。
