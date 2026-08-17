# Chat → Task 直达 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 chat 会话页标题栏旁给「属于某任务」的会话显示「● 查看任务」按钮，点击直达 `/task/:taskId`，与任务详情页「打开会话」互逆。

**Architecture:** 后端把已存在的 `getTaskBySessionId` 暴露到 service 出口并新增 `GET /api/tasks/by-session/:sessionId` 路由（注册在 `/:taskId` 之前）；前端加 `api.tasks.bySession` + `useLinkedTask` hook（订阅 `task_upserted`/`websocket_reconnected` 保持新鲜）+ `MainContent` header 右侧按钮。

**Tech Stack:** Express + better-sqlite3（后端）、React + TypeScript + Vite（前端）、`node:test`（两端测试，`npx tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-08-08-chat-to-task-link-design.md`

---

## File Structure

**lovdex-backend/**（独立 git repo）
- Modify: `server/modules/tasks/services/tasks.service.ts` — service 返回对象上新增 `getTaskBySessionId` 出口。
- Modify: `server/modules/tasks/tasks.routes.ts` — 新增 `GET /api/tasks/by-session/:sessionId` 路由（在 `/:taskId` 之前）。
- Modify: `server/modules/tasks/tests/tasks.service.test.ts` — 加 `getTaskBySessionId` 命中/未命中 + decorate 测试。

**lovdex-cli/**（独立 git repo）
- Modify: `src/utils/api.js` — `tasks` 命名空间加 `bySession`。
- Create: `src/hooks/useLinkedTask.ts` — 反查 hook + 导出纯函数 `shouldApplyUpsert`。
- Create: `src/hooks/useLinkedTask.test.ts` — `shouldApplyUpsert` 纯函数测试。
- Modify: `src/components/main-content/view/MainContent.tsx` — header 右侧渲染「查看任务」按钮。

`docs/` 不在任何 git repo 内，spec 无需 commit。

---

## Task 1: 后端 — service 暴露 getTaskBySessionId

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`
- Test: `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: 在 `tasks.service.test.ts` 末尾追加失败测试**

在 `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts` 文件末尾追加：

```ts
test('getTaskBySessionId returns the decorated task for a linked session', () => {
  const row: StoredTask = {
    task_id: 't1', project_path: '/p', title: 't', description: null,
    status: 'in_progress', executor_provider: 'claude', executor_model: null,
    position: 0, session_id: 's1', started_at: null, completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const db = {
    createTask: () => row,
    getTask: (id: string) => (id === 't1' ? row : null),
    getTaskBySessionId: (sid: string) => (sid === 's1' ? row : null),
    listTasks: () => [row],
    updateTask: () => row,
    updateTaskStatus: () => {},
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
  } as unknown as TaskDbLike;
  const svc = createTasksService(db, {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Set(['s1']),
  });
  const got = svc.getTaskBySessionId('s1');
  assert.equal(got?.task_id, 't1');
  assert.equal(got?.approval_pending, true);
  assert.equal(svc.getTaskBySessionId('nope'), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run (在 `lovdex-backend/` 下):
```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: FAIL，`svc.getTaskBySessionId is not a function`（出口尚未暴露）。

- [ ] **Step 3: 在 service 返回对象上暴露 getTaskBySessionId**

在 `lovdex-backend/server/modules/tasks/services/tasks.service.ts` 的 `createTasksService` 返回对象里，紧接 `getTask(taskId: string)` 之后插入：

```ts
    getTaskBySessionId(sessionId: string): TaskRow | null {
      const row = resolveDb.getTaskBySessionId(sessionId);
      return row ? decorate(row) : null;
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: PASS（含新增用例）。

- [ ] **Step 5: typecheck + lint**

Run:
```bash
npm run typecheck && npm run lint
```
Expected: 无错误。

- [ ] **Step 6: commit**

```bash
git checkout -b feat/chat-to-task-link
git add server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): expose getTaskBySessionId on tasks service"
```

---

## Task 2: 后端 — 新增 by-session 路由

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/tasks.routes.ts`

- [ ] **Step 1: 在 `/:taskId` 路由之前插入 by-session 路由**

在 `lovdex-backend/server/modules/tasks/tasks.routes.ts` 中，找到 `// GET /api/tasks/:taskId` 注释所在的 `router.get('/:taskId', ...)` 块，在它**之前**插入：

```ts
  // GET /api/tasks/by-session/:sessionId  (must precede /:taskId so "by-session"
  // isn't captured as a taskId param)
  router.get(
    '/by-session/:sessionId',
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const task = tasksService.getTaskBySessionId(sessionId);
      if (!task) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      res.json({ task });
    }),
  );
```

- [ ] **Step 2: typecheck + lint**

Run:
```bash
npm run typecheck && npm run lint
```
Expected: 无错误。

- [ ] **Step 3: 手验路由（需后端在跑）**

启动后端（`npm run dev`），对一个已知有 `session_id` 的任务，用其 session id 请求：
```bash
curl -s http://localhost:<port>/api/tasks/by-session/<knownSessionId> -H "Authorization: Bearer <token>"
```
Expected: `{"task":{...}}`，task 的 `session_id` 与请求一致。
对一个无关联的 session id 请求：
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/api/tasks/by-session/bogus -H "Authorization: Bearer <token>"
```
Expected: `404`。

- [ ] **Step 4: commit**

```bash
git add server/modules/tasks/tasks.routes.ts
git commit -m "feat(tasks): add GET /api/tasks/by-session/:sessionId route"
```

---

## Task 3: 前端 — api.tasks.bySession

**Files:**
- Modify: `lovdex-cli/src/utils/api.js`

- [ ] **Step 1: 在 tasks 命名空间加 bySession**

在 `lovdex-cli/src/utils/api.js` 的 `tasks: { ... }` 对象里，紧接 `remove:` 之后追加（保留闭合 `},`）：

```js
    bySession: (sessionId) => authenticatedFetch(`/api/tasks/by-session/${encodeURIComponent(sessionId)}`),
```

- [ ] **Step 2: typecheck + lint**

Run (在 `lovdex-cli/` 下):
```bash
npm run typecheck && npm run lint
```
Expected: 无错误。

- [ ] **Step 3: commit**

```bash
git checkout -b feat/chat-to-task-link
git add src/utils/api.js
git commit -m "feat(tasks): add api.tasks.bySession"
```

---

## Task 4: 前端 — useLinkedTask hook + shouldApplyUpsert

**Files:**
- Create: `lovdex-cli/src/hooks/useLinkedTask.ts`
- Test: `lovdex-cli/src/hooks/useLinkedTask.test.ts`

- [ ] **Step 1: 写 shouldApplyUpsert 的失败测试**

创建 `lovdex-cli/src/hooks/useLinkedTask.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldApplyUpsert } from './useLinkedTask';
import type { Task } from '../types/app';

function mkTask(session_id: string | null): Task {
  return {
    task_id: 't1',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'in_progress',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id,
    started_at: null,
    completed_at: null,
    created_at: '',
    updated_at: '',
    approval_pending: false,
  };
}

test('shouldApplyUpsert true when event task session matches', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_upserted', task: mkTask('s1') }, 's1'), true);
});

test('shouldApplyUpsert false on session mismatch', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_upserted', task: mkTask('s2') }, 's1'), false);
});

test('shouldApplyUpsert false when session id is null', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_upserted', task: mkTask('s1') }, null), false);
});

test('shouldApplyUpsert false for non-upsert events', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_deleted' }, 's1'), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
npx tsx --test src/hooks/useLinkedTask.test.ts
```
Expected: FAIL，无法解析 `./useLinkedTask`。

- [ ] **Step 3: 写 hook + shouldApplyUpsert**

创建 `lovdex-cli/src/hooks/useLinkedTask.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../contexts/WebSocketContext';
import { api } from '../utils/api';
import type { Task } from '../types/app';

type LinkedTaskEvent =
  | { kind: 'task_upserted'; task: Task }
  | { kind: 'websocket_reconnected' }
  | { kind?: string };

/**
 * Whether a realtime frame should replace the cached linked task for the given
 * session. Pure so it can be unit-tested without a React renderer.
 */
export function shouldApplyUpsert(
  event: { kind?: string; task?: Task | null },
  sessionId: string | null,
): boolean {
  if (event.kind !== 'task_upserted' || !event.task) return false;
  if (!sessionId) return false;
  return event.task.session_id === sessionId;
}

/**
 * Reverse-lookup the task (if any) linked to a session, and keep it fresh via
 * `task_upserted` / `websocket_reconnected`. A session that isn't linked to any
 * task returns `{ task: null }` (the normal case for an ad-hoc chat) — the 404
 * is expected and silenced.
 */
export function useLinkedTask(sessionId: string | null | undefined): { task: Task | null } {
  const { subscribe } = useWebSocket();
  const [task, setTask] = useState<Task | null>(null);
  const mounted = useRef(true);
  const reqSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback((sid: string) => {
    const seq = ++reqSeq.current;
    api
      .tasks
      .bySession(sid)
      .then(async (res) => {
        if (seq !== reqSeq.current || !mounted.current) return;
        if (!res.ok) {
          setTask(null);
          return;
        }
        const body = (await res.json()) as { task?: Task };
        if (seq !== reqSeq.current || !mounted.current) return;
        setTask(body.task ?? null);
      })
      .catch(() => {
        if (seq === reqSeq.current && mounted.current) setTask(null);
      });
  }, []);

  // Initial / on-session-change fetch.
  useEffect(() => {
    if (!sessionId) {
      setTask(null);
      return;
    }
    refetch(sessionId);
  }, [sessionId, refetch]);

  // Live updates + reconnect replay.
  useEffect(() => {
    if (!subscribe || !sessionId) return;
    return subscribe((event) => {
      const e = event as unknown as LinkedTaskEvent;
      if (shouldApplyUpsert(e, sessionId)) {
        setTask((e as { task: Task }).task);
      } else if (e.kind === 'websocket_reconnected') {
        refetch(sessionId);
      }
    });
  }, [subscribe, sessionId, refetch]);

  return { task };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
npx tsx --test src/hooks/useLinkedTask.test.ts
```
Expected: PASS（4 个用例）。

- [ ] **Step 5: typecheck + lint**

Run:
```bash
npm run typecheck && npm run lint
```
Expected: 无错误。

- [ ] **Step 6: commit**

```bash
git add src/hooks/useLinkedTask.ts src/hooks/useLinkedTask.test.ts
git commit -m "feat(tasks): add useLinkedTask hook for session→task reverse lookup"
```

---

## Task 5: 前端 — MainContent header 渲染「查看任务」按钮

**Files:**
- Modify: `lovdex-cli/src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: 加 imports**

在 `lovdex-cli/src/components/main-content/view/MainContent.tsx` 顶部 import 区，追加：

```ts
import { useNavigate } from 'react-router-dom';

import { useLinkedTask } from '../../../hooks/useLinkedTask';
import { STATUS_META } from '../../tasks/taskStatus';
```

（`useNavigate` 放在 `react` import 之后、其他相对 import 之间，按文件现有分组习惯插入。）

- [ ] **Step 2: 在组件内取 navigate + linkedTask**

在 `MainContent` 函数体内，`const [preview, setPreview] = ...` 之后追加：

```ts
  const navigate = useNavigate();
  const { task: linkedTask } = useLinkedTask(selectedSession?.id ?? null);
```

- [ ] **Step 3: 在 header 右侧渲染按钮**

找到 header 块：

```tsx
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
            <MainContentTitle
              activeTab={activeTab}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              shouldShowTasksTab={false}
            />
          </div>
        </div>
```

在 `</div>`（左侧容器）之后、外层 `</div>` 之前，追加右侧按钮：

```tsx
          {linkedTask && (
            <button
              type="button"
              onClick={() => navigate(`/task/${linkedTask.task_id}`)}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
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

- [ ] **Step 4: typecheck + lint**

Run:
```bash
npm run typecheck && npm run lint
```
Expected: 无错误。

- [ ] **Step 5: commit**

```bash
git add src/components/main-content/view/MainContent.tsx
git commit -m "feat(tasks): show 查看任务 link in chat header for task-linked sessions"
```

---

## Task 6: 端到端手验

**Files:** 无（验证步骤）

- [ ] **Step 1: 起后端 + 前端**

```bash
# lovdex-backend/
npm run dev
# lovdex-cli/
npm run dev
```

- [ ] **Step 2: 闭环验证 task ↔ chat**

1. 在 `/tasks` 新建一个任务，点「开始执行」（或详情页「▶ 开始执行」），让任务绑上 session。
2. 在任务详情页点「打开会话」→ 跳到 `/session/:id`。
3. 确认会话页标题栏右侧出现「● 查看任务」按钮，状态点颜色与任务状态一致（进行中=蓝）。
4. 点「查看任务」→ 跳回 `/task/:taskId`，闭环成立。

- [ ] **Step 3: 普通会话不显示按钮**

侧边栏新建一个普通会话（不关联任何任务），确认标题栏右侧**不出现**「查看任务」按钮。

- [ ] **Step 4: 实时状态点**

在任务会话里让 agent 跑完（session completed → 任务进评审中），确认会话页「查看任务」按钮的状态点颜色从蓝（进行中）变紫（评审中）。

---

## Self-Review

**Spec coverage：**
- §3.1 service 出口 → Task 1。✓
- §3.2 路由（`/:taskId` 之前）→ Task 2。✓
- §3.3 service 测试 → Task 1 Step 1。✓
- §4.1 api 方法 → Task 3。✓
- §4.2 hook（含 shouldApplyUpsert 纯函数、subscribe、reconnect、竞态守卫）→ Task 4。✓
- §4.3 MainContent 按钮 + STATUS_META 颜色 → Task 5。✓
- §4.4 shouldApplyUpsert 纯函数测试 → Task 4 Step 1。✓
- §5 数据流闭环 → Task 6。✓

**Placeholder scan：** 无 TBD/TODO；每步含完整代码或确切命令。✓

**Type consistency：** `getTaskBySessionId(sessionId: string): TaskRow | null`（service）→ 路由返回 `{ task }` → `api.tasks.bySession` → hook 解 `{ task?: Task }` → MainContent 用 `linkedTask.task_id` / `linkedTask.status`，均与 `Task` 接口（`src/types/app.ts:79`）一致。`shouldApplyUpsert` 签名在定义与测试中一致。✓
