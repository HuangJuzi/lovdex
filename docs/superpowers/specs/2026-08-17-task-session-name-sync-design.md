# 任务名称与会话名称双向同步 — 设计

日期：2026-08-17

## 背景

任务与会话是「一个任务对应一个执行会话」的绑定关系。两者的名称在**创建时**已经对齐：

- 会话转任务：任务标题默认取会话名（`buildSessionToTaskPayload` → `resolveSessionTitle`）。
- 任务开始执行：用任务标题给新会话命名（`tasksService.startExecution`），启动时还有
  `backfillSessionNames` 回填空白/占位符会话名。

但**重命名时不同步**：

- 任务详情页改标题（`api.tasks.update({ title })`）→ 关联会话名不变。
- 侧边栏改会话名（`api.renameSession` → `sessionsService.renameSessionById`）→ 关联任务标题不变。

用户在两端看到的名称因此会分叉。

## 目标

任务标题与关联会话名在重命名时保持**双向一致**：

- 改任务标题 → 同步更新关联会话名。
- 改会话名 → 同步更新关联任务标题。

## 接线

- `tasksService` 在 `backend/server/index.js` 创建，持有 `broadcast`（WS 广播
  `task_upserted`）与 `deps: { projectsDb, sessionsDb }`。
- `sessionsService` 是模块单例（`backend/server/modules/providers/services/sessions.service.ts`），
  `renameSessionById` 只改会话名 + 写盘，不广播。
- 任务改名入口唯一：`TaskDetail` → `api.tasks.update({ title })` → `tasksService.updateTask`。
- 会话改名入口唯一：侧边栏 → `api.renameSession` → `sessionsService.renameSessionById`。

## 改动

### 1. 任务 → 会话：`tasks.service.ts` 的 `updateTask`

在任务行更新成功后，若满足以下全部条件，则把关联会话 `custom_name` 同步为新标题：

- `updates.title` 为字符串、`trim()` 后非空；
- 新标题与当前标题不同；
- 任务有 `session_id`（改项目路径时 `session_id` 会被置空，此时不同步）。

同步方式与 `startExecution` 一致：`opts.deps?.sessionsDb?.updateSessionCustomName(session_id, 新标题)`
（只写 DB，不写盘）。

### 2. 会话 → 任务：`sessions.service.ts` 加 hook

仿 `chat-run-registry.service.ts` 的 `setTaskLinkage`，在 `sessions.service.ts` 加：

```ts
type SessionRenameHook = (sessionId: string, name: string) => void;
let sessionRenameHook: SessionRenameHook | null = null;
export function setSessionRenameHook(hook: SessionRenameHook | null): void {
  sessionRenameHook = hook;
}
```

`renameSessionById` 在 `sessionsDb.updateSessionCustomName` + `writeCustomNameToDisk`
之后触发 `sessionRenameHook?.(sessionId, summary)`。

### 3. 会话 → 任务：`tasks.service.ts` 新增 `syncTaskTitleFromSession`

```ts
syncTaskTitleFromSession(sessionId: string, title: string): TaskRow | null {
  const row = resolveDb.getTaskBySessionId(sessionId);
  if (!row) return null;
  const trimmed = title.trim();
  if (!trimmed || trimmed === row.title) return null;
  resolveDb.updateTask(row.task_id, { title: trimmed });
  const updated = resolveDb.getTask(row.task_id) ?? row;
  emit({ kind: 'task_upserted', task: updated, actor: 'user' });
  return decorate(updated);
}
```

`TaskDbLike` 已包含 `getTaskBySessionId` 与 `updateTask`，无需扩展。

### 4. 接线：`backend/server/index.js`

在 `setTaskLinkage(tasksService)` 之后加：

```js
setSessionRenameHook((sessionId, name) => tasksService.syncTaskTitleFromSession(sessionId, name));
```

并把 `setSessionRenameHook` 加入对 `sessions.service` 的既有 import。

## 边界条件

- **无关联会话**：任务改名时 `session_id` 为空 → 不写会话名。
- **改项目**：`updateTask` 改 `projectPath` 时把 `session_id` 置空并删会话 → 不同步。
- **空标题**：任务标题被清空/纯空白 → 跳过，不清空会话名。
- **普通会话**（未关联任务）：hook 触发 → `syncTaskTitleFromSession` 反查不到任务 → 返回 null，no-op。
- **无循环**：任务→会话直接写 `sessions.db`（不走 `renameSessionById`，不触发 hook）；
  会话→任务直接写 `tasks.db`（不走 `updateTask`，不反向写会话）。幂等。
- **未改动的 blur**：标题与会话名分别与当前值相同 → 跳过。

## 范围外 / 保持不变

- 任务→会话只写 DB `custom_name`，不写 provider 磁盘 jsonl（与 `startExecution`、
  `backfillSessionNames` 一致）。App 侧边栏读 DB，App 内名称一致；provider CLI
  自己的会话列表在任务改名后可能仍显示旧名——如需完全对齐可后续补 `writeCustomNameToDisk`。
- 会话改名本就不广播；任务标题同步到会话名后，其他客户端侧边栏仍靠自身刷新——保持不变。
- 创建时的默认命名逻辑（`buildSessionToTaskPayload` / `startExecution` / `backfillSessionNames`）不动。

## 验证

- `backend` 单测：`updateTask` 改标题且有会话 → 会话名更新；无会话 / 空标题 /
  标题未变 / 改项目 → 不更新。`syncTaskTitleFromSession`：关联任务标题更新并广播；
  无任务 / 同名 / 空 → no-op。
- `sessions.service` 单测：`renameSessionById` 在持久化后触发 hook；未注册 hook 不崩。
- `backend` 跑 lint、测试确认无回归。
