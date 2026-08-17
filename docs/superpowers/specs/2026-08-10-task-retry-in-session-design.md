# 任务「重试」改为在现有会话内续跑 — 设计文档

> 状态：待审 · 2026-08-10
> 定位：任务详情页/看板的「重试」按钮不再新建会话，而是向任务已关联的会话发一条「上次执行中断/出错了，请重试继续完成」，让 agent 带着原上下文继续。

---

## 1. 背景与目标

任务执行失败（`failed` 徽章）后，用户点「重试」。**当前行为**：`startExecution()` → 后端 `POST /api/tasks/:id/start-execution` **总是新建一个 app session** 并重新 link，旧 session 变成孤儿（仍留在侧栏），任务提示词发给**新** session —— agent 从零开始，丢失先前工作和上下文。

**目标**：重试时复用任务已关联的 session，向它发一条续跑消息（`chat.send`）。后端 `chat.send` 对已有 `provider_session_id` 的会话走 `resume: true`，agent 在**同一**会话带全量上下文继续。不新建会话、不留孤儿。

**不做**（刻意排除）：
- 不改后端（`chat.send` resume 路径已就绪）。
- 不改「开始执行」（无 session 的任务仍新建会话 + 发提示词）。
- 不处理「todo 且有 session」时「开始执行」的孤儿问题（同源但超出本次范围）。
- 不做会话存在性预检（stale `session_id` 为已知限制，见 §6）。

---

## 2. 产品方案

### 2.1 消息内容

```
上次执行中断/出错了，请重试继续完成
```

- 不发原任务提示词（`taskPromptOf`）：会话历史里已有，续跑语义更清晰，避免 agent 误以为重新下指令而重开。
- 措辞已覆盖「中断」（崩溃/被杀/重启，transcript 无错误痕迹）与「出错」（错误已入 transcript）两种情况。
- 该消息作为一条 user 消息写入会话 transcript，可审计。

### 2.2 交互

- **入口**：TaskDetail 执行区「↻ 重试」按钮（`task.failed && task.session_id`）；TaskBoard 卡片「↻ 重试」按钮（`task.failed && onStart`）。
- **行为**：点击 → 直接 `chat.send` 到 `task.session_id`，不发 `start-execution` 请求，不刷新任务（状态/徽章由 WS `session_status` → `task_upserted` 链路自动更新）。
- **无 session 防御**：若 `task.session_id` 为空（按钮理论上不出现），回退到 `startExecution()`（新建会话 + 发提示词）。

---

## 3. 架构与数据流

### 3.1 改动文件（仅前端 `lovdex-cli/`）

| 文件 | 改动 |
|---|---|
| `src/components/tasks/taskExecution.ts` | 导出 `TASK_RETRY_MESSAGE`；`buildTaskChatSend(sessionId, task)` 参数化为 `buildTaskChatSend(sessionId, task, content?)`，缺省 `content = taskPromptOf(task)` |
| `src/components/tasks/TaskDetail.tsx` | 新增 `retryTask()`：有 `session_id` → 发重试消息；否则回退 `startExecution()`。重试按钮改调 `retryTask()` |
| `src/components/tasks/TaskBoard.tsx` | `onStart` 处理器加分支：`task.failed && task.session_id` → 发重试消息；否则原 `startExecution(task)` |
| `src/components/tasks/taskExecution.test.ts` | 加 `buildTaskChatSend` content 参数化 + `TASK_RETRY_MESSAGE` 用例 |

**不改**后端（`chat.send` 对已有 `provider_session_id` 的会话已走 `resume: true`）。

### 3.2 数据流

```
用户点重试 (failed && session_id)
  → sendMessage(buildTaskChatSend(session_id, task, TASK_RETRY_MESSAGE))   // type: chat.send
  → 后端 chat-websocket handleChatSend
      → sessionsDb.getSessionById(sessionId) 解析 provider/project_path/provider_session_id
      → chatRunRegistry.startRun({ appSessionId, providerSessionId: 已有值, ... })
      → runtimeOptions.resume = Boolean(provider_session_id) = true
      → provider CLI 以已有 provider session id 恢复 → agent 带上下文继续
  → session_status 'running' → onSessionStatus('running')
      → 任务已在 in_progress → emit task_upserted（recompute decorate → failed=false）→ 徽章清除
  → 完成 → session_status 'completed' → 任务 → in_review（现有状态机，不变）
```

### 3.3 错误处理

| 场景 | 行为 |
|---|---|
| `task.session_id` 为空（防御） | 回退 `startExecution()`（新建会话 + 发提示词） |
| 会话已被删（stale `session_id`） | `chat.send` 返回 `SESSION_NOT_FOUND` 协议错误；现有 UI 无 toast，表现为无反应。**v1 已知限制** |
| 会话有活跃 run（`RUN_IN_PROGRESS`） | 理论上不触发：`failed` 定义即无活跃 run |

---

## 4. 为何不改后端

- `chat.send` → `handleChatSend`（`server/modules/websocket/services/chat-websocket.service.ts:150`）对已有 `provider_session_id` 的会话设 `resume: Boolean(session.provider_session_id)`（`:218`），provider runtime 以该 id 恢复 —— 续跑机制已内建。
- `failed` 徽章是实时装饰（run registry 无活跃 run 且状态 in_progress 时置位）；续跑 run 开始后 `session_status running` 触发 `onSessionStatus('running')` 重发 `task_upserted`，`decorate` 重新计算使 `failed=false` —— 无需后端配合。
- 「开始执行」仍走 `start-execution`（无 session 场景），后端不动。

---

## 5. 测试

**`src/components/tasks/taskExecution.test.ts`**：
- `buildTaskChatSend(sessionId, task)` 不传 content → `content` 为 `taskPromptOf(task)`（回归现有行为）。
- `buildTaskChatSend(sessionId, task, TASK_RETRY_MESSAGE)` → `content` 为重试文案，`sessionId`/options 与默认一致。

**手动验证**：cli `npm run typecheck` + `npx eslint`；E2E（造 failed 任务 → 点重试 → 同 session 收到消息、failed 徽章清除、任务继续）。

---

## 6. 边界与后续

- v1 已知限制：stale `session_id`（会话已被硬删）时重试无反应。后续可在 `chat.send` 返回 `SESSION_NOT_FOUND` 协议错误时自动回退 `start-execution`（需 WS 错误事件管道，本次不做）。
- 后续可选：后端 `start-execution` 改为复用已有 session（方案 B），服务端强制「一任务一会话」，统一处理「todo 且有 session」的孤儿问题。
