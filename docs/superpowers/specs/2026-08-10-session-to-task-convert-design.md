# Session → Task 转换 — 设计文档

> 状态：设计定稿 · 2026-08-10
> 定位：在 chat 会话页让「无关联任务的会话」一键转成任务看板上的卡片，并把该会话挂为该任务的执行会话（`tasks.session_id`），补齐 task ↔ chat 的另一个方向。与既有的「查看任务」直达（`2026-08-08-chat-to-task-link-design.md`）互逆。

---

## 1. 背景与目标

任务面板（`/tasks`、`/task/:taskId`）已实现 task → chat 方向（任务卡/详情页「打开会话」一键直达，`startExecution` 会新建会话并挂到任务）。反向 chat → task 目前**只能手工绕**：新建任务 → 放弃/复用，再在会话页无法直接建立关联。

一个很常见的诉求：在某个会话里聊出了实质进展，想把它沉淀成看板上的一个任务继续跟踪。现在没有入口。

**目标**：在 chat 会话页（`MainContent` header 右侧），当当前会话**未关联**任何任务时，显示「转为任务」按钮 → 弹出可编辑确认框 → 创建一张任务卡片，`session_id` 指向当前会话，出现于看板对应状态列。创建成功即自动切换到「查看任务」按钮（复用既有 `useLinkedTask` 的实时联动）。

**不做的**（刻意排除）：
- 不做「会话归档/删除」等其它会话操作——与本次无关。
- 不做 i18n：任务相关文案现状均硬编码中文，保持一致。
- 不清理 `ChatInterface` 的死 props（`tasksEnabled` / `isTaskMasterInstalled` / `onShowAllTasks`）——与本次无关。
- 不引入前端表单库/状态库——直接用现有 `Dialog`/`Button`/`Input` 组件与本地 state。

---

## 2. 关键事实（已核实）

- `tasks` 表已有 `session_id` 列（单向关联：任务→会话）。反查走 `getTaskBySessionId`（`tasks.db.ts` 与 service 均已有）。
- **`createTask` 目前忽略 `status`**：`tasks.service.ts` 里 `input.status` 校验后未传给 db；`tasks.db.ts` 的 INSERT 硬编码 `'backlog'`。本次需要真正落板到 `todo` / `in_progress`，必须把这个存量小 bug 一并修掉。
- `tasks.db.createTask` 的 position 计算固定按 `status='backlog'` 统计，需随 status 参数化。
- 前端 `processingSessions`（`useSessionProtection` 返回的 `ReadonlyMap<string, SessionActivity>`）能判断会话是否正在运行 → 决定默认状态。
- `resolveSessionTitle(session)`（`src/utils/sessionTitle.ts`）按 `custom_name → summary → name → title` 解析展示名，可作任务标题默认值。
- `selectedSession`（`ProjectSession`）携带 `summary`、`provider`；`selectedProject.fullPath` 即任务的 `project_path`。
- 前端测试基建为 `node:test` 纯函数测试（无 React 渲染器）；后端 service 测试为 `node:test` + db stub（`tasks.service.test.ts`）。

---

## 3. 后端改动（lovdex-backend/）

### 3.1 `server/modules/database/repositories/tasks.db.ts` — `createTask`

- 入参增加 `status?: TaskStatus`（默认 `'backlog'`）与 `sessionId?: string | null`。
- INSERT 使用实际 `status`；`position` 的 `MAX(position)+1` 改为按该 status 列统计。
- 镜像 `statusTimestampSets` 语义：`status === 'in_progress'` 时设 `started_at = CURRENT_TIMESTAMP`，`status === 'done'` 时设 `completed_at = CURRENT_TIMESTAMP`。
- 写入 `session_id`。

### 3.2 `server/modules/tasks/services/tasks.service.ts` — `createTask`

- 把 `input.status`（默认 `'backlog'`）真正传给 `resolveDb.createTask`。
- 当 `sessionId` 非空时校验：
  - 会话必须存在（经 `deps.sessionsDb.getSessionById`）→ 否则 `SESSION_NOT_FOUND` 404。
  - 会话 `project_path` 与 `input.projectPath` 归一化后必须一致 → 否则 `SESSION_PROJECT_MISMATCH` 409。
  - 该会话未关联其它任务（`resolveDb.getTaskBySessionId(sessionId)` 为 null）→ 否则 `SESSION_ALREADY_LINKED` 409。
- 校验通过后把 `sessionId` 一并传给 `resolveDb.createTask`。
- `createTasksService` 的 `deps` 增加**可选** `sessionsDb`（现有测试不传不受影响）。

### 3.3 `server/modules/tasks/tasks.routes.ts` — `POST /api/tasks`

- 从 body 读取 `sessionId`（`string | null`）传给 service。

### 3.4 `server/index.js`

- `createTasksService(tasksDb, { deps: { projectsDb, sessionsDb } })` 传入 `sessionsDb`。

### 3.5 后端测试

`server/modules/tasks/tests/tasks.service.test.ts` 新增（沿用现有 db stub，`deps.sessionsDb` 传 stub）：
- 成功：带 `sessionId` 创建 → 返回任务且 `session_id` 正确、`status` 落板正确。
- 会话不存在 → `SESSION_NOT_FOUND`。
- 会话项目不匹配 → `SESSION_PROJECT_MISMATCH`。
- 会话已关联其它任务 → `SESSION_ALREADY_LINKED`。
- 不传 `sessionId` 的行为不变（现有用例回归）。

---

## 4. 前端改动（lovdex-cli/）

### 4.1 `src/components/main-content/view/MainContent.tsx`

- header 右侧逻辑互斥：
  - `linkedTask` 非空 → 现有「● 查看任务」按钮（不变）。
  - `selectedSession` 存在且 `linkedTask == null` → 显示「转为任务」按钮，点击打开确认框。
- 传入确认框所需：`session`、`projectPath`（`selectedProject.fullPath`）、`isRunning`（`processingSessions.has(selectedSession.id)`）。

### 4.2 新建 `src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx`

用现有 `Dialog`/`DialogContent`/`Button`/`Input` 实现，受控 `open`/`onOpenChange`。

预填字段（均可编辑）：
- 标题 ← `resolveSessionTitle(session) ?? ''`（空则要求用户填写，标题为空禁用确认）。
- 描述 ← `session.summary ?? ''`。
- 执行引擎 ← `session.provider`（仅当为 `TaskEngine` 即 `claude`/`codex`，否则默认 `claude`）。
- 状态 ← 默认 `isRunning ? 'in_progress' : 'todo'`，**下拉可手动覆盖**（五态 `backlog/todo/in_progress/in_review/done`）。

确认：`api.tasks.create({ projectPath, title, description, executorProvider, status, sessionId })`。
- 成功 → 关闭；后端广播 `task_upserted`（`session_id` 匹配）使 `useLinkedTask` 自动把按钮切成「查看任务」，无需手动导航。
- 409（`SESSION_ALREADY_LINKED`，并发双击/跨标签页边界）→ 关闭对话框。正常并发下首个成功创建的 `task_upserted` 已把按钮切好；若事件未达（如另一标签页创建的关联），下次进入会话或 WS 重连时 `useLinkedTask` 会重新拉取并显示「查看任务」。
- 其它错误 → 框内提示，保留输入。

### 4.3 纯函数抽离（可测）

`ConvertToTaskDialog.tsx` 导出纯函数 `buildSessionToTaskPayload({ session, projectPath, isRunning })`，返回 `{ title, description, executorProvider, status }`，供组件与测试共用。

### 4.4 前端测试

新建 `src/components/chat/view/subcomponents/ConvertToTaskDialog.test.ts`（`node:test`）：
- `isRunning=true` → 默认 `status='in_progress'`；`false` → `'todo'`。
- provider 回退：`session.provider` 为合法引擎则沿用，否则 `'claude'`。
- 标题/描述取自 `custom_name`/`summary`（走 `resolveSessionTitle` 优先级）。

---

## 5. 数据流与边界

```
会话页（无关联任务）
  → header「转为任务」→ ConvertToTaskDialog（预填 + 可编辑）
  → POST /api/tasks { projectPath, title, description, executorProvider, status, sessionId }
      → 校验（会话存在 / 项目一致 / 未被关联）
      → INSERT tasks(status, session_id, [started_at]) + broadcast task_upserted
  → WS task_upserted(session_id === 当前会话) → useLinkedTask 更新 → 按钮变「查看任务」
```

边界：
- **双链守卫**：一个会话至多关联一个任务；`SESSION_ALREADY_LINKED` 兜底并发双击。
- **空会话（无消息）**：仍可转换，标题留空则需用户填写。
- **运行中转换**：默认 `in_progress`，`started_at` 已设；会话结束后既有 `onSessionStatus('completed')` 驱动 `in_progress → in_review`，与看板联动一致。
- **状态可覆盖**：用户可把默认状态改为任意五态之一；改 `in_progress` 时后端设 `started_at`，改 `done` 时设 `completed_at`（沿用时间戳语义）。

---

## 6. 测试矩阵

| 层 | 测试 | 位置 |
|---|---|---|
| 后端 db | `createTask` 落板 status / 时间戳 / session_id | `database/tests/tasks.db.integration.test.ts`（可选） |
| 后端 service | 带 session 创建 + 三种失败分支 + 回归 | `tasks/tests/tasks.service.test.ts` |
| 前端纯函数 | `buildSessionToTaskPayload` 默认状态/provider 回退/标题描述 | `ConvertToTaskDialog.test.ts` |

---

## 7. 里程碑

单 PR 即可（前端入口 + 后端单请求原子创建，耦合松）：

1. 后端：`tasks.db.createTask` 参数化 status/sessionId → service 校验 + 透传 → 路由读 body → index 注入 `sessionsDb` → service 测试。
2. 前端：`api` 无需改（`tasks.create` 已存在）→ 纯函数 → `ConvertToTaskDialog` → `MainContent` 接线 → 纯函数测试。
3. 手验：① 普通会话点「转为任务」→ 落板 todo 且「查看任务」按钮出现；② 运行中会话 → 默认 in_progress；③ 改状态/改引擎后创建生效；④ 已关联任务的会话不显示「转为任务」。

---

## 8. 参考链接

- 反向直达（查看任务按钮）：`docs/superpowers/specs/2026-08-08-chat-to-task-link-design.md`
- 任务时间戳语义：`docs/superpowers/specs/2026-08-07-task-timestamps-design.md`
- 任务面板：`docs/task-board-design.md`
- 既有反查：`server/modules/tasks/services/tasks.service.ts` 的 `getTaskBySessionId` / `onSessionStatus`