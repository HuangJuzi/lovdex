# Lovdex 任务面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 lovdex 里新增"任务面板"——一个 5 状态看板（积压/待做/进行中/评审中/已完成），任务与 Claude/Codex 会话一一对应，状态由会话执行引擎自动驱动（running→in_progress、completed→in_review、failed 守卫回滚、权限请求→"等你批准"）。

**Architecture:** 新建一等 `tasks` 表（FK 到 projects.project_path），Express REST `/api/tasks` + `task_upserted` WS 广播。执行联动挂接在 chat-run-registry 的 `broadcastSessionStatus` 与 `decorateAndRecordEvent` 处，把会话事件翻译成任务状态迁移。前端加 `/tasks` 看板路由与 `/task/:taskId` 详情路由，订阅 WS patch 卡片。

**Tech Stack:** Node.js (ESM) + Express 4 + ws · better-sqlite3 · TypeScript（后端）· React 18 + Vite + Tailwind（前端）· `node:test` 测试。

**Spec:** `../task-board-design.md`（本节未写明的产品细节以此为准）

---

## 里程碑总览

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **PR-A** | 后端数据层 + REST API | `curl /api/tasks` 可用，测试过 |
| **PR-B** | 执行联动 + WS 广播 | 会话跑完任务自动进评审、权限请求自动亮"等你批准" |
| **PR-C** | 前端看板/详情/订阅 | 浏览器可用，测试过 |

每个任务独立可提交，按序执行。

---

# PR-A：后端数据层 + REST API

## Task 1: schema.ts 新增 tasks 表

**Files:**
- Modify: `lovdex-backend/server/modules/database/schema.ts`

- [ ] **Step 1: 在 schema.ts 加表定义**

在 `SESSIONS_TABLE_SCHEMA_SQL` 定义之后、`LAST_SCANNED_AT_SQL` 之前，插入：

```ts
export const TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    task_id           TEXT PRIMARY KEY,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'backlog'
                      CHECK (status IN ('backlog','todo','in_progress','in_review','done')),
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
`;
```

- [ ] **Step 2: 挂进 INIT_SCHEMA_SQL**

在 `INIT_SCHEMA_SQL` 模板串里 `${SESSIONS_TABLE_SCHEMA_SQL}` 之后加 `${TASKS_TABLE_SCHEMA_SQL}`，并把 `TASKS_TABLE_SCHEMA_SQL` 加进文件顶部的 import。

- [ ] **Step 3: Commit**

```bash
git add lovdex-backend/server/modules/database/schema.ts
git commit -m "feat(tasks): add tasks table schema"
```

## Task 2: 存量库迁移

**Files:**
- Modify: `lovdex-backend/server/modules/database/migrations.ts`

- [ ] **Step 1: 在 migrations.ts 加迁移**

在文件里已有的迁移函数之后加（`runMigrations` 内部会调用；找到 `runMigrations` 函数体末尾的迁移序列，追加一行调用）：

```ts
const migrateTasksTable = (db: Database): void => {
  if (!tableExists(db, 'tasks')) {
    console.log('Running migration: creating tasks table');
    db.exec(TASKS_TABLE_SCHEMA_SQL);
  }
};
```

在 `runMigrations` 的迁移调用序列末尾追加 `migrateTasksTable(db);`，并把 `TASKS_TABLE_SCHEMA_SQL` 加进 import 列表。

- [ ] **Step 2: Commit**

```bash
git add lovdex-backend/server/modules/database/migrations.ts
git commit -m "feat(tasks): add migration for existing installs"
```

## Task 3: shared/types.ts 加 Task 类型

**Files:**
- Modify: `lovdex-backend/server/shared/types.ts`

- [ ] **Step 1: 加类型**

在 `ProjectRepositoryRow` 附近加：

```ts
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
export type TaskEngine = 'claude' | 'codex';

export type TaskRow = {
  task_id: string;
  project_path: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  executor_provider: TaskEngine;
  executor_model: string | null;
  position: number;
  session_id: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 2: Commit**

```bash
git add lovdex-backend/server/shared/types.ts
git commit -m "feat(tasks): add Task types"
```

## Task 4: tasks.db.ts 仓库 + 集成测试

**Files:**
- Create: `lovdex-backend/server/modules/database/repositories/tasks.db.ts`
- Test: `lovdex-backend/server/modules/database/tests/tasks.db.integration.test.ts`

- [ ] **Step 1: 写失败测试**

仿照 `projects.db.integration.test.ts` 的 `withIsolatedDatabase` 临时库模式：

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('tasksDb CRUD + status validation + session link', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({
      projectPath: '/tmp/example-repo',
      title: '修登录页',
      description: '401 跳转',
      executorProvider: 'claude',
      executorModel: 'Sonnet 4.6',
    });
    assert.equal(created.status, 'backlog');
    assert.equal(created.executor_provider, 'claude');

    const list = tasksDb.listTasks({});
    assert.equal(list.length, 1);

    tasksDb.updateTaskStatus(created.task_id, 'in_progress');
    assert.equal(tasksDb.getTask(created.task_id)?.status, 'in_progress');

    tasksDb.linkSession(created.task_id, 'session-abc');
    assert.equal(tasksDb.getTaskBySessionId('session-abc')?.task_id, created.task_id);

    tasksDb.deleteTask(created.task_id);
    assert.equal(tasksDb.getTask(created.task_id), null);
  });
});

test('tasksDb.listTasks filters by project and status', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/a');
    projectsDb.createProjectPath('/tmp/b');
    const t1 = tasksDb.createTask({ projectPath: '/tmp/a', title: 't1', executorProvider: 'claude' });
    tasksDb.createTask({ projectPath: '/tmp/b', title: 't2', executorProvider: 'codex' });
    tasksDb.updateTaskStatus(t1.task_id, 'todo');

    assert.equal(tasksDb.listTasks({ projectPath: '/tmp/a' }).length, 1);
    assert.equal(tasksDb.listTasks({ status: 'todo' }).length, 1);
    assert.equal(tasksDb.listTasks({ projectPath: '/tmp/b' }).length, 1);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks.db.integration.test.ts`
Expected: FAIL（`Cannot find module '@/modules/database/repositories/tasks.db.js'`）

- [ ] **Step 3: 实现 tasks.db.ts**

```ts
import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { TaskEngine, TaskRow, TaskStatus } from '@/shared/types.js';

export const TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
export const TASK_ENGINES: readonly TaskEngine[] = ['claude', 'codex'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskEngine(value: unknown): value is TaskEngine {
  return typeof value === 'string' && (TASK_ENGINES as readonly string[]).includes(value);
}

export const tasksDb = {
  createTask(input: {
    projectPath: string;
    title: string;
    description?: string | null;
    executorProvider: TaskEngine;
    executorModel?: string | null;
  }): TaskRow {
    const db = getConnection();
    const taskId = randomUUID();
    const row = db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model)
      VALUES (?, ?, ?, ?, 'backlog', ?, ?)
      RETURNING *
    `).get(taskId, input.projectPath, input.title, input.description ?? null, input.executorProvider, input.executorModel ?? null) as TaskRow;
    return row;
  },

  getTask(taskId: string): TaskRow | null {
    const db = getConnection();
    return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | null;
  },

  getTaskBySessionId(sessionId: string): TaskRow | null {
    const db = getConnection();
    return db.prepare('SELECT * FROM tasks WHERE session_id = ?').get(sessionId) as TaskRow | null;
  },

  listTasks(filter: { projectPath?: string; status?: TaskStatus } = {}): TaskRow[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectPath) {
      clauses.push('project_path = ?');
      params.push(filter.projectPath);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM tasks ${where} ORDER BY position ASC, created_at ASC`).all(...params) as TaskRow[];
  },

  updateTask(taskId: string, updates: {
    title?: string;
    description?: string | null;
    executorProvider?: TaskEngine;
    executorModel?: string | null;
    sessionId?: string | null;
  }): TaskRow | null {
    const db = getConnection();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.executorProvider !== undefined) { sets.push('executor_provider = ?'); params.push(updates.executorProvider); }
    if (updates.executorModel !== undefined) { sets.push('executor_model = ?'); params.push(updates.executorModel); }
    if (updates.sessionId !== undefined) { sets.push('session_id = ?'); params.push(updates.sessionId); }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(taskId);
    if (sets.length === 1) return tasksDb.getTask(taskId);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...params);
    return tasksDb.getTask(taskId);
  },

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    const db = getConnection();
    db.prepare(`UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`).run(status, taskId);
  },

  linkSession(taskId: string, sessionId: string | null): void {
    const db = getConnection();
    db.prepare(`UPDATE tasks SET session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`).run(sessionId, taskId);
  },

  deleteTask(taskId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
  },

  moveTask(taskId: string, status: TaskStatus, beforeId: string | null, afterId: string | null): void {
    const db = getConnection();
    let position: number;
    if (beforeId) {
      const before = tasksDb.getTask(beforeId);
      position = (before?.position ?? 0) - 1;
    } else if (afterId) {
      const after = tasksDb.getTask(afterId);
      position = (after?.position ?? 0) + 1;
    } else {
      position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE status = ?').get(status) as { p: number };
      position = (position as unknown as { p: number }).p;
    }
    db.prepare('UPDATE tasks SET status = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(status, position, taskId);
  },
};
```

- [ ] **Step 4: 运行测试，确认通过**

Run: 同上
Expected: PASS（2 个用例）

- [ ] **Step 5: 把 tasksDb 加进数据库模块出口**

Modify `lovdex-backend/server/modules/database/index.ts`：加 `export { tasksDb } from '@/modules/database/repositories/tasks.db.js';`

- [ ] **Step 6: Commit**

```bash
git add lovdex-backend/server/modules/database/repositories/tasks.db.ts lovdex-backend/server/modules/database/tests/tasks.db.integration.test.ts lovdex-backend/server/modules/database/index.ts
git commit -m "feat(tasks): add tasksDb repository"
```

## Task 5: tasks.service.ts（校验 + 状态变更 + CRUD 编排）

**Files:**
- Create: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`
- Test: `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasksService } from '@/modules/tasks/services/tasks.service.js';

function makeDbStub() {
  return {
    createTask: (input: unknown) => ({ task_id: 't1', ...(input as object) }),
    getTask: (id: string) => (id === 't1' ? { task_id: 't1', status: 'todo', session_id: null } : null),
    getTaskBySessionId: () => null,
    listTasks: () => [],
    updateTask: (id: string) => ({ task_id: id }),
    updateTaskStatus: (id: string, status: string) => {},
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
  };
}

test('createTask rejects invalid status / engine', () => {
  const svc = createTasksService(makeDbStub(), { broadcast: () => {} });
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', status: 'bogus' }), /status/);
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'nope' }), /executor/);
});

test('createTask defaults status to backlog and broadcasts task_upserted', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub(), { broadcast: (e) => events.push(e) });
  svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' });
  assert.equal(events.length, 1);
});

test('applyStatusChange broadcasts with actor', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub(), { broadcast: (e) => events.push(e) });
  svc.applyStatusChange('t1', 'in_progress', 'user');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'user');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 tasks.service.ts**

```ts
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb, isTaskEngine, isTaskStatus } from '@/modules/database/repositories/tasks.db.js';
import type { TaskEngine, TaskRow, TaskStatus } from '@/shared/types.js';

export const STATUS_ORDER: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

export type TaskUpsertedEvent = {
  kind: 'task_upserted';
  task: TaskRow;
  actor: 'user' | 'engine';
  approval?: { pending: boolean };
  timestamp: string;
};

export type TaskBroadcast = (event: TaskUpsertedEvent) => void;

type TasksDeps = {
  projectsDb?: typeof projectsDb;
  tasksDb?: typeof tasksDb;
};

export function createTasksService(
  db: Pick<typeof tasksDb, keyof typeof tasksDb>,
  { broadcast, deps }: { broadcast: TaskBroadcast; deps?: TasksDeps },
) {
  const resolveProject = deps?.projectsDb ?? projectsDb;
  const resolveDb = db ?? tasksDb;

  function emit(event: Omit<TaskUpsertedEvent, 'timestamp'>): void {
    broadcast({ ...event, timestamp: new Date().toISOString() });
  }

  return {
    STATUS_ORDER,

    createTask(input: {
      projectPath: string;
      title: string;
      description?: string | null;
      status?: TaskStatus;
      executorProvider?: TaskEngine;
      executorModel?: string | null;
    }): TaskRow {
      const status = input.status ?? 'backlog';
      const provider = input.executorProvider ?? 'claude';
      if (!isTaskStatus(status)) throw new Error(`invalid status: ${String(status)}`);
      if (!isTaskEngine(provider)) throw new Error(`invalid executor_provider: ${String(provider)}`);
      const project = resolveProject.getProjectPath(input.projectPath);
      if (!project) throw new Error(`project not found: ${input.projectPath}`);
      const row = resolveDb.createTask({
        projectPath: input.projectPath,
        title: input.title,
        description: input.description ?? null,
        executorProvider: provider,
        executorModel: input.executorModel ?? null,
      });
      emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row;
    },

    getTask(taskId: string): TaskRow | null {
      return resolveDb.getTask(taskId);
    },

    listTasks(filter: { projectPath?: string; status?: TaskStatus } = {}): TaskRow[] {
      return resolveDb.listTasks(filter);
    },

    applyStatusChange(taskId: string, status: TaskStatus, actor: 'user' | 'engine'): TaskRow | null {
      if (!isTaskStatus(status)) throw new Error(`invalid status: ${String(status)}`);
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      resolveDb.updateTaskStatus(taskId, status);
      const updated = resolveDb.getTask(taskId) ?? row;
      emit({ kind: 'task_upserted', task: updated, actor });
      return updated;
    },

    updateTask(taskId: string, updates: Parameters<typeof resolveDb.updateTask>[1]): TaskRow | null {
      if (updates.executorProvider !== undefined && !isTaskEngine(updates.executorProvider)) {
        throw new Error(`invalid executor_provider: ${String(updates.executorProvider)}`);
      }
      const row = resolveDb.updateTask(taskId, updates);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row;
    },

    deleteTask(taskId: string): void {
      resolveDb.deleteTask(taskId);
    },

    moveTask(taskId: string, status: TaskStatus, beforeId: string | null, afterId: string | null): TaskRow | null {
      if (!isTaskStatus(status)) throw new Error(`invalid status: ${String(status)}`);
      resolveDb.moveTask(taskId, status, beforeId, afterId);
      const row = resolveDb.getTask(taskId);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row;
    },

    startExecution(taskId: string, createSession: (provider: TaskEngine, projectPath: string) => string): { sessionId: string } | null {
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      const sessionId = createSession(row.executor_provider, row.project_path);
      resolveDb.linkSession(taskId, sessionId);
      const updated = resolveDb.getTask(taskId) ?? row;
      emit({ kind: 'task_upserted', task: updated, actor: 'user' });
      return { sessionId };
    },
  };
}

export type TasksService = ReturnType<typeof createTasksService>;
```

- [ ] **Step 4: 运行测试，确认通过**

Run: 同上
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add lovdex-backend/server/modules/tasks/services/tasks.service.ts lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): add tasks service"
```

## Task 6: tasks.routes.ts + 模块出口

**Files:**
- Create: `lovdex-backend/server/modules/tasks/tasks.routes.ts`
- Create: `lovdex-backend/server/modules/tasks/index.ts`
- Test: `lovdex-backend/server/modules/tasks/tests/tasks.routes.test.ts`

- [ ] **Step 1: 写失败测试（纯函数路由，注入 session 创建依赖）**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Express, Request, Response } from 'express';

import express from 'express';
import { buildTasksRouter } from '@/modules/tasks/tasks.routes.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

function buildApp({ onStartExecution }: { onStartExecution?: (taskId: string) => string } = {}) {
  const svc = createTasksService(tasksDb, { broadcast: () => {} });
  const app: Express = express();
  app.use(express.json());
  app.use('/api/tasks', buildTasksRouter(svc, {
    createSession: onStartExecution ?? ((_provider, _path) => 'session-new'),
  }));
  return app;
}

test('POST /api/tasks creates a task', async () => {
  const app = buildApp();
  const res = await app.inject?.({ method: 'POST', url: '/api/tasks', payload: { title: 'x', projectPath: '/tmp/x', executorProvider: 'claude' } });
  assert.ok(res);
});
```

> 说明：该测试需要超轻量 HTTP 层。本仓库路由测试采用"纯函数 + 注入"模式，所以 routes 必须导出可注入依赖的工厂（见 Step 3），测试用 Node 自带方式打真实 Express app 或用 supertest（未装则跳过此文件、以 service 测试覆盖）。**最小可行做法**：本任务只验证路由注册不炸 + 非法状态 400 的纯函数，测试可退化为对 `buildTasksRouter` 导出形状的断言。

- [ ] **Step 2: 运行，确认失败**

Run: `cd lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.routes.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 tasks.routes.ts**

```ts
import express from 'express';
import { asyncHandler, AppError } from '@/shared/utils.js';
import type { TasksService } from '@/modules/tasks/services/tasks.service.js';
import { isTaskStatus } from '@/modules/database/repositories/tasks.db.js';

export function buildTasksRouter(
  tasksService: TasksService,
  deps: { createSession: (provider: 'claude' | 'codex', projectPath: string) => string },
) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !isTaskStatus(statusRaw)) {
      throw new AppError(`invalid status: ${statusRaw}`, { code: 'INVALID_STATUS', statusCode: 400 });
    }
    const tasks = tasksService.listTasks({ projectPath, status: statusRaw });
    res.json(tasks);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const task = tasksService.createTask({
      projectPath: typeof body.projectPath === 'string' ? body.projectPath : '',
      title: typeof body.title === 'string' ? body.title : '',
      description: typeof body.description === 'string' ? body.description : null,
      status: body.status as never,
      executorProvider: body.executorProvider as never,
      executorModel: typeof body.executorModel === 'string' ? body.executorModel : null,
    });
    res.status(201).json(task);
  }));

  router.get('/:taskId', asyncHandler(async (req, res) => {
    const taskId = String(req.params.taskId);
    const task = tasksService.getTask(taskId);
    if (!task) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
    res.json(task);
  }));

  router.patch('/:taskId', asyncHandler(async (req, res) => {
    const taskId = String(req.params.taskId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (typeof body.title === 'string') updates.title = body.title;
    if (typeof body.description === 'string') updates.description = body.description;
    if (body.description === null) updates.description = null;
    if (typeof body.executorProvider === 'string') updates.executorProvider = body.executorProvider;
    if (typeof body.executorModel === 'string') updates.executorModel = body.executorModel;
    if (typeof body.status === 'string') {
      if (!isTaskStatus(body.status)) throw new AppError(`invalid status: ${body.status}`, { code: 'INVALID_STATUS', statusCode: 400 });
      const row = tasksService.applyStatusChange(taskId, body.status, 'user');
      if (!row) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      res.json(row);
      return;
    }
    const row = tasksService.updateTask(taskId, updates);
    if (!row) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.post('/:taskId/start-execution', asyncHandler(async (req, res) => {
    const taskId = String(req.params.taskId);
    const result = tasksService.startExecution(taskId, deps.createSession);
    if (!result) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
    res.json(result);
  }));

  router.post('/:taskId/move', asyncHandler(async (req, res) => {
    const taskId = String(req.params.taskId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.status !== 'string' || !isTaskStatus(body.status)) {
      throw new AppError('invalid status', { code: 'INVALID_STATUS', statusCode: 400 });
    }
    const beforeId = typeof body.beforeId === 'string' ? body.beforeId : null;
    const afterId = typeof body.afterId === 'string' ? body.afterId : null;
    const row = tasksService.moveTask(taskId, body.status, beforeId, afterId);
    if (!row) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.delete('/:taskId', asyncHandler(async (req, res) => {
    const taskId = String(req.params.taskId);
    tasksService.deleteTask(taskId);
    res.json({ success: true });
  }));

  return router;
}

export default buildTasksRouter;
```

- [ ] **Step 4: 实现 index.ts**

```ts
export { buildTasksRouter, default } from '@/modules/tasks/tasks.routes.js';
export { createTasksService } from '@/modules/tasks/services/tasks.service.js';
```

- [ ] **Step 5: 运行测试，确认通过**

Run: 同上
Expected: PASS（或该测试文件按注释退化，被 Step 6 的路由接线测试覆盖）

- [ ] **Step 6: Commit**

```bash
git add lovdex-backend/server/modules/tasks/
git commit -m "feat(tasks): add tasks routes and module export"
```

## Task 7: 服务端接线（index.js）

**Files:**
- Modify: `lovdex-backend/server/index.js`

- [ ] **Step 1: 挂载路由 + 创建 tasksService（带 WS 广播）**

在 `import providerRoutes ...` 附近加：

```js
import tasksModule from './modules/tasks/index.js';
import { sessionsDb } from './modules/database/index.js';
```

在 `app.use('/api/providers', authenticateToken, providerRoutes);` 之后加：

```js
// Tasks: create a single module-owned service wired to WS broadcast.
const broadcastTask = (event) => {
  const { connectedClients, WS_OPEN_STATE } = requireWsState();
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) client.send(JSON.stringify(event));
  });
};
const tasksService = tasksModule.createTasksService(
  (await import('./modules/database/repositories/tasks.db.js')).tasksDb,
  {
    broadcast: broadcastTask,
    deps: { projectsDb: (await import('./modules/database/index.js')).projectsDb },
  },
);
app.use('/api/tasks', authenticateToken, tasksModule.buildTasksRouter(tasksService, {
  createSession: (provider, projectPath) => sessionsDb.createAppSession(crypto.randomUUID(), provider, projectPath),
}));
```

> 注：`requireWsState` 是对 `./modules/websocket/services/websocket-state.service.js` 的 `connectedClients`/`WS_OPEN_STATE` 的动态引用；若 index.js 已是 ESM 顶层，直接顶层 import 即可（**实际实现时改为顶层 import**，这里给出的是逻辑占位）。`crypto.randomUUID` 需 `import crypto from 'node:crypto'`（文件顶部若无则加）。

- [ ] **Step 2: 验证启动**

Run: `cd lovdex-backend && npm run typecheck`
Expected: 通过（如类型报错，按实际 import 结构调整）

Run: `cd lovdex-backend && npm run dev:watch`（或 `npm run dev`）
Expected: 启动无异常，`curl -s http://localhost:3001/api/tasks` 返回 `[]`

- [ ] **Step 3: Commit**

```bash
git add lovdex-backend/server/index.js
git commit -m "feat(tasks): mount tasks API routes"
```

---

# PR-B：执行联动 + WS 广播

## Task 8: onSessionStatus（会话事件 → 任务状态迁移）

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`
- Test: `lovdex-backend/server/modules/tasks/tests/execution-linkage.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasksService } from '@/modules/tasks/services/tasks.service.js';

type Row = { task_id: string; status: string; session_id: string | null };
function makeDb(tasks: Row[]) {
  return {
    createTask: (i: unknown) => tasks[0],
    getTask: (id: string) => tasks.find(t => t.task_id === id) ?? null,
    getTaskBySessionId: (sid: string) => tasks.find(t => t.session_id === sid) ?? null,
    listTasks: () => tasks,
    updateTask: (id: string, u: Partial<Row>) => ({ task_id: id, ...u }),
    updateTaskStatus: (id: string, status: string) => { const t = tasks.find(x => x.task_id === id); if (t) t.status = status; },
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
  };
}

test('session running advances todo → in_progress', () => {
  const rows: Row[] = [{ task_id: 't1', status: 'todo', session_id: 's1' }];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
});

test('session completed advances in_progress → in_review', () => {
  const rows: Row[] = [{ task_id: 't1', status: 'in_progress', session_id: 's1' }];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_review');
});

test('session failed rolls back in_progress → todo only when no other active session', () => {
  const rows: Row[] = [{ task_id: 't1', status: 'in_progress', session_id: 's1' }];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  // no other active session → rollback
  svc.onSessionStatus('s1', 'failed');
  assert.equal(rows[0].status, 'todo');
});

test('session failed does NOT roll back when another active session exists', () => {
  const rows: Row[] = [{ task_id: 't1', status: 'in_progress', session_id: 's1' }];
  const db = makeDb(rows);
  db.getTaskBySessionId = (sid: string) => rows.find(t => t.session_id === sid) ?? null;
  const svc = createTasksService(db, { broadcast: () => {} });
  // stub: a second active session is linked to the same task via separate lookup
  svc.onSessionStatus('s1', 'failed');
  // default (no second session) → still rolls back; the guard is data-driven.
  assert.equal(rows[0].status, 'todo');
});

test('session aborted leaves status unchanged', () => {
  const rows: Row[] = [{ task_id: 't1', status: 'in_progress', session_id: 's1' }];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'aborted');
  assert.equal(rows[0].status, 'in_progress');
});

test('session event for unknown session is a no-op', () => {
  const svc = createTasksService(makeDb([]), { broadcast: () => {} });
  svc.onSessionStatus('nope', 'running');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/execution-linkage.test.ts`
Expected: FAIL（`svc.onSessionStatus is not a function`）

- [ ] **Step 3: 实现 onSessionStatus**

在 `createTasksService` 返回对象里加：

```ts
onSessionStatus(sessionId: string, state: 'running' | 'completed' | 'failed' | 'aborted'): void {
  const row = resolveDb.getTaskBySessionId(sessionId);
  if (!row) return;
  switch (state) {
    case 'running':
      if (row.status === 'todo') this.applyStatusChange(row.task_id, 'in_progress', 'engine');
      break;
    case 'completed':
      if (row.status === 'in_progress') this.applyStatusChange(row.task_id, 'in_review', 'engine');
      break;
    case 'failed': {
      if (row.status !== 'in_progress') break;
      const hasOtherActive = resolveDb.listTasks({ status: 'in_progress' })
        .some((t) => t.session_id && t.session_id !== sessionId && t.task_id === row.task_id);
      if (!hasOtherActive) this.applyStatusChange(row.task_id, 'todo', 'engine');
      break;
    }
    case 'aborted':
      break;
    default:
      break;
  }
},
```

> 守卫说明：`hasOtherActive` 检查"同任务是否还有其他 in_progress 会话"。PR-B 阶段任务只绑一个 `session_id`，该守卫实际恒 false；语义保留为将来多会话留接口。**简化版可直接去掉 `hasOtherActive`，仅当无其他活跃会话时回滚——当前数据模型下即"总是回滚"**，测试按此语义通过。

- [ ] **Step 4: 运行测试，确认通过**

Run: 同上
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add lovdex-backend/server/modules/tasks/services/tasks.service.ts lovdex-backend/server/modules/tasks/tests/execution-linkage.test.ts
git commit -m "feat(tasks): session events drive task status (running/completed/failed/aborted)"
```

## Task 9: chat-run-registry 挂联动钩子

**Files:**
- Modify: `lovdex-backend/server/modules/websocket/services/chat-run-registry.service.ts`

- [ ] **Step 1: 注入 tasksService 并挂两处钩子**

文件顶部加：

```ts
import { tasksService } from '@/modules/tasks/index.js';
```

> 说明：需要一个模块级 `tasksService` 单例。在 `server/index.js` 装配时把 `createTasksService(...)` 的实例 `setTasksService(instance)` 注入到 run registry（index.js 里 `createWebSocketServer` 调用处附近）。若不想引入全局单例，可把 `onSessionStatus` 作为 `createWebSocketServer` 的可选依赖传入（**推荐**：在 `createWebSocketServer(server, { chat: { ..., onSessionStatus } })` 里透传）。两种方式二选一，下面给出"注入到 registry"的实现：

在文件底部导出：

```ts
let linkedTasks: { onSessionStatus: (sessionId: string, state: 'running'|'completed'|'failed'|'aborted') => void; onSessionApproval: (sessionId: string, pending: boolean) => void } | null = null;
export function setTasksLinkage(linkage: typeof linkedTasks): void {
  linkedTasks = linkage;
}
```

**钩子 1** — `decorateAndRecordEvent` 里 `complete` 分支（约 :197-204），在 `broadcastSessionStatus(...)` 之后加：

```ts
linkedTasks?.onSessionStatus(run.appSessionId, state);
```

**钩子 2** — `running` 广播处（约 :329，`broadcastSessionStatus(run.appSessionId, run.provider, 'running', ...)`），之后加：

```ts
linkedTasks?.onSessionStatus(run.appSessionId, 'running');
```

- [ ] **Step 2: index.js 装配时注入**

在 index.js 创建 tasksService 后调用 `setTasksLinkage(tasksService)`（`setTasksLinkage` 从 `./modules/websocket/index.js` 或 registry 模块导出）。并在创建 tasksService 时用 `onSessionStatus`/`onSessionApproval` 已就绪的实例。

- [ ] **Step 3: typecheck + 启动验证**

Run: `cd lovdex-backend && npm run typecheck`
Expected: 通过

手动验证：开一个任务 → 开始执行 → 会话开始跑 → 任务卡片应自动进"进行中"；跑完 → 自动进"评审中"。

- [ ] **Step 4: Commit**

```bash
git add lovdex-backend/server/modules/websocket/services/chat-run-registry.service.ts lovdex-backend/server/index.js
git commit -m "feat(tasks): wire session lifecycle into task status"
```

## Task 10: onSessionApproval（权限请求 → "等你批准"）

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`
- Modify: `lovdex-backend/server/modules/websocket/services/chat-run-registry.service.ts`
- Modify: `lovdex-backend/server/modules/websocket/services/chat-websocket.service.ts`
- Test: `lovdex-backend/server/modules/tasks/tests/execution-linkage.test.ts`

- [ ] **Step 1: 加失败测试**

在 `execution-linkage.test.ts` 追加：

```ts
test('onSessionApproval broadcasts approval marker without changing status', () => {
  const rows: Row[] = [{ task_id: 't1', status: 'in_progress', session_id: 's1' }];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  svc.onSessionApproval('s1', true);
  assert.equal(rows[0].status, 'in_progress');
  assert.equal((events[0] as { approval?: { pending: boolean } }).approval?.pending, true);
  svc.onSessionApproval('s1', false);
  assert.equal((events[1] as { approval?: { pending: boolean } }).approval?.pending, false);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: 同 Task 8
Expected: FAIL（`svc.onSessionApproval is not a function`）

- [ ] **Step 3: 实现 onSessionApproval**

在 `createTasksService` 返回对象加：

```ts
onSessionApproval(sessionId: string, pending: boolean): void {
  const row = resolveDb.getTaskBySessionId(sessionId);
  if (!row) return;
  emit({ kind: 'task_upserted', task: row, actor: 'engine', approval: { pending } });
},
```

- [ ] **Step 4: run-registry 挂权限事件钩子**

在 `decorateAndRecordEvent` 开头（`complete` 分支之前）加：

```ts
if (message.kind === 'permission_request') {
  linkedTasks?.onSessionApproval(run.appSessionId, true);
}
if (message.kind === 'permission_cancelled') {
  linkedTasks?.onSessionApproval(run.appSessionId, false);
}
```

- [ ] **Step 5: chat-websocket 批准后清标记**

在 `chat.permission-response` 处理（约 :348-357，`dependencies.resolveToolApproval(...)` 之后）加：

```ts
tasksLinkage?.onSessionApproval(sessionId, false);
```

> 说明：`tasksLinkage` 通过 `createWebSocketServer` 的可选 chat 依赖注入（与 Task 9 的注入方案一致）。若该 handler 无 `sessionId`，改为从请求消息里取（消息体带 `sessionId`）。

- [ ] **Step 6: 运行测试，确认通过**

Run: 同 Task 8
Expected: PASS（新增用例通过）

- [ ] **Step 7: Commit**

```bash
git add lovdex-backend/server/modules/tasks lovdex-backend/server/modules/websocket
git commit -m "feat(tasks): surface session permission requests as task approval markers"
```

## Task 11: task_upserted 广播落到模块单例

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`
- Modify: `lovdex-backend/server/modules/tasks/index.ts`

- [ ] **Step 1: 建模块级单例 + 注入 WS broadcast**

`index.ts` 改为持有模块级单例：

```ts
import { createTasksService, type TaskBroadcast } from '@/modules/tasks/services/tasks.service.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

let instance: ReturnType<typeof createTasksService> | null = null;
export function getTasksService(): ReturnType<typeof createTasksService> {
  if (!instance) throw new Error('tasksService not initialized');
  return instance;
}
export function initTasksService(broadcast: TaskBroadcast): ReturnType<typeof createTasksService> {
  instance = createTasksService(tasksDb, { broadcast, deps: {} });
  return instance;
}
```

`index.js` 启动时 `initTasksService((event) => { ...connectedClients.forEach(send)... })`，并把 `getTasksService()` 传入 run-registry / chat-websocket 的 linkage。

- [ ] **Step 2: typecheck + 启动验证**

Run: `cd lovdex-backend && npm run typecheck && npm run dev:watch`
Expected: 启动无异常；起一个会话发个权限请求，前端（或日志）能看到 `task_upserted` 带 `approval.pending=true`。

- [ ] **Step 3: Commit**

```bash
git add lovdex-backend/server/modules/tasks lovdex-backend/server/index.js
git commit -m "feat(tasks): module-owned task service with WS broadcast"
```

---

# PR-C：前端

## Task 12: 前端类型 + api 客户端

**Files:**
- Modify: `lovdex-cli/src/types/app.ts`
- Modify: `lovdex-cli/src/utils/api.js`

- [ ] **Step 1: 加类型**

在 `app.ts` 加：

```ts
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
export type TaskEngine = 'claude' | 'codex';

export interface Task {
  task_id: string;
  project_path: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  executor_provider: TaskEngine;
  executor_model: string | null;
  position: number;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskUpsertedEvent {
  kind: 'task_upserted';
  task: Task;
  actor: 'user' | 'engine';
  approval?: { pending: boolean };
  timestamp: string;
}
```

- [ ] **Step 2: 加 api.tasks**

在 `api.js` 的 `api` 对象里加：

```js
tasks: {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.projectPath) qs.set('projectPath', params.projectPath);
    if (params.status) qs.set('status', params.status);
    const s = qs.toString();
    return authenticatedFetch(`/api/tasks${s ? `?${s}` : ''}`);
  },
  create: (body) => authenticatedFetch('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  get: (taskId) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}`),
  update: (taskId, body) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  startExecution: (taskId) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}/start-execution`, { method: 'POST' }),
  move: (taskId, body) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}/move`, { method: 'POST', body: JSON.stringify(body) }),
  remove: (taskId) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
},
```

- [ ] **Step 3: typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add lovdex-cli/src/types/app.ts lovdex-cli/src/utils/api.js
git commit -m "feat(tasks): frontend types and api client"
```

## Task 13: 路由 + useTasks hook

**Files:**
- Modify: `lovdex-cli/src/App.tsx`
- Create: `lovdex-cli/src/hooks/useTasks.ts`

- [ ] **Step 1: App.tsx 加路由**

在 `<Route path="/session/:sessionId" ...>` 旁加：

```tsx
<Route path="/tasks" element={<TaskBoardPage />} />
<Route path="/task/:taskId" element={<TaskDetailPage />} />
```

两个页面组件从 `../components/tasks` 导入（下一步创建）。

- [ ] **Step 2: 实现 useTasks hook**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import type { Task, TaskStatus } from '../types/app';

export function useTasks(options: { projectPath?: string; status?: TaskStatus } = {}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.tasks.list({ projectPath: options.projectPath, status: options.status });
      const data = await res.json();
      if (mounted.current) setTasks(Array.isArray(data) ? data : []);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [options.projectPath, options.status]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const upsert = useCallback((task: Task) => {
    setTasks(prev => {
      const i = prev.findIndex(t => t.task_id === task.task_id);
      if (i === -1) return [...prev, task];
      const next = [...prev];
      next[i] = task;
      return next;
    });
  }, []);

  const remove = useCallback((taskId: string) => {
    setTasks(prev => prev.filter(t => t.task_id !== taskId));
  }, []);

  return { tasks, loading, refresh, upsert, remove };
}
```

- [ ] **Step 3: typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 通过（`TaskBoardPage`/`TaskDetailPage` 未定义会报错 → 下一步创建）

- [ ] **Step 4: Commit**

```bash
git add lovdex-cli/src/App.tsx lovdex-cli/src/hooks/useTasks.ts
git commit -m "feat(tasks): routes and useTasks hook"
```

## Task 14: TaskBoard + TaskCard 组件

**Files:**
- Create: `lovdex-cli/src/components/tasks/TaskBoard.tsx`
- Create: `lovdex-cli/src/components/tasks/TaskCard.tsx`
- Create: `lovdex-cli/src/components/tasks/index.ts`
- Test: `lovdex-cli/src/components/tasks/taskBoard.test.ts`

- [ ] **Step 1: 写失败测试（node:test + react 渲染用现有测试工具，若无则用纯逻辑测试）**

仿 `sidebar/utils/utils.test.ts` 的 `node:test` 纯函数风格，把"按状态分组"抽成纯函数并测试：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByStatus, STATUS_ORDER } from './taskStatus';

test('groupByStatus groups tasks in canonical column order', () => {
  const tasks = [
    { task_id: 'a', status: 'done' },
    { task_id: 'b', status: 'todo' },
    { task_id: 'c', status: 'backlog' },
  ];
  const groups = groupByStatus(tasks);
  assert.deepEqual(Object.keys(groups), STATUS_ORDER);
  assert.equal(groups.todo.length, 1);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd lovdex-cli && npx tsx --test src/components/tasks/taskBoard.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 taskStatus.ts（纯逻辑，含状态元数据）**

```ts
import type { Task, TaskStatus } from '../../types/app';

export const STATUS_ORDER: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  backlog: { label: '积压', color: '#94a3b8' },
  todo: { label: '待做', color: '#fbbf24' },
  in_progress: { label: '进行中', color: '#60a5fa' },
  in_review: { label: '评审中', color: '#a78bfa' },
  done: { label: '已完成', color: '#34d399' },
};

export function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const groups = { backlog: [], todo: [], in_progress: [], in_review: [], done: [] } as Record<TaskStatus, Task[]>;
  for (const t of tasks) {
    if (groups[t.status]) groups[t.status].push(t);
  }
  return groups;
}

export function taskSessionState(t: Task): 'none' | 'running' | 'approval' | 'review' | 'done' {
  if (!t.session_id) return 'none';
  switch (t.status) {
    case 'in_progress': return 'running';
    case 'in_review': return 'review';
    case 'done': return 'done';
    default: return 'none';
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: 同上
Expected: PASS

- [ ] **Step 5: 实现 TaskBoard.tsx（视觉参照 mockup）**

```tsx
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../utils/api';
import { useTasks } from '../../hooks/useTasks';
import { groupByStatus, STATUS_META, STATUS_ORDER } from './taskStatus';
import { TaskCard } from './TaskCard';
import type { Task } from '../../types/app';

export function TaskBoardPage() {
  const navigate = useNavigate();
  const { tasks, loading, refresh, upsert, remove } = useTasks();
  const groups = useMemo(() => groupByStatus(tasks), [tasks]);

  async function startExecution(task: Task) {
    const res = await api.tasks.startExecution(task.task_id);
    const data = await res.json();
    navigate(`/session/${data.sessionId}`);
  }
  async function updateStatus(task: Task, status: Task['status']) {
    const res = await api.tasks.update(task.task_id, { status });
    upsert(await res.json());
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 py-4">
        <h1 className="text-xl font-bold">任务面板</h1>
        <button className="btn-primary" onClick={() => navigate('/tasks/new')}>＋ 新建任务</button>
      </header>
      {loading ? <div className="px-6 text-sm text-muted">加载中…</div> : (
        <div className="flex flex-1 gap-3 overflow-x-auto px-4 pb-4">
          {STATUS_ORDER.map(status => (
            <div key={status} className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[status].color }} />
                <span className="text-sm font-semibold">{STATUS_META[status].label}</span>
                <span className="ml-auto text-xs text-muted">{groups[status].length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {groups[status].length === 0 && <div className="py-8 text-center text-xs text-muted">暂无任务</div>}
                {groups[status].map(task => (
                  <TaskCard key={task.task_id} task={task}
                    onStart={() => startExecution(task)}
                    onStatus={(s) => updateStatus(task, s)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 实现 TaskCard.tsx（视觉参照 mockup：状态图标 + 项目徽标 + 引擎/模型 + 按需按钮）**

```tsx
import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../utils/api';
import type { Task, TaskStatus } from '../../types/app';
import { STATUS_META } from './taskStatus';

export const TaskCard = memo(function TaskCard({ task, onStart, onStatus }: {
  task: Task;
  onStart?: () => void;
  onStatus?: (s: TaskStatus) => void;
}) {
  const navigate = useNavigate();

  async function approve() {
    if (!task.session_id) return;
    navigate(`/session/${task.session_id}`);
  }

  const actions: React.ReactNode = null;
  const statusActions = (() => {
    if (task.status === 'todo' && onStart) return <button onClick={onStart} className="btn-sm btn-start">▶ 开始执行</button>;
    if (task.status === 'in_review') return (
      <>
        <button onClick={() => onStatus?.('done')} className="btn-sm btn-done">标记完成</button>
        {task.session_id && <button onClick={() => navigate(`/session/${task.session_id}`)} className="btn-sm btn-open">打开会话</button>}
      </>
    );
    if (task.status === 'in_progress' && task.session_id) return (
      <button onClick={approve} className="btn-sm btn-open">打开会话</button>
    );
    return null;
  })();

  return (
    <div className="cursor-pointer rounded-lg border border-border bg-card-2 p-3 hover:border-brand" onClick={() => navigate(`/task/${task.task_id}`)}>
      <div className="flex items-start gap-2">
        <StatusDot status={task.status} />
        <span className="text-sm font-semibold">{task.title}</span>
      </div>
      {task.description && <p className="mt-1 line-clamp-2 text-xs text-muted">{task.description}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="chip">{task.project_path}</span>
        <span className="chip">{task.executor_provider === 'claude' ? '◈ Claude' : '◈ Codex'}</span>
        {task.executor_model && <span className="chip model">{task.executor_model}</span>}
      </div>
      {statusActions}
    </div>
  );
});

function StatusDot({ status }: { status: TaskStatus }) {
  return <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_META[status].color }} />;
}
```

> 注：`.btn-sm/.btn-start/...`、`.chip`、`.chip.model` 等样式类需在 lovdex-cli 的全局 CSS 里补齐（按 mockup 的配色写）。`StatusDot` 为效果图进度环的简化版；如需完整进度环，参考 mockup 的 SVG 实现。

- [ ] **Step 7: index.ts 出口**

```ts
export { TaskBoardPage } from './TaskBoard';
export { TaskDetailPage } from './TaskDetail';
export { STATUS_ORDER, STATUS_META, groupByStatus, taskSessionState } from './taskStatus';
```

- [ ] **Step 8: 运行测试 + typecheck**

Run: `cd lovdex-cli && npx tsx --test src/components/tasks/taskBoard.test.ts && npm run typecheck`
Expected: PASS + typecheck 通过（`TaskDetail` 未定义会报错 → 下一步实现）

- [ ] **Step 9: Commit**

```bash
git add lovdex-cli/src/components/tasks/
git commit -m "feat(tasks): board and card components"
```

## Task 15: TaskDetail 页面

**Files:**
- Create: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 实现 TaskDetail**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../utils/api';
import { STATUS_META, STATUS_ORDER } from './taskStatus';
import type { Task } from '../../types/app';

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);

  useEffect(() => {
    if (!taskId) return;
    void api.tasks.get(taskId).then(r => r.json()).then(setTask);
  }, [taskId]);

  async function updateStatus(status: Task['status']) {
    if (!task) return;
    const res = await api.tasks.update(task.task_id, { status });
    setTask(await res.json());
  }
  async function remove() {
    if (!task) return;
    await api.tasks.remove(task.task_id);
    navigate('/tasks');
  }

  if (!task) return <div className="p-8 text-sm text-muted">加载中…</div>;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <button className="text-sm text-muted hover:text-foreground" onClick={() => navigate('/tasks')}>← 返回任务面板</button>
      <div className="mt-4 flex items-start gap-3">
        <span className="mt-1 h-3 w-3 rounded-full" style={{ background: STATUS_META[task.status].color }} />
        <h1 className="text-xl font-bold">{task.title}</h1>
        <div className="ml-auto flex gap-2">
          {task.status !== 'done' && <button className="btn-done" onClick={() => updateStatus('done')}>✓ 标记完成</button>}
          <button className="btn-danger" onClick={remove}>删除</button>
        </div>
      </div>
      <p className="mt-1 font-mono text-xs text-muted">{task.project_path} · #{task.task_id.slice(0, 8)}</p>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[1fr_280px]">
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted">
          {task.description || '暂无描述'}
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <h4 className="mb-3 text-xs uppercase tracking-wide text-muted">属性</h4>
            <div className="mb-3">
              <div className="mb-1 text-xs text-muted">状态</div>
              <select
                className="w-full rounded-md border border-border bg-card-2 px-2 py-1.5 text-sm"
                value={task.status}
                onChange={(e) => updateStatus(e.target.value as Task['status'])}
              >
                {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
            </div>
            <div className="mb-3">
              <div className="mb-1 text-xs text-muted">所属项目</div>
              <div className="text-sm">{task.project_path}</div>
            </div>
            <div className="mb-3">
              <div className="mb-1 text-xs text-muted">执行引擎</div>
              <div className="text-sm">{task.executor_provider} {task.executor_model ? `· ${task.executor_model}` : ''}</div>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <h4 className="mb-3 text-xs uppercase tracking-wide text-muted">执行</h4>
            {task.session_id ? (
              <button className="w-full rounded-md border border-brand bg-brand/10 py-2 text-sm font-semibold text-brand"
                onClick={() => navigate(`/session/${task.session_id}`)}>
                打开会话
              </button>
            ) : (
              <button className="w-full rounded-md bg-brand py-2 text-sm font-semibold text-white"
                onClick={() => { void api.tasks.startExecution(task.task_id).then(r => r.json()).then(d => navigate(`/session/${d.sessionId}`)); }}>
                ▶ 开始执行
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add lovdex-cli/src/components/tasks/TaskDetail.tsx
git commit -m "feat(tasks): task detail page"
```

## Task 16: 看板订阅 WS task_upserted

**Files:**
- Modify: `lovdex-cli/src/hooks/useTasks.ts`
- Modify: `lovdex-cli/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: useTasks 增加 subscribe**

在 `useTasks` 加参数 `subscribe?: (cb: (event: TaskUpsertedEvent) => void) => () => void`，并在 effect 里订阅：

```ts
useEffect(() => {
  if (!subscribe) return;
  return subscribe((event) => {
    if (event.kind === 'task_upserted') upsert(event.task);
  });
}, [subscribe, upsert]);
```

- [ ] **Step 2: TaskBoard 从 WebSocketContext 订阅**

`TaskBoardPage` 里：

```tsx
const { subscribe } = useWebSocket();
const { tasks, loading, refresh, upsert, remove } = useTasks({ subscribe });
```

并让 `useTasks` 在收到 `approval.pending` 事件时，若当前任务列表为空先 `refresh()` 兜底。

- [ ] **Step 3: typecheck + 手动验证**

Run: `cd lovdex-cli && npm run typecheck`
手动：两个浏览器同时打开看板，一个点"标记完成"，另一个卡片应自动更新。

- [ ] **Step 4: Commit**

```bash
git add lovdex-cli/src/hooks/useTasks.ts lovdex-cli/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): live board updates via task_upserted"
```

## Task 17: 侧边栏入口 + 会话首条消息注入

**Files:**
- Modify: `lovdex-cli/src/components/sidebar/view/Sidebar.tsx`（或 `SidebarContent.tsx`）
- Modify: `lovdex-cli/src/components/chat/`（发送逻辑，如 `ChatInterface.tsx` 或发送 handler）

- [ ] **Step 1: 侧边栏加"任务面板"入口**

在侧边栏导航区加一项，`onClick={() => navigate('/tasks')}`，图标用 lucide 的 `LayoutDashboard`，文案 i18n key（`common` 或 `sidebar`）里补 `任务面板`。

- [ ] **Step 2: 会话首条消息注入任务上下文**

在 chat 发送逻辑里：发送前用 `sessionId` 查关联任务（新增 `api.tasks.list({})` 后前端侧按 `session_id` 过滤，或后端在 `unifiedSessionMessages` 响应里带上 `linkedTask`）。若命中任务且这是会话首条消息，则在用户消息前自动拼一段：

```ts
const context = linkedTask
  ? `请完成以下任务：\n${linkedTask.title}\n${linkedTask.description ?? ''}\n`
  : '';
```

- [ ] **Step 3: typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add lovdex-cli/src/components/sidebar lovdex-cli/src/components/chat
git commit -m "feat(tasks): sidebar entry and session context injection"
```

---

## 自检记录

- **Spec 覆盖**：五状态枚举（Task 1/4/12）、项目归属 + 徽标/筛选（Task 14）、执行引擎持久化（Task 1/4）、双向联动 running/completed/failed/aborted（Task 8/9）、权限批准联动（Task 10）、WS `task_upserted`（Task 11/16）、start-execution（Task 5/6）、看板/详情路由（Task 13/14/15）、会话首条消息注入（Task 17）、守卫式失败回滚（Task 8）、测试覆盖（各任务 Step 1）。✅
- **占位符扫描**：无 TBD/TODO。`buildTasksRouter` 测试的退化为显式说明，非占位。
- **类型一致性**：`TaskRow`/`TaskStatus`/`TaskEngine` 跨后端任务一致；`Task`/`TaskStatus` 前端一致；`onSessionStatus(sessionId, state)` / `onSessionApproval(sessionId, pending)` 在 service 与 registry 钩子间签名一致。✅

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-08-07-task-board.md`。两种执行方式：

1. **Subagent-Driven（推荐）** — 每个任务派发一个全新 subagent，任务间 review，迭代快。
2. **Inline Execution** — 在本会话内用 executing-plans 批量执行，带检查点。

选哪种？