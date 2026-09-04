# 任务归档状态（Task Archive Status）设计

日期：2026-09-04
状态：已确认（方案 A + 纯用户动作 + 看板隐藏筛选可查 + 可取消归档）

## 背景与目标

任务看板上的「完成」越积越多，用户很难在项目会话列表和任务看板里找到自己关心的内容。目标是新增一个**归档**状态：

- 归档后，任务与其关联会话**不再出现在项目下的会话列表**里；
- 归档与「完成」的核心区别 = **从项目会话列表中隐藏**；
- 随着任务增多，看板/表格默认不显示归档项，减少干扰。

已确认决策：

- **只有「完成」可归档**。未完成任务必须先到 done。
- **看板不新增第 5 列**：归档任务默认隐藏，通过筛选开关查看。
- **可取消归档**：取消后任务回 done，关联会话在项目下重新显示。
- **AI/引擎不参与归档判断**：`archived` 是纯用户动作，AI verdict（sub_status）与引擎状态转换都不写、不改它。

## 现状（关键事实）

- **两层状态模型**（`backend/server/shared/task-status.ts`）：
  - `status` 4 列：`todo / in_progress / in_review / done`，DB CHECK 约束由 `schema.ts` 里的 `STATUS_CHECK` 生成；
  - `sub_status` 细分标签，AI verdict 落在其中（`done/only_plan/needs_review/blocked`），与 `status` 无关。
- **引擎从不写 done/archived**（`tasks.service.ts`）：
  - 引擎对 `status` 的写入全部带 `row.status === 'in_progress'` 守卫（`running`→in_progress、`completed`→in_review、`aborted`→todo）；
  - 转换目标只有 todo/in_progress/in_review，AI 产出只进 `sub_status`；
  - **因此：任何进入 done 的状态变化都来自用户手动动作**（applyStatusChange + actor='user'）。
- **会话级归档基础设施现成**（`sessions.isArchived`）：
  - `updateSessionIsArchived(sessionId, boolean)` 已存在（软删/恢复共用）；
  - 项目会话列表的全部查询路径已过滤 `isArchived = 0`：`getSessionsByProjectPath` / `getSessionsByProjectPathPage` / `countSessionsByProjectPath` / operator 查询（`getSessionsByProjectPathOperator`）；
  - 因此**把关联会话 isArchived 置 1，项目下自然不再显示**，后端列表查询零改动。
- **任务更新走统一 PATCH**（`tasks.routes.ts`，`PATCH /api/tasks/:taskId`）：
  - status 变更 → `applyStatusChange(taskId, status, 'user')`；
  - 字段更新 → `updateTask`；二者互斥（同一请求不得同时含 status 和字段）。
  - 前端 `updateStatus`（TaskBoard）已走该 PATCH 传 `{status}`。
- **迁移模式**：SQLite 不能 ALTER CHECK，先例（executor engine 扩展）用 rename→recreate→copy→drop 重建 tasks 表（`migrations.ts`）。
- **时间戳守卫**（`tasks.db.ts` `statusTimestampSets`）：`to === 'done'` → 写 `completed_at`；`to !== 'done' && from === 'done'` → 清空 `completed_at`。
- 前端看板无拖拽排序（`/move` 无前端调用方），状态变更全靠按钮 → `updateStatus` → PATCH。

## 总体方案

把 `archived` 作为第 5 个 `status` 值，复用现有机制：

1. **后端**：`TASK_STATUSES` 增加 `'archived'`；`applyStatusChange` 增加两条合法用户路径并带副作用（关联会话 isArchived 翻转）；引擎写入 archived 一律拒绝。
2. **迁移**：重建 tasks 表以接受第 5 个 status（复用 executor-engine 的迁移模式）。
3. **前端**：看板/表格默认隐藏 archived（筛选开关显示）；done 卡片/详情/表格提供「归档」入口；archived 提供「取消归档」。

## 详细设计

### 1. 状态模型（`task-status.ts` / `schema.ts` / `migrations.ts`）

- `TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'archived']`；`TaskStatus` 自动扩展；`STATUS_ORDER` 同序，archived 排最后。
- `schema.ts` 的 `STATUS_CHECK` 由 `TASK_STATUSES.map` 生成 → 自动含 archived；**新增迁移**重建 tasks 表（幂等门控：当前表 SQL 不含 `'archived'` 才执行），rename→recreate→copy→drop，复用 `TASKS_TABLE_SCHEMA_SQL`。
- `statusTimestampSets` 语义补全，保证「归档/取消归档」不破坏完成时间：
  - `done → archived`：离开 done 但不**清空** `completed_at`（归档只是收起来，不是重新打开）；
  - `archived → done`：不**重写** `completed_at`（保留真实完成时点，不做 CURRENT_TIMESTAMP 覆盖）；
  - 其余行为不变（`in_progress → done` 照常写完成时间；`done → todo` 照常清空）。
- `createTask` 拒绝 `status === 'archived'`（任务从 todo 起步，创建即归档无意义）。

### 2. 归档 / 取消归档（`tasks.service.ts`）

**归档**（`applyStatusChange(taskId, 'archived', 'user')`）：
1. 校验当前 `status === 'done'`，否则 400 `INVALID_STATUS`（前置：只有完成可归档）；
2. `updateTaskStatus(taskId, 'archived')`；
3. 清 `sub_status`（与手动 status 变更一致）；
4. 若 `session_id` 存在：`sessionsDb.updateSessionIsArchived(sessionId, true)` —— 项目会话列表随之隐藏（查询已过滤）。

**取消归档**（`applyStatusChange(taskId, 'done', 'user')`）：
1. 校验当前 `status === 'archived'`；
2. `updateTaskStatus(taskId, 'done')`（`completed_at` 不动，见上）；
3. 若 `session_id` 存在：`updateSessionIsArchived(sessionId, false)` —— 会话重新出现于项目列表。

**守卫**（集中在 `applyStatusChange` 的 archived 分支）：
- 合法路径仅 `done → archived` 与 `archived → done`；其余进出 archived 拒绝 400；
- `actor === 'engine'` 且目标是 `archived` → 一律拒绝（双保险；引擎现有转换路径本就不会触发）；
- `moveTask` 目标 `archived` 拒绝（前端无拖拽，纯防御）。

**副作用失败容忍**：会话已不存在（被硬删）时跳过会话操作，不报错，仅任务状态生效。

### 3. 前端类型与元数据

- `web/src/types/app.ts`：`TaskStatus` 加 `'archived'`。
- `taskStatus.ts`：
  - `STATUS_ORDER` / `STATUS_META` 加 `archived`（label「已归档」，灰色系）；
  - `groupByStatus` 自动包含 archived 分组；
  - `taskSessionState`：archived → `'none'`（`canOpenSession` 的 status 白名单天然不含 archived，不显示「打开会话」）。

### 4. 看板 / 表格呈现与筛选

- **看板**：渲染循环遍历 `STATUS_ORDER`，但 archived 列**默认不渲染**；筛选开关打开后渲染（拖至最后）。
- **表格**：`TaskTableView` 行由 `filteredTasks` 决定；archived 默认被过滤，开关打开后出现。
- **筛选开关「显示归档」**：放进 `taskFilter`，作为共享 filter 的一个持久化维度（`localStorage`，看板/表格共用）：
  - `TaskFilter` 增加 `showArchived: boolean`（默认 `false`）；
  - `filterTasks`：`!filter.showArchived` 时排除 `status === 'archived'` 的任务；
  - `normalizeTaskFilter` 兼容旧形状（缺失则 `false`）；
  - 持久化 `localStorage('taskFilter', ...)`，看板/表格共用（切换 view 不丢）；
  - `EMPTY_TASK_FILTER` 加 `showArchived: false`。
- 归档任务卡片以其 `STATUS_META.color` 显示色点，点击可进详情。

> 注：此开关与「表格/看板状态列筛选」是两回事——之前约定的表格状态列筛选是局部 state，**不并入共享 filter**；而「显示归档」跨看板+表格生效，应持久化，故进 taskFilter。两者并存。

### 5. 归档 / 取消归档入口

- **TaskCard**：`done` 状态时，在「✓ 标记完成」下方显示「🗄 归档」按钮；`archived` 状态时显示「↩ 取消归档」。
- **TaskDetail**：状态操作区提供归档/取消归档按钮（与卡片行为一致）。
- **TaskTableView**：行操作列相应提供入口（与卡片一致）。
- 动作全部走现有 `PATCH /api/tasks/:taskId` `{status}` → `updateStatus`（TaskBoard 已有），后端副作用集中，前端不加新 API。

### 6. 错误处理与边界

- 非 done 任务点归档 → 前端不渲染按钮（不存在误点路径）+ 后端 400 兜底（`INVALID_STATUS`）。
- 归档任务带 `started_at / completed_at / ai_summary / verdict_*` 全部保留原值（只改 status + sub_status + 会话 flag）。
- 归档任务在时间筛选（今天/本周…）里仍按原字段参与过滤——一旦打开「显示归档」，它们与其他任务的日期过滤规则一致。

### 7. 测试

- 后端：
  - `task-status-model.test.ts`：TASK_STATUSES / isTaskStatus / STATUS_ORDER 含 archived。
  - 迁移测试：新 DB 建表含 archived；旧 DB（4 状态）升级后 CHECK 接受 archived。
  - `tasks.service.status.test.ts`：
    - `done → archived` 合法 + 会话 isArchived 置 1 + sub_status 清空；
    - `archived → done` 合法 + 会话 isArchived 置 0 + completed_at 不变；
    - `todo → archived`、`archived → in_progress` 拒绝；
    - engine actor 目标 archived 拒绝；
    - 归档时会话不存在 → 仅任务生效不报错；
    - 创建任务 status=archived 拒绝。
  - `statusTimestampSets` 单测：done↔archived 不触碰 completed_at。
- 前端：
  - `taskStatus.test.ts`：STATUS_ORDER / STATUS_META 含 archived。
  - `taskFilter.test.ts`：默认排除 archived；`showArchived: true` 后包含；旧 localStorage 形状归一化。
  - `TaskCard.test.tsx`：done 显示归档、archived 显示取消归档、点击触发 onStatusChange。

## 范围外（YAGNI）

- 不做「归档列常驻」「底部折叠归档区」等替代呈现。
- 不做批量归档。
- 不区分「用户手动归档的会话」与「任务归档触发的会话」——任务取消归档时会一致恢复（可接受，取消归档即表示想重新看到）。