# 任务执行会话以任务标题命名 — 设计

日期：2026-08-12
状态：已批准（用户确认）

## 概述

任务点「开始执行」时，后端 `startExecution` 会通过 `sessionsDb.createAppSession()` 新建一个执行会话，其 `custom_name` 为 NULL。侧边栏的会话显示名取自 `custom_name → summary → 新建会话`，而 `summary` 往往是任务的第一条 prompt（一长段描述），不是任务标题——用户无法一眼看出这个会话对应哪个任务。

本次改动：**执行会话创建时，把 `custom_name` 设为任务标题**，让侧边栏直接显示任务名，方便定位「原始 session 在什么位置」。

## 现状确认（线上库抽查）

- 任务 `新建任务优化`（`657d2bf3…`）→ 会话 `926b2226…`：`custom_name = NULL`，`summary` = 那句长 prompt。
- 任务 `【P1·阻塞派发通道】修复 start_task_execution 报 createSession` → 会话 `f43680af…`：同样 `custom_name = NULL`。

即所有经 `startExecution` 创建的任务执行会话目前都没有名字，侧边栏显示的是任务 prompt 的首段。

## 方案：在 `startExecution` 设置 custom_name（方案 A）

对比过的备选：
- **B：把标题透传给 `SessionCreator` 签名**（`(provider, projectPath, isOperator, title?) => string`）→ 改 `createAppSession` 加 `customName` 参数。名字在行创建时原子写入，但改动面大（类型、路由、service、db repo、index.js 接线），且 `createAppSession` 是普通聊天网关入口，加参影响非任务调用方。
- **C：前端在 start-execution 请求体传标题**。冗余——服务端本就有 task 行，无价值。

选定 **A**：最小改动、所有调用方（REST 路由 + operator 的 `start_task_execution` 工具）自动生效。

### 改动点

`server/modules/tasks/services/tasks.service.ts` — `startExecution`：

```ts
const sessionId = createSession(row.executor_provider, row.project_path, Boolean(row.is_operator));
// 用任务标题给新执行会话命名，侧边栏一眼看出这个会话属于哪个任务。
// 新 app 会话 custom_name 为 NULL；claude/codex 同步器会保留非占位符的 custom_name。
if (row.title?.trim()) {
  opts.deps?.sessionsDb?.updateSessionCustomName(sessionId, row.title);
}
resolveDb.linkSession(taskId, sessionId);
```

- `opts.deps?.sessionsDb` 生产环境已注入（`server/index.js` 的 `createTasksService(tasksDb, { deps: { projectsDb, sessionsDb }, … })`），optional chaining 保证单测（不传 deps）不受影响。
- `updateSessionCustomName` 是 `sessionsDb` 既有方法，仅更新 `custom_name`，不动 `updated_at`（会话刚创建，时间戳本就最新）。

## 语义与边界

- **只命名一次**：任务后续改名不联动会话名（避免覆盖用户手动改过的会话名）。「任务改名同步会话名」不在本次范围。
- **空标题跳过**：`row.title` 为空字符串时不写，侧边栏 fallback 到 summary。
- **AI 自动标题不覆盖**：任务会话的 AI 自动标题走 `summary` 列（claude 同步器的 `ai-title` / last-prompt），同步器只在写盘 `custom-title` 时覆盖 `custom_name`——而写盘 `custom-title` 只有用户手动重命名才会发生（`writeCustomNameToDisk`）。所以任务标题会稳定显示，用户手动重命名仍是最高优先级。
- **operator 任务一致生效**：`is_operator` 任务同样命名，行为统一。
- **不改同步器优先级**、**不改 `createAppSession` 签名**。

## 测试

`server/modules/tasks/tests/tasks.service.test.ts` 新增：

1. `startExecution` 用任务标题调用 `sessionsDb.updateSessionCustomName`（stub 记录调用，断言 `sessionId` + `title`）。
2. `row.title` 为空时**不**调用 `updateSessionCustomName`。

回归：跑 `tasks.service.test.ts` 与 `execution-linkage.test.ts`，确认不传 `deps` 的现有用例不受影响（optional chaining）。

## 范围外

- 任务重命名 → 会话名同步。
- 会话网关（普通聊天 `POST /api/providers/sessions`）不命名。
- 前端不做任何改动。
