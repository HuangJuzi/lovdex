# Session → Task 转换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 chat 会话页把「未关联任务的会话」一键转成任务看板卡片，并将该会话挂为该任务的执行会话（`tasks.session_id`）。

**Architecture:** 后端 `POST /api/tasks` 单请求原子创建——`tasks.db.createTask` 参数化 `status`/`sessionId` 并写生命周期时间戳；`tasks.service.createTask` 校验会话存在/项目一致/未被双链后透传。前端 `MainContent` 头部在无关联任务时显示「转为任务」按钮 → 弹 `ConvertToTaskDialog`（标题/描述/引擎/状态可编辑，状态默认运行中→`in_progress` 否则 `todo`）→ 创建成功后靠 `useLinkedTask` 的 WS 联动自动切为「查看任务」。

**Tech Stack:**
- 后端：Node + Express + better-sqlite3 + TypeScript（`@/` alias）。测试用 `npx tsx --test`（**不用** `npm run typecheck`，后端 typecheck 有存量 `utils.ts` Dirent 错误，prod 本就走 tsx）。
- 前端：React + TypeScript + Vite。测试 `npx tsx --test` 需加 `TSX_TSCONFIG_PATH` 环境变量（默认 tsconfig 发现在本环境会误解析 `server/tsconfig.json`）。

**Spec:** `docs/superpowers/specs/2026-08-10-session-to-task-convert-design.md`

**两个仓库**（`docs/` 不在 git）：
- 后端：`/mnt/b/workdir/github/lovdex/lovdex-backend`（git 仓库，当前 `main`）
- 前端：`/mnt/b/workdir/github/lovdex/lovdex-cli`（git 仓库，当前 `main`）

> ⚠️ 两个仓库工作区已有**与本功能无关**的未提交改动（后端 `chat-*.service.ts` 等 5 个文件；前端 `useChatComposerState.ts` 等 3 个文件）。**只 `git add` 本功能涉及的文件**，绝不 `git add -A` / `git add .`，避免把无关改动卷进本功能提交。

---

## 文件结构

**后端（lovdex-backend/）**
- 修改 `server/modules/database/repositories/tasks.db.ts` — `createTask` 参数化 `status`/`sessionId` + 生命周期时间戳。
- 修改 `server/modules/tasks/services/tasks.service.ts` — `createTask` 会话校验 + 透传 `status`/`sessionId`；`deps` 增加 `sessionsDb`。
- 修改 `server/modules/tasks/tasks.routes.ts` — `POST /` 读取 `sessionId`。
- 修改 `server/index.js` — 注入 `sessionsDb`。
- 修改测试 `server/modules/database/tests/tasks.db.integration.test.ts`、`server/modules/tasks/tests/tasks.service.test.ts`。

**前端（lovdex-cli/）**
- 新建 `src/components/chat/view/subcomponents/convertToTaskPayload.ts` — 纯函数 `buildSessionToTaskPayload`。
- 新建 `src/components/chat/view/subcomponents/convertToTaskPayload.test.ts` — 纯函数单测。
- 新建 `src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx` — 确认框组件。
- 修改 `src/components/main-content/view/MainContent.tsx` — 头部按钮 + 接线。

---

## 测试命令（先记牢）

后端（在 `lovdex-backend/`）：
```bash
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts
```

前端（在 `lovdex-cli/`）：
```bash
TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
npm run typecheck   # 前端 typecheck 是干净的，作为前端门禁
npm run lint        # 前端 lint
```

---

## Task 1: 后端 `tasks.db.createTask` 支持 status / sessionId / 生命周期时间戳

**Files:**
- Modify: `lovdex-backend/server/modules/database/repositories/tasks.db.ts`
- Test: `lovdex-backend/server/modules/database/tests/tasks.db.integration.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `tasks.db.integration.test.ts` 末尾追加一个用例（放在 `withIsolatedDatabase` 辅助函数下方）：

```ts
test('tasksDb.createTask honors status + sessionId + lifecycle timestamps', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/conv');

    const running = tasksDb.createTask({
      projectPath: '/tmp/conv',
      title: 'running',
      executorProvider: 'claude',
      status: 'in_progress',
      sessionId: 'sess-running',
    });
    assert.equal(running.status, 'in_progress');
    assert.equal(running.session_id, 'sess-running');
    assert.ok(running.started_at, 'started_at set for in_progress');

    const done = tasksDb.createTask({
      projectPath: '/tmp/conv',
      title: 'done',
      executorProvider: 'codex',
      status: 'done',
      sessionId: 'sess-done',
    });
    assert.equal(done.status, 'done');
    assert.equal(done.session_id, 'sess-done');
    assert.ok(done.completed_at, 'completed_at set for done');

    const backlog = tasksDb.createTask({ projectPath: '/tmp/conv', title: 'b', executorProvider: 'claude' });
    assert.equal(backlog.status, 'backlog');
    assert.equal(backlog.session_id, null);
    assert.equal(backlog.started_at, null);
    assert.equal(backlog.completed_at, null);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts
```
Expected: 新用例 FAIL（`running.status` 当前是 `'backlog'`，断言 `'in_progress'` 失败）。

- [ ] **Step 3: 实现** — 把 `tasks.db.ts` 的 `createTask` 整体替换为：

```ts
  createTask(input: {
    projectPath: string;
    title: string;
    description?: string | null;
    executorProvider: TaskEngine;
    executorModel?: string | null;
    status?: TaskStatus;
    sessionId?: string | null;
  }): TaskRow {
    const db = getConnection();
    const taskId = randomUUID();
    const status = input.status ?? 'backlog';
    const position = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE status = ?').get(status) as { p: number }).p;
    // SQLite 字面量：仅当进入对应状态才写生命周期时间戳（safe，非用户输入）。
    const startedAtSet = status === 'in_progress' ? 'CURRENT_TIMESTAMP' : 'NULL';
    const completedAtSet = status === 'done' ? 'CURRENT_TIMESTAMP' : 'NULL';
    const row = db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${startedAtSet}, ${completedAtSet})
      RETURNING *
    `).get(
      taskId,
      input.projectPath,
      input.title,
      input.description ?? null,
      status,
      input.executorProvider,
      input.executorModel ?? null,
      position,
      input.sessionId ?? null,
    ) as TaskRow;
    return normalizeTaskRow(row);
  },
```

- [ ] **Step 4: 运行确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts
```
Expected: 全部 PASS（含新用例 + 原有 6 个）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/database/repositories/tasks.db.ts server/modules/database/tests/tasks.db.integration.test.ts
git commit -m "feat(tasks): createTask supports status + sessionId + lifecycle timestamps"
```

---

## Task 2: 后端 `tasks.service.createTask` 会话校验 + 透传 status/sessionId

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`
- Test: `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: 更新测试 stub + 写失败测试**

先把 `tasks.service.test.ts` 的 `makeDbStub()` 里 `createTask` 与 `getTaskBySessionId` 升级以响应 status/sessionId（文件顶部 `makeDbStub` 函数内）：

替换 `makeDbStub` 中的：
```ts
    createTask: (input: {
      projectPath: string;
      title: string;
      description?: string | null;
      executorProvider: string;
      executorModel?: string | null;
    }) => {
      const row = { task_id: 't1', ...input, status: 'backlog' };
      tasks.set('t1', row as unknown as StoredTask);
      return row;
    },
```
为：
```ts
    createTask: (input: {
      projectPath: string;
      title: string;
      description?: string | null;
      executorProvider: string;
      executorModel?: string | null;
      status?: string;
      sessionId?: string | null;
    }) => {
      const row = {
        task_id: 't1',
        ...input,
        status: input.status ?? 'backlog',
        session_id: input.sessionId ?? null,
      };
      tasks.set('t1', row as unknown as StoredTask);
      return row;
    },
```

替换 `makeDbStub` 中的：
```ts
    getTaskBySessionId: () => null,
```
为：
```ts
    getTaskBySessionId: (sid: string) => {
      for (const task of tasks.values()) {
        if (task.session_id === sid) return task;
      }
      return null;
    },
```

在文件末尾追加一个会话 stub 辅助函数与四个用例：

```ts
type SessionLike = { session_id: string; project_path: string | null };

function makeSessionStub(rows: Record<string, SessionLike>) {
  return {
    getSessionById: (sid: string) => rows[sid] ?? null,
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
}

test('createTask with a sessionId links the task and honors status', () => {
  const { db } = makeDbStub();
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  const task = svc.createTask({
    title: 'x',
    projectPath: '/p',
    executorProvider: 'claude',
    status: 'todo',
    sessionId: 's1',
  }) as StoredTask;
  assert.equal(task.session_id, 's1');
  assert.equal(task.status, 'todo');
});

test('createTask with a sessionId rejects an unknown session', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({}),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 'nope' }),
    /session not found/,
  );
});

test('createTask with a sessionId rejects a session from another project', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/other' } }),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /does not belong/,
  );
});

test('createTask with a sessionId rejects a session already linked to a task', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /already linked/,
  );
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: 4 个新用例 FAIL（service 当前不校验会话、不透传 status/sessionId）。

- [ ] **Step 3: 实现** — 修改 `tasks.service.ts`：

(a) 顶部 import 改为同时引入 `sessionsDb`：
```ts
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
```

(b) `CreateTaskInput` 增加 `sessionId`：
```ts
type CreateTaskInput = {
  projectPath: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  executorProvider?: TaskEngine;
  executorModel?: string | null;
  sessionId?: string | null;
};
```

(c) `deps` 类型增加 `sessionsDb`：
```ts
    deps?: {
      projectsDb?: typeof projectsDb;
      sessionsDb?: typeof sessionsDb;
      deleteSessionHard?: (sessionId: string) => Promise<void>;
    };
```

(d) 工厂体内 `resolveProject` 旁加 `resolveSession`：
```ts
  const resolveProject = opts.deps?.projectsDb ?? projectsDb;
  const resolveSession =
    opts.deps?.sessionsDb?.getSessionById
    ?? ((_sessionId: string) => null);
```

(e) 把 `createTask` 整体替换为：
```ts
    createTask(input: CreateTaskInput): TaskRow {
      const status = input.status ?? 'backlog';
      const provider = input.executorProvider ?? 'claude';
      if (!isTaskStatus(status)) {
        throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (!isTaskEngine(provider)) {
        throw new AppError(`invalid executor_provider: ${String(provider)}`, { code: 'INVALID_EXECUTOR', statusCode: 400 });
      }
      const project = resolveProject.getProjectPath(input.projectPath);
      if (!project) {
        throw new AppError(`project not found: ${input.projectPath}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      }
      if (input.sessionId != null) {
        const session = resolveSession(input.sessionId);
        if (!session) {
          throw new AppError(`session not found: ${input.sessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        }
        if (normalizeProjectPath(session.project_path ?? '') !== normalizeProjectPath(input.projectPath)) {
          throw new AppError('session does not belong to this project', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 409 });
        }
        if (resolveDb.getTaskBySessionId(input.sessionId)) {
          throw new AppError('session is already linked to a task', { code: 'SESSION_ALREADY_LINKED', statusCode: 409 });
        }
      }
      const row = resolveDb.createTask({
        projectPath: input.projectPath,
        title: input.title,
        description: input.description ?? null,
        status,
        executorProvider: provider,
        executorModel: input.executorModel ?? null,
        sessionId: input.sessionId ?? null,
      });
      emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return decorate(row);
    },
```

(f) 顶部 import 补 `normalizeProjectPath`（`AppError` 已从 `@/shared/utils.js` 引入）：
```ts
import { AppError, normalizeProjectPath } from '@/shared/utils.js';
```

- [ ] **Step 4: 运行确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: 全部 PASS（原 14 个 + 新 4 个）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): createTask validates + links an existing session"
```

---

## Task 3: 后端路由读取 sessionId + index 注入 sessionsDb

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/tasks.routes.ts`
- Modify: `lovdex-backend/server/index.js`

（无独立路由测试基建——由 service 测试 + 后端测试套件回归覆盖。）

- [ ] **Step 1: 修改 `tasks.routes.ts` 的 `POST /`** — 在 `createTask` 调用里加 `sessionId`：

```ts
      const task = tasksService.createTask({
        projectPath: typeof body.projectPath === 'string' ? body.projectPath : '',
        title: typeof body.title === 'string' ? body.title : '',
        description: typeof body.description === 'string' ? body.description : null,
        status: body.status as TaskStatus | undefined,
        executorProvider: body.executorProvider as TaskEngine | undefined,
        executorModel: typeof body.executorModel === 'string' ? body.executorModel : null,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      });
```

- [ ] **Step 2: 修改 `server/index.js`** — `createTasksService` 的 `deps` 加 `sessionsDb`：

```ts
const tasksService = createTasksService(tasksDb, {
    broadcast: broadcastTask,
    deps: { projectsDb, sessionsDb },
    // ...(getPendingApprovalSessions / getRunningSessions 保持不变)
```

（`sessionsDb` 已从 `./modules/database/index.js` 导入，确认第 38 行 import 已含 `sessionsDb`。）

- [ ] **Step 3: 回归验证**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/tasks/tasks.routes.ts server/index.js
git commit -m "feat(tasks): wire sessionId create + inject sessionsDb"
```

---

## Task 4: 前端纯函数 `buildSessionToTaskPayload` + 单测

**Files:**
- Create: `lovdex-cli/src/components/chat/view/subcomponents/convertToTaskPayload.ts`
- Create: `lovdex-cli/src/components/chat/view/subcomponents/convertToTaskPayload.test.ts`

- [ ] **Step 1: 写失败测试** — 新建 `convertToTaskPayload.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionToTaskPayload } from './convertToTaskPayload';
import type { ProjectSession } from '../../../../types/app';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return { id: 's1', ...overrides };
}

test('running session defaults to in_progress, idle session to todo', () => {
  assert.equal(buildSessionToTaskPayload({ session: makeSession(), isRunning: true }).status, 'in_progress');
  assert.equal(buildSessionToTaskPayload({ session: makeSession(), isRunning: false }).status, 'todo');
});

test('title falls back through custom_name → summary', () => {
  const p = buildSessionToTaskPayload({ session: makeSession({ custom_name: '自定义名', summary: '自动摘要' }), isRunning: false });
  assert.equal(p.title, '自定义名');
  const q = buildSessionToTaskPayload({ session: makeSession({ summary: '自动摘要' }), isRunning: false });
  assert.equal(q.title, '自动摘要');
});

test('description defaults to summary', () => {
  const p = buildSessionToTaskPayload({ session: makeSession({ summary: 's' }), isRunning: false });
  assert.equal(p.description, 's');
});

test('provider kept when a task engine, else falls back to claude', () => {
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'codex' }), isRunning: false }).executorProvider, 'codex');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'opencode' }), isRunning: false }).executorProvider, 'claude');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({}), isRunning: false }).executorProvider, 'claude');
});
```

- [ ] **Step 2: 运行确认失败**（模块不存在）

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
```
Expected: FAIL（`Cannot find module './convertToTaskPayload'`）。

- [ ] **Step 3: 实现** — 新建 `convertToTaskPayload.ts`：

```ts
import type { ProjectSession, TaskEngine, TaskStatus } from '../../../../types/app';
import { resolveSessionTitle } from '../../../../utils/sessionTitle';

export type SessionToTaskPayload = {
  title: string;
  description: string;
  executorProvider: TaskEngine;
  status: TaskStatus;
};

function isTaskEngine(value: unknown): value is TaskEngine {
  return value === 'claude' || value === 'codex';
}

/**
 * Compute the conversion dialog's default payload from a session.
 * Pure so it can be unit-tested without a React renderer.
 * Status defaults from the running rule (running → in_progress, else todo);
 * the dialog lets the user override it.
 */
export function buildSessionToTaskPayload(input: {
  session: ProjectSession | null;
  isRunning: boolean;
}): SessionToTaskPayload {
  const session = input.session;
  const title = resolveSessionTitle(session) ?? '';
  const description = typeof session?.summary === 'string' ? session.summary : '';
  const executorProvider = isTaskEngine(session?.provider) ? session.provider : 'claude';
  const status: TaskStatus = input.isRunning ? 'in_progress' : 'todo';
  return { title, description, executorProvider, status };
}
```

- [ ] **Step 4: 运行确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/chat/view/subcomponents/convertToTaskPayload.ts src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
git commit -m "feat(tasks): add buildSessionToTaskPayload pure helper"
```

---

## Task 5: 前端 `ConvertToTaskDialog` 确认框组件

**Files:**
- Create: `lovdex-cli/src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx`

（无 React 渲染测试基建——组件很薄，纯函数已在 Task 4 覆盖；用 typecheck + 手验兜底。）

- [ ] **Step 1: 实现组件** — 新建 `ConvertToTaskDialog.tsx`：

```tsx
import { useEffect, useState } from 'react';

import { Button, Dialog, DialogContent, Input } from '../../../../shared/view/ui';
import { STATUS_META, STATUS_ORDER } from '../../../tasks/taskStatus';
import { api } from '../../../../utils/api';
import type { ProjectSession, TaskEngine, TaskStatus } from '../../../../types/app';
import { buildSessionToTaskPayload } from './convertToTaskPayload';

type ConvertToTaskDialogProps = {
  session: ProjectSession | null;
  projectPath: string;
  isRunning: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ConvertToTaskDialog({
  session,
  projectPath,
  isRunning,
  open,
  onOpenChange,
}: ConvertToTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [executorProvider, setExecutorProvider] = useState<TaskEngine>('claude');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed form state whenever the dialog opens (fresh conversion or a different
  // session). Status defaults from the running rule but is user-editable.
  useEffect(() => {
    if (!open) return;
    const defaults = buildSessionToTaskPayload({ session, isRunning });
    setTitle(defaults.title);
    setDescription(defaults.description);
    setExecutorProvider(defaults.executorProvider);
    setStatus(defaults.status);
    setError(null);
  }, [open, session, isRunning]);

  async function handleCreate() {
    if (!session || submitting) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.tasks.create({
        projectPath,
        title: trimmedTitle,
        description: description.trim() || null,
        executorProvider,
        status,
        sessionId: session.id,
      });
      if (!res.ok) {
        // 409 = the session is already linked (concurrent double-click /
        // another tab). The existing link surfaces via useLinkedTask, so just
        // close. Other errors keep the form open with a message.
        if (res.status === 409) {
          onOpenChange(false);
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `创建失败 (${res.status})`);
        return;
      }
      onOpenChange(false);
    } catch (err) {
      setError('创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-lg p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">转为任务</h2>
        <div className="flex flex-col gap-3 pt-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">标题</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题" autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">描述</span>
            <textarea
              className="min-h-[64px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="任务描述"
              rows={3}
            />
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">执行引擎</span>
              <select
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
                value={executorProvider}
                onChange={(e) => setExecutorProvider(e.target.value as TaskEngine)}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">状态</span>
              <select
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button size="sm" disabled={!title.trim() || submitting} onClick={() => void handleCreate()}>
            创建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 验证编译**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck
```
Expected: 无新增错误（前端 typecheck 干净）。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx
git commit -m "feat(tasks): add ConvertToTaskDialog for session→task conversion"
```

---

## Task 6: 前端 `MainContent` 头部按钮 + 接线

**Files:**
- Modify: `lovdex-cli/src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: 实现** — 在 `MainContent.tsx` 做四处改动：

(a) 顶部 import 增加 `ConvertToTaskDialog`：
```tsx
import { ConvertToTaskDialog } from '../../chat/view/subcomponents/ConvertToTaskDialog';
```

(b) 在 `const { task: linkedTask } = useLinkedTask(...)` 之后加状态与运行判定：
```tsx
  const { task: linkedTask } = useLinkedTask(selectedSession?.id ?? null);
  const [convertOpen, setConvertOpen] = useState(false);
  const sessionRunning = selectedSession ? processingSessions.has(selectedSession.id) : false;
```

(c) 替换 header 右侧的「查看任务」按钮块，在其前加「转为任务」按钮（两者用 `linkedTask` 互斥）：
```tsx
        {selectedProject && selectedSession && !linkedTask && (
          <button
            type="button"
            onClick={() => setConvertOpen(true)}
            className="ml-auto flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-3 text-sm text-foreground transition-colors hover:bg-accent"
            title="转为任务"
          >
            转为任务
          </button>
        )}
        {selectedProject && linkedTask && (
          <button
            type="button"
            onClick={() => navigate(`/task/${linkedTask.task_id}`)}
            className="ml-auto flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-3 text-sm text-foreground transition-colors hover:bg-accent"
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

(d) 在末尾 `FilePreviewModal` 之后渲染对话框：
```tsx
      <ConvertToTaskDialog
        session={selectedSession}
        projectPath={selectedProject?.fullPath ?? ''}
        isRunning={sessionRunning}
        open={convertOpen}
        onOpenChange={setConvertOpen}
      />
```

- [ ] **Step 2: 验证编译 + lint**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck && npm run lint
```
Expected: 无新增错误。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/main-content/view/MainContent.tsx
git commit -m "feat(tasks): add session→task convert button to chat header"
```

---

## Task 7: 全量验证 + 手验清单

- [ ] **Step 1: 后端测试套件**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts
```
Expected: 全 PASS。

- [ ] **Step 2: 前端测试 + typecheck + lint**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
npm run typecheck
npm run lint
```
Expected: 全 PASS。

- [ ] **Step 3: 手验**（后端 `npm run dev` tsx 起服务 + 前端 `npm run dev`）
1. 打开一个**无关联任务**的会话 → 头部显示「转为任务」。
2. 点击 → 弹出确认框，标题/描述有默认值，状态默认 `待做`（若会话在运行则 `进行中`）。
3. 改状态/引擎后点「创建」→ 关闭，头部按钮自动变「● 查看任务」。
4. 到 `/tasks` 看板确认该任务落在所选状态列、会话已关联。
5. 打开一个**已关联任务**的会话 → 头部只显示「查看任务」，不显示「转为任务」。
6. 空标题时「创建」按钮禁用。

- [ ] **Step 4: 收尾提交检查**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git log --oneline -3
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git log --oneline -3
```
Expected: 各 repo 顶部为本功能提交；无关脏文件仍在工作区（未提交、未卷入）。

---

## 验收标准（Spec 对照）

- [ ] `tasks.table` 的 `session_id` 已能通过 `POST /api/tasks` 一步写入（含 `SESSION_NOT_FOUND` / `SESSION_PROJECT_MISMATCH` / `SESSION_ALREADY_LINKED` 三种失败分支）。
- [ ] `createTask` 真正落板 `status`（存量 bug 修复），`in_progress`/`done` 写生命周期时间戳。
- [ ] chat 头部：无关联任务 → 「转为任务」；关联后 → 「查看任务」（互斥）。
- [ ] 确认框字段可编辑，状态默认运行中→`in_progress` 其它→`todo` 且可覆盖。
- [ ] 文档：`docs/superpowers/specs/2026-08-10-session-to-task-convert-design.md`（已存在，本计划不新建）。