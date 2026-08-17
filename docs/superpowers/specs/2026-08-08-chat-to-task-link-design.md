# Chat → Task 直达 — 设计文档

> 状态：设计定稿 · 2026-08-08
> 定位：在 chat 会话页给「属于某任务」的会话加一个直达该任务详情页的入口，与任务详情页的「打开会话」互逆，闭环 task ↔ chat 双向跳转。

---

## 1. 背景与目标

任务面板（`/tasks`、`/task/:taskId`）已上线，task → chat 方向很顺：任务卡/详情页的「打开会话 / 去批准」直接 `navigate('/session/:id')`，一键直达。

反向 chat → task 目前只能：侧边栏 ViewSwitcher 切到「任务」→ 看板上找对应卡片 → 点进详情页，多绕两步。会话页本身没有任何指向关联任务的入口。

**目标**：在 chat 会话页标题栏旁，给「属于某任务」的会话显示一个「● 查看任务」按钮，点击直达 `/task/:taskId`。状态点颜色随任务状态实时变化。无关联任务的普通会话不显示，零视觉占用。

**不做的**（刻意排除，避免范围蔓延）：
- 不改 ViewSwitcher / 看板切换入口（侧边栏顶部已有，已满足「也能切到看板」的需求）。
- 不清理 `ChatInterface` 里已有的死 props（`tasksEnabled` / `isTaskMasterInstalled` / `onShowAllTasks`）——与本次无关。
- 不做 i18n：任务相关文案（「新建任务」「返回任务面板」等）现状均硬编码中文，本按钮保持一致。

---

## 2. 关键事实（已核实）

- 后端 `tasks.service.ts` 内部已用 `getTaskBySessionId(sessionId)` 驱动 `onSessionStatus` / `onSessionApproval`，但**未暴露到 service 出口、也无对应 REST 路由**。`TaskDbLike` 的 `Pick` 已包含 `'getTaskBySessionId'`。
- 任务 ↔ 会话是**单向关联**：任务行有 `session_id`，会话无 `task_id`。反查只能按 `session_id` 走 `getTaskBySessionId`。
- `decorate(row)` 给任务行盖非持久化的 `approval_pending` 标记（从 run registry 的内存 pending 集合实时算出）。
- 前端 `MainContent.tsx` 的 header 右侧当前是空白区，可放按钮；header 左侧有标题（含会话名/项目名），移动端还有菜单按钮。
- 前端测试用 `node:test`（见 `taskStatus.test.ts`）；后端 service 测试用 `node:test` + db stub（见 `tasks.service.test.ts`），无独立路由测试基建。

---

## 3. 后端改动（lovdex-backend/）

### 3.1 service 出口

`server/modules/tasks/services/tasks.service.ts`：在 `createTasksService` 返回对象上新增

```ts
getTaskBySessionId(sessionId: string): TaskRow | null {
  const row = resolveDb.getTaskBySessionId(sessionId);
  return row ? decorate(row) : null;
},
```

返回值走 `decorate()`，与 `getTask` / `listTasks` 一致地带上 `approval_pending`。`TaskDbLike` 已含该方法，无其他改动。

### 3.2 路由

`server/modules/tasks/tasks.routes.ts`：新增路由，**注册在 `/:taskId` 之前**（避免 `by-session` 被当作 taskId 匹配）：

```
GET /api/tasks/by-session/:sessionId
  命中 → 200 { task: TaskRow }
  未命中 → 404 { error: { code: 'TASK_NOT_FOUND' } }
```

实现照搬 `/:taskId` 的 `asyncHandler` + `AppError` 模式。

### 3.3 测试

`server/modules/tasks/tests/tasks.service.test.ts` 加两个用例（沿用现有 db stub）：
- 有 session 关联 → `getTaskBySessionId(sid)` 返回对应任务（且 `approval_pending` 经 decorate 正确）。
- 无关联 → 返回 null。

---

## 4. 前端改动（lovdex-cli/）

### 4.1 API

`src/utils/api.js`：`tasks` 命名空间加

```js
bySession: (sessionId) => authenticatedFetch(`/api/tasks/by-session/${encodeURIComponent(sessionId)}`),
```

### 4.2 hook

新建 `src/hooks/useLinkedTask.ts`：

```ts
export function useLinkedTask(sessionId: string | null | undefined): { task: Task | null }
```

- `sessionId` 为空 → 直接返回 `{ task: null }`，不发请求。
- `sessionId` 有效 → 调 `api.tasks.bySession(sessionId)`：200 解 `{ task }` 存入 state；404 或出错 → `task: null`（普通会话属正常情况，不报错刷屏）。
- 用 `useWebSocket().subscribe` 订阅：
  - `task_upserted`：若 `event.task.session_id === sessionId` 则用新行替换缓存（状态/批准态实时变）。
  - `websocket_reconnected`：重拉一次，补掉断线期间错过的事件。
- 用 `mounted` ref + 请求序号 ref 防竞态（切换会话时旧响应不覆盖新）。

### 4.3 MainContent

`src/components/main-content/view/MainContent.tsx`：

- 顶部加 `const navigate = useNavigate();` 和 `const { task: linkedTask } = useLinkedTask(selectedSession?.id ?? null);`。
- header 右侧（`<div className="ml-auto">` 风格的空白区）渲染按钮：

```tsx
{linkedTask && (
  <button
    onClick={() => navigate(`/task/${linkedTask.task_id}`)}
    className="flex items-center gap-1.5 rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
    title="查看任务"
  >
    <span
      className="h-2 w-2 rounded-full"
      style={{ background: STATUS_META[linkedTask.status].color }}
    />
    查看任务
  </button>
)}
```

- `STATUS_META` 从 `../../tasks/taskStatus` 导入。
- 无关联任务时不渲染，header 右侧保持原样空白。

### 4.4 测试

前端测试基建是 `node:test` 的**纯函数**测试（见 `taskStatus.test.ts`），无 React hook 渲染器。因此把可测核心从 hook 里抽成纯函数导出，再单测：

`src/hooks/useLinkedTask.ts` 导出纯函数
```ts
// 是否应把这条 task_upserted 事件并入当前会话的缓存
export function shouldApplyUpsert(event: TaskEvent, sessionId: string | null): boolean
```

新建 `src/hooks/useLinkedTask.test.ts`（`node:test`）：
- `shouldApplyUpsert`：同 `session_id` → true；不同 `session_id` → false；`sessionId` 为 null → false。
- （反查 200/404 的行为由后端 service 测试 + 手验覆盖；前端不再 mock fetch。）

---

## 5. 数据流与边界

```
进入 /session/:id
  → useLinkedTask(id)
    → GET /api/tasks/by-session/:id
      → 200 { task } → 渲染「● 查看任务」(颜色 = STATUS_META[task.status].color)
      → 404        → 不渲染
  → WS task_upserted(task.session_id === id) → 实时更新状态点颜色
  → WS websocket_reconnected                  → 重拉
点击按钮 → navigate('/task/:taskId') → 任务详情页
任务详情页「打开会话」→ navigate('/session/:id') → 回到会话页（按钮仍在）
```

边界：
- 普通新建会话（无关联任务）→ 不显示按钮，零视觉占用。
- 一个会话至多关联一个任务（`session_id` 单值），反查唯一。
- `approval_pending` 经 decorate 实时算出，但本按钮只展示状态点颜色，不展示批准态（批准态在任务详情页/看板上已有专门处理，会话页另有 `PermissionRequestsBanner`）。

---

## 6. 测试矩阵

| 层 | 测试 | 位置 |
|---|---|---|
| 后端 service | `getTaskBySessionId` 命中/未命中 + decorate | `tasks/tests/tasks.service.test.ts` |
| 前端纯函数 | `shouldApplyUpsert` 事件过滤（同/异 session_id、null） | `src/hooks/useLinkedTask.test.ts` |

---

## 7. 里程碑

单 PR 即可（改动小、前后端耦合松）：

1. 后端：service 出口 + 路由 + service 测试。
2. 前端：api 方法 + hook + MainContent 接线 + hook 测试。
3. 手验：从任务详情「打开会话」→ 会话页标题栏出现「● 查看任务」→ 点回任务详情，闭环；普通会话不显示按钮。

---

## 8. 参考链接

- 任务面板设计：`docs/task-board-design.md`
- 任务时间戳设计：`docs/superpowers/specs/2026-08-07-task-timestamps-design.md`
- 现有反查能力：`server/modules/tasks/services/tasks.service.ts` 的 `onSessionStatus` / `onSessionApproval`
