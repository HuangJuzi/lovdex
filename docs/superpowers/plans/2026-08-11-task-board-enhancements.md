# 任务板增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务板新建表单排除主Agent工作目录并支持「Lovdex 助手」选项、防呆、优先级(P0~P3)+Deadline、收藏项目优先、Label(六档)+备注。

**Architecture:** 后端在 `tasks` 表加 `priority`/`deadline`/`is_operator`/`label`/`remark` 五列并贯穿 create/update/startExecution；`/api/projects` 给主Agent工作目录打 `isMainAgentWorkspace` 标记。前端新建表单/卡片/详情页展示并编辑新字段；项目下拉用纯函数 `projectOptions.ts` 统一过滤(主Agent工作目录)+排序(收藏优先)+助手选项。

**Tech Stack:** backend = Express + better-sqlite3 + tsx(测试 `npx tsx --test`)。frontend = React + Vite + node:test(测试 `npx tsx --test`，需先 `unset TSX_TSCONFIG_PATH`)。两个 git 仓库：`lovdex-backend`、`lovdex-cli`。

**测试环境要点：**
- 后端测试：`npx tsx --test <file>`（`TSX_TSCONFIG_PATH` 全局已指向 `server/tsconfig.json`，**不要** unset，`@/` 别名靠它）。
- 前端测试：**先** `unset TSX_TSCONFIG_PATH` 再 `npx tsx --test <file>`，否则 tsx 用错后端 tsconfig 报错。
- git 操作用 `git -C <repo> ...` 形式（sandbox 里 `cd` 会 Stream closed）。

---

## 文件结构

**后端 `lovdex-backend/server/`：**
- `shared/task-status.ts` — 加 `TASK_PRIORITIES`/`TaskPriority`/`isTaskPriority`/`isTaskDeadline` + `TASK_LABELS`/`TaskLabel`/`isTaskLabel`
- `shared/types.ts` — `TaskRow` 加 `priority`/`deadline`/`is_operator`/`label`/`remark`
- `modules/database/schema.ts` — `TASKS_TABLE_SCHEMA_SQL` 加五列
- `modules/database/migrations.ts` — `migrateTasksTable` 加五列（`addColumnToTableIfNotExists`）
- `modules/database/repositories/tasks.db.ts` — `createTask`/`updateTask` 支持新字段
- `modules/tasks/services/tasks.service.ts` — create/update 校验 + operator workspace 解析 + `startExecution` 传 isOperator
- `modules/tasks/tasks.routes.ts` — POST/PATCH 解析校验新字段；`SessionCreator` 加第三参
- `index.js` — `createSession` wiring 透传 isOperator
- `utils/runtime-paths.js` — 加 `getAppRoot()`
- `modules/projects/services/projects-with-sessions-fetch.service.ts` — `isMainAgentWorkspace` 标记

**前端 `lovdex-cli/src/`：**
- `types/app.ts` — `TaskPriority`/`TaskLabel`、`Task` 加字段、`Project` 加 `isMainAgentWorkspace`
- `components/tasks/taskStatus.ts` — `PRIORITY_ORDER`/`PRIORITY_META`/`LABEL_ORDER`/`LABEL_META`
- `components/tasks/taskDeadline.ts`（新建）— `deadlineInfo()`
- `components/tasks/projectOptions.ts`（新建）— `ASSISTANT_OPTION_VALUE`/`projectPathOf`/`taskFormProjects()`
- `components/tasks/TaskBoard.tsx` — 防呆 + 下拉 + priority/deadline/label/remark
- `components/tasks/TaskCard.tsx` — label/priority/deadline/助手徽章
- `components/tasks/TaskDetail.tsx` — 属性编辑 + 下拉 + 徽章
- 测试工厂修复：`taskStatus.test.ts`/`taskTimestamp.test.ts`/`useLinkedTask.test.ts` 的 `mkTask`

---

### Task 1: 后端优先级/Deadline/Label 常量与校验器

**Files:**
- Modify: `lovdex-backend/server/shared/task-status.ts`
- Test: `lovdex-backend/server/shared/tests/task-status-model.test.ts`

- [ ] **Step 1: 写失败测试**

在 `task-status-model.test.ts` 末尾追加：

```ts
import { TASK_PRIORITIES, isTaskPriority, isTaskDeadline, TASK_LABELS, isTaskLabel } from '@/shared/task-status.js';
// (import 合并到文件顶部现有 import 中)

test('TASK_PRIORITIES is P0..P3', () => {
  assert.deepEqual(TASK_PRIORITIES, ['P0', 'P1', 'P2', 'P3']);
  assert.equal(isTaskPriority('P0'), true);
  assert.equal(isTaskPriority('P4'), false);
  assert.equal(isTaskPriority(undefined), false);
});

test('isTaskDeadline validates YYYY-MM-DD real dates', () => {
  assert.equal(isTaskDeadline('2026-12-31'), true);
  assert.equal(isTaskDeadline('2026-02-30'), false);   // 非法日期
  assert.equal(isTaskDeadline('2026/12/31'), false);   // 分隔符错
  assert.equal(isTaskDeadline(null), false);
});

test('TASK_LABELS is the six categories', () => {
  assert.deepEqual(TASK_LABELS, ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other']);
  assert.equal(isTaskLabel('bug'), true);
  assert.equal(isTaskLabel('nope'), false);
  assert.equal(isTaskLabel(undefined), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/shared/tests/task-status-model.test.ts`
Expected: 编译/导入失败（`TASK_PRIORITIES` 不存在）。

- [ ] **Step 3: 实现**

在 `server/shared/task-status.ts` 末尾追加：

```ts
export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD that also resolves to the same calendar date (rejects 2026-02-30). */
export function isTaskDeadline(value: unknown): value is string {
  if (typeof value !== 'string' || !DEADLINE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const TASK_LABELS = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other'] as const;
export type TaskLabel = (typeof TASK_LABELS)[number];

export function isTaskLabel(value: unknown): value is TaskLabel {
  return typeof value === 'string' && (TASK_LABELS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx --test server/shared/tests/task-status-model.test.ts`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/shared/task-status.ts server/shared/tests/task-status-model.test.ts
git commit -m "feat(tasks): add priority/deadline/label constants + validators"
```

---

### Task 2: tasks 表 schema + migration 加列

**Files:**
- Modify: `lovdex-backend/server/modules/database/schema.ts`
- Modify: `lovdex-backend/server/modules/database/migrations.ts`
- Test: `lovdex-backend/server/modules/database/tests/tasks-status-migration.test.ts`

- [ ] **Step 1: 写失败测试**

`tasks-status-migration.test.ts` 里已有 migration 重建测试。追加一个断言：迁移后 `PRAGMA table_info(tasks)` 含 `priority`/`deadline`/`is_operator`/`label`/`remark`。先看该文件现有结构，复用其建库/跑迁移的 helper，追加：

```ts
test('migrateTasksTable adds priority/deadline/is_operator/label/remark', () => {
  // 用 helper 建一个不含新列的 tasks 表（legacy 形状），跑 runMigrations
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c: any) => c.name);
  for (const col of ['priority', 'deadline', 'is_operator', 'label', 'remark']) {
    assert.ok(cols.includes(col), `missing column ${col}`);
  }
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string };
  assert.match(row.sql, /CHECK \(priority IN \('P0','P1','P2','P3'\)\)/);
  assert.match(row.sql, /CHECK \(label IN \('bug','feature','optimization','refactor','docs','other'\)\)/);
});
```

> 若现有 helper 不便复用，直接在测试内用 better-sqlite3 建 `tasks_legacy` 形状表 → 调 `migrateTasksTable(db)`（该函数已 export）→ 断言。

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/modules/database/tests/tasks-status-migration.test.ts`
Expected: 新测试失败（列不存在）。

- [ ] **Step 3: 实现 schema**

`schema.ts`：顶部从 `@/shared/task-status.js` 补 import `TASK_PRIORITIES`、`TASK_LABELS`；在 `STATUS_CHECK` 旁加：

```ts
const PRIORITY_CHECK = `CHECK (priority IN (${TASK_PRIORITIES.map((p) => `'${p}'`).join(',')}))`;
const LABEL_CHECK = `CHECK (label IN (${TASK_LABELS.map((l) => `'${l}'`).join(',')}))`;
```

`TASKS_TABLE_SCHEMA_SQL` 里 `verdict_at DATETIME` 后加：

```sql
    priority          TEXT NOT NULL DEFAULT 'P2'
                      ${PRIORITY_CHECK},
    deadline          TEXT,
    is_operator       INTEGER DEFAULT 0,
    label             TEXT NOT NULL DEFAULT 'other'
                      ${LABEL_CHECK},
    remark            TEXT
```

- [ ] **Step 4: 实现 migration**

`migrations.ts` 的 `migrateTasksTable` 里，`addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'verdict_at', 'DATETIME');` 之后加：

```ts
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'priority', "TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3'))");
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'deadline', 'TEXT');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'is_operator', 'INTEGER DEFAULT 0');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'label', "TEXT NOT NULL DEFAULT 'other' CHECK (label IN ('bug','feature','optimization','refactor','docs','other'))");
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'remark', 'TEXT');
```

（sub_status 重建路径走 `TASKS_TABLE_SCHEMA_SQL` 新建表，新列自动带上；INSERT...SELECT 只列旧列，新列落默认值。）

- [ ] **Step 5: 运行确认通过**

Run: `npx tsx --test server/modules/database/tests/tasks-status-migration.test.ts`
Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git -C lovdex-backend add server/modules/database/schema.ts server/modules/database/migrations.ts server/modules/database/tests/tasks-status-migration.test.ts
git -C lovdex-backend commit -m "feat(tasks): add priority/deadline/is_operator/label/remark columns"
```

---

### Task 3: TaskRow 类型 + tasks.db create/update 支持新字段

**Files:**
- Modify: `lovdex-backend/server/shared/types.ts`
- Modify: `lovdex-backend/server/modules/database/repositories/tasks.db.ts`
- Test: `lovdex-backend/server/modules/database/tests/tasks.db.integration.test.ts`

- [ ] **Step 1: 写失败测试**

`tasks.db.integration.test.ts` 追加：

```ts
test('createTask persists new fields with defaults', () => {
  const base = { projectPath: '/p', title: 't', executorProvider: 'claude' as const };
  const row = tasksDb.createTask({ ...base });
  assert.equal(row.priority, 'P2');
  assert.equal(row.deadline, null);
  assert.equal(row.is_operator, 0);
  assert.equal(row.label, 'other');
  assert.equal(row.remark, null);

  const op = tasksDb.createTask({ ...base, title: 'op', priority: 'P0', deadline: '2026-12-31', isOperator: true, label: 'bug', remark: '来自需求单 #123' });
  assert.equal(op.priority, 'P0');
  assert.equal(op.deadline, '2026-12-31');
  assert.equal(op.is_operator, 1);
  assert.equal(op.label, 'bug');
  assert.equal(op.remark, '来自需求单 #123');
});

test('updateTask can set priority/deadline/label/remark', () => {
  const row = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' as const });
  const updated = tasksDb.updateTask(row.task_id, { priority: 'P1', deadline: '2026-11-30', label: 'feature', remark: '备注' });
  assert.equal(updated?.priority, 'P1');
  assert.equal(updated?.deadline, '2026-11-30');
  assert.equal(updated?.label, 'feature');
  assert.equal(updated?.remark, '备注');
  const cleared = tasksDb.updateTask(row.task_id, { deadline: null, remark: null });
  assert.equal(cleared?.deadline, null);
  assert.equal(cleared?.remark, null);
});
```

> 若该测试文件用内存 DB 建表，先跑 `runMigrations` 或 `TASKS_TABLE_SCHEMA_SQL` 确保新列存在；照现有文件顶部 setup 复用。

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts`
Expected: 类型/字段缺失或列不存在。

- [ ] **Step 3: 实现 TaskRow 类型**

`server/shared/types.ts`：顶部 import 加 `TaskPriority`、`TaskLabel`（`import type { SubStatus, TaskLabel, TaskPriority, TaskStatus } from '@/shared/task-status.js';`），`TaskRow` 里 `verdict_at: string | null;` 后加：

```ts
  priority: TaskPriority;
  deadline: string | null;
  is_operator: number; // 0 | 1 — 1 = Lovdex 助手任务
  label: TaskLabel;
  remark: string | null;
```

- [ ] **Step 4: 实现 tasks.db**

`tasks.db.ts` `createTask` 输入类型加：

```ts
    priority?: TaskPriority;
    deadline?: string | null;
    isOperator?: boolean;
    label?: TaskLabel;
    remark?: string | null;
```

`createTask` 的 INSERT 改为（列 + 占位 + 参数）：

```ts
    const row = db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, priority, deadline, is_operator, label, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${startedAtSet}, ${completedAtSet}, ?, ?, ?, ?, ?)
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
      input.priority ?? 'P2',
      input.deadline ?? null,
      input.isOperator ? 1 : 0,
      input.label ?? 'other',
      input.remark ?? null,
    ) as TaskRow;
```

`updateTask` 输入类型加 `priority?: TaskPriority; deadline?: string | null; label?: TaskLabel; remark?: string | null;`，SET 拼装加：

```ts
    if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority); }
    if (updates.deadline !== undefined) { sets.push('deadline = ?'); params.push(updates.deadline); }
    if (updates.label !== undefined) { sets.push('label = ?'); params.push(updates.label); }
    if (updates.remark !== undefined) { sets.push('remark = ?'); params.push(updates.remark); }
```

`tasks.db.ts` 顶部 import 补 `TaskPriority, TaskLabel`（从 `@/shared/task-status.js`）。

- [ ] **Step 5: 运行确认通过**

Run: `npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts`
Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git -C lovdex-backend add server/shared/types.ts server/modules/database/repositories/tasks.db.ts server/modules/database/tests/tasks.db.integration.test.ts
git -C lovdex-backend commit -m "feat(tasks): persist priority/deadline/is_operator/label/remark in db layer"
```

---

### Task 4: tasks.service create/update/startExecution + operator workspace

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`
- Test: `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: 写失败测试**

`tasks.service.test.ts` 追加（先读该文件现有 stub 结构，`createTasksService` 的 `deps.projectsDb`/`deps.sessionsDb` 用内存 stub）：

```ts
test('createTask rejects invalid priority / deadline / label', () => {
  const svc = createTasksService(mockDb, { broadcast: () => {} });
  assert.throws(() => svc.createTask({ projectPath: '/p', title: 't', priority: 'P9' as any }), /INVALID_PRIORITY/);
  assert.throws(() => svc.createTask({ projectPath: '/p', title: 't', deadline: '2026/13/99' }), /INVALID_DEADLINE/);
  assert.throws(() => svc.createTask({ projectPath: '/p', title: 't', label: 'nope' as any }), /INVALID_LABEL/);
});

test('createTask operator task uses claude + workspace project', () => {
  const created: any[] = [];
  const stubDb = { ...mockDb, createTask: (input: any) => { created.push(input); return { task_id: 't1', priority: input.priority ?? 'P2', deadline: input.deadline ?? null, is_operator: input.isOperator ? 1 : 0, status: 'todo', project_path: input.projectPath }; } };
  const projectRows = new Map<string, object>();
  const stubProjects = {
    getProjectPath: (p: string) => projectRows.get(p) ?? null,
    createProjectPath: (p: string) => { projectRows.set(p, { project_path: p }); return { outcome: 'created', project: { project_path: p } }; },
  };
  const svc = createTasksService(stubDb as any, { broadcast: () => {}, deps: { projectsDb: stubProjects as any } });
  const row = svc.createTask({ projectPath: '__assistant__', title: 't', isOperator: true });
  assert.equal(row.is_operator, 1);
  assert.equal(created[0].projectPath, '/home/zhijuhuang/.lovdex/operator-workspace'); // 或 getOperatorConfig().workspace 解析值
  assert.equal(created[0].executorProvider, 'claude');
});

test('startExecution passes isOperator to createSession', () => {
  const captured: any[] = [];
  const stubDb = { ...mockDb, getTask: () => ({ task_id: 't1', is_operator: 1, executor_provider: 'claude', project_path: '/w' }) };
  const svc = createTasksService(stubDb as any, { broadcast: () => {} });
  svc.startExecution('t1', (_p, _pp, isOp) => { captured.push(isOp); return 's1'; });
  assert.equal(captured[0], true);
});
```

> `getOperatorConfig().workspace` 默认 `${os.homedir()}/.lovdex/operator-workspace`，断言用展开值（`import { getOperatorConfig } from '@/modules/operators/operator.config.js'` 或直接算）。

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: 新测试失败（字段未实现）。

- [ ] **Step 3: 实现 service**

顶部 import 补：

```ts
import os from 'node:os';
import path from 'node:path';
import { getOperatorConfig } from '@/modules/operators/operator.config.js';
import { isTaskDeadline, isTaskLabel, isTaskPriority, type TaskLabel, type TaskPriority } from '@/shared/task-status.js';
```

文件级加 helper：

```ts
function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}
```

`CreateTaskInput` 加：

```ts
  priority?: TaskPriority;
  deadline?: string | null;
  isOperator?: boolean;
  label?: TaskLabel;
  remark?: string | null;
```

`createTask` 改为（替换现有 body 中部逻辑）：

```ts
      const status = input.status ?? 'todo';
      const provider = input.executorProvider ?? 'claude';
      if (!isTaskStatus(status)) {
        throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (!isTaskEngine(provider)) {
        throw new AppError(`invalid executor_provider: ${String(provider)}`, { code: 'INVALID_EXECUTOR', statusCode: 400 });
      }
      if (input.priority !== undefined && !isTaskPriority(input.priority)) {
        throw new AppError(`invalid priority: ${String(input.priority)}`, { code: 'INVALID_PRIORITY', statusCode: 400 });
      }
      if (input.deadline !== undefined && input.deadline !== null && !isTaskDeadline(input.deadline)) {
        throw new AppError(`invalid deadline: ${String(input.deadline)}`, { code: 'INVALID_DEADLINE', statusCode: 400 });
      }
      if (input.label !== undefined && !isTaskLabel(input.label)) {
        throw new AppError(`invalid label: ${String(input.label)}`, { code: 'INVALID_LABEL', statusCode: 400 });
      }
      const isOperator = input.isOperator === true;
      let projectPath = input.projectPath;
      if (isOperator) {
        if (provider !== 'claude') {
          throw new AppError('operator tasks must use the claude executor', { code: 'INVALID_EXECUTOR', statusCode: 400 });
        }
        const workspace = expandHome(getOperatorConfig().workspace);
        resolveProject.createProjectPath(workspace);
        if (!resolveProject.getProjectPath(workspace)) {
          throw new AppError(`operator workspace not found: ${workspace}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
        }
        projectPath = workspace;
      } else {
        const project = resolveProject.getProjectPath(input.projectPath);
        if (!project) {
          throw new AppError(`project not found: ${input.projectPath}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
        }
      }
      if (input.sessionId != null) {
        // ... 现有 session 校验不变 ...
      }
      const row = resolveDb.createTask({
        projectPath,
        title: input.title,
        description: input.description ?? null,
        status,
        executorProvider: provider,
        executorModel: input.executorModel ?? null,
        sessionId: input.sessionId ?? null,
        priority: input.priority ?? 'P2',
        deadline: input.deadline ?? null,
        isOperator,
        label: input.label ?? 'other',
        remark: input.remark ?? null,
      });
```

`updateTask` 的 project 变更块开头加：

```ts
      if (wantsProjectChange) {
        if (current.is_operator) {
          throw new AppError('cannot change project for an operator task', { code: 'PROJECT_CHANGE_NOT_ALLOWED', statusCode: 400 });
        }
```

`startExecution` 签名与调用改为：

```ts
    startExecution(
      taskId: string,
      createSession: (provider: TaskEngine, projectPath: string, isOperator?: boolean) => string,
    ): { sessionId: string } | null {
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      const sessionId = createSession(row.executor_provider, row.project_path, Boolean(row.is_operator));
```

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git -C lovdex-backend add server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/tasks.service.test.ts
git -C lovdex-backend commit -m "feat(tasks): service supports priority/deadline/label/remark/operator tasks"
```

---

### Task 5: tasks.routes 解析校验 + index.js createSession 透传

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/tasks.routes.ts`
- Modify: `lovdex-backend/server/index.js`

- [ ] **Step 1: 改 routes**

`tasks.routes.ts`：
- `SessionCreator` 改 `(provider: TaskEngine, projectPath: string, isOperator?: boolean) => string`。
- 顶部 import 补 `isTaskPriority`、`isTaskLabel` 与 `TaskPriority`、`TaskLabel` 类型。
- POST `/` 的 `tasksService.createTask({...})` 加：

```ts
        priority: body.priority as TaskPriority | undefined,
        deadline: typeof body.deadline === 'string' ? body.deadline : null,
        isOperator: body.isOperator === true,
        label: body.label as TaskLabel | undefined,
        remark: typeof body.remark === 'string' ? body.remark : null,
```

  POST 里在 createTask 前校验：

```ts
      if (body.priority !== undefined && (typeof body.priority !== 'string' || !isTaskPriority(body.priority))) {
        throw new AppError(`invalid priority: ${String(body.priority)}`, { code: 'INVALID_PRIORITY', statusCode: 400 });
      }
      if (body.label !== undefined && (typeof body.label !== 'string' || !isTaskLabel(body.label))) {
        throw new AppError(`invalid label: ${String(body.label)}`, { code: 'INVALID_LABEL', statusCode: 400 });
      }
```

- PATCH `/`：`hasFieldUpdates` 数组加 `'priority', 'deadline', 'label', 'remark'`；`updates` 类型加 `priority?: TaskPriority; deadline?: string | null; label?: TaskLabel; remark?: string | null;`；解析加：

```ts
      if (typeof body.priority === 'string') updates.priority = body.priority as TaskPriority;
      if (typeof body.deadline === 'string') updates.deadline = body.deadline;
      if (body.deadline === null) updates.deadline = null;
      if (typeof body.label === 'string') updates.label = body.label as TaskLabel;
      if (typeof body.remark === 'string') updates.remark = body.remark;
      if (body.remark === null) updates.remark = null;
```

  PATCH 里 priority/label 校验（与 POST 相同，放在 isTaskStatus 校验后）。

- [ ] **Step 2: 改 index.js**

`server/index.js` 的 `createSession` wiring 改为：

```js
    createSession: (provider, projectPath, isOperator) => sessionsDb.createAppSession(crypto.randomUUID(), provider, projectPath, isOperator),
```

- [ ] **Step 3: 冒烟验证**

Run: `npx tsx --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: 现有测试通过（routes 无独立测试，靠 service 单测 + 手工冒烟）。

- [ ] **Step 4: Commit**

```bash
git -C lovdex-backend add server/modules/tasks/tasks.routes.ts server/index.js
git -C lovdex-backend commit -m "feat(tasks): routes parse new fields, createSession passes isOperator"
```

---

### Task 6: 项目列表标记 isMainAgentWorkspace

**Files:**
- Modify: `lovdex-backend/server/utils/runtime-paths.js`
- Modify: `lovdex-backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts`

- [ ] **Step 1: 加 getAppRoot + getMainAgentWorkspace**

`runtime-paths.js` 顶部已有 `import path from 'path'` 和 `import { fileURLToPath } from 'url'`，末尾加：

```js
export function getAppRoot() {
  return findAppRoot(getModuleDir(import.meta.url));
}

/**
 * Lovdex 应用运行根目录（主Agent工作目录）：
 * 后端仓库根的父目录，可用 LOVDEX_MAIN_WORKSPACE 覆盖。
 */
export function getMainAgentWorkspace() {
  return process.env.LOVDEX_MAIN_WORKSPACE
    ? path.resolve(process.env.LOVDEX_MAIN_WORKSPACE)
    : path.dirname(getAppRoot());
}
```

> 注意：`getAppRoot()` 是后端仓库根（如 `.../lovdex-backend`），**主Agent工作目录是它的父目录**（如 `/mnt/b/workdir/github/lovdex`，即 supervisor 工作目录）。DB 里 `/home/zhijuhuang/workdir/github/lovdex` realpath 后就是它。

- [ ] **Step 2: 实现标记**

`projects-with-sessions-fetch.service.ts`：
- import 加 `import { getMainAgentWorkspace } from '@/utils/runtime-paths.js';`
- 文件级加缓存：

```ts
let mainAgentRootReal: string | null | undefined; // undefined = 未计算
async function resolveMainAgentRoot(): Promise<string | null> {
  if (mainAgentRootReal === undefined) {
    try {
      mainAgentRootReal = await fs.realpath(getMainAgentWorkspace());
    } catch {
      mainAgentRootReal = null;
    }
  }
  return mainAgentRootReal;
}
```

- `ProjectListItem` 加 `isMainAgentWorkspace: boolean;`
- `getProjectsWithSessions` 循环里，算 displayName 前加：

```ts
    const mainAgentRoot = await resolveMainAgentRoot();
    let isMainAgentWorkspace = false;
    if (mainAgentRoot) {
      try {
        isMainAgentWorkspace = (await fs.realpath(projectPath)) === mainAgentRoot;
      } catch {
        isMainAgentWorkspace = false;
      }
    }
```

  `projects.push` 的对象加 `isMainAgentWorkspace,`。
- `getArchivedProjectsWithSessions` 的 push 加 `isMainAgentWorkspace: false,`（archived 不进任务表单）。

- [ ] **Step 3: 冒烟验证**

Run: `npx tsx --test server/modules/projects/tests/projects-with-sessions-fetch.service.test.ts`（若存在；否则跳过并手验）

手验：curl 后端：

```bash
curl -s 'http://localhost:3001/api/projects?skipSync=1' | grep -o '"isMainAgentWorkspace":[a-z]*' | sort | uniq -c
```

Expected: 只有一个 `"isMainAgentWorkspace":true`（lovdex 根目录项目），其余 false。

- [ ] **Step 4: Commit**

```bash
git -C lovdex-backend add server/utils/runtime-paths.js server/modules/projects/services/projects-with-sessions-fetch.service.ts
git -C lovdex-backend commit -m "feat(projects): mark main agent workspace in project list"
```

---

### Task 7: 前端类型 + taskStatus/taskDeadline/projectOptions 工具

**Files:**
- Modify: `lovdex-cli/src/types/app.ts`
- Modify: `lovdex-cli/src/components/tasks/taskStatus.ts`
- Create: `lovdex-cli/src/components/tasks/taskDeadline.ts`
- Create: `lovdex-cli/src/components/tasks/projectOptions.ts`
- Test: `lovdex-cli/src/components/tasks/taskStatus.test.ts`
- Create: `lovdex-cli/src/components/tasks/taskDeadline.test.ts`
- Create: `lovdex-cli/src/components/tasks/projectOptions.test.ts`

- [ ] **Step 1: 改类型**

`types/app.ts`：
- `TaskEngine` 定义后加：

```ts
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TaskLabel = 'bug' | 'feature' | 'optimization' | 'refactor' | 'docs' | 'other';
```

- `Project` 接口 `taskmaster?` 后加 `isMainAgentWorkspace?: boolean;`
- `Task` 接口 `verdict_at: string | null;` 后加：

```ts
  priority: TaskPriority;
  deadline: string | null;
  is_operator: number; // 0 | 1 — 1 = Lovdex 助手任务
  label: TaskLabel;
  remark: string | null;
```

- [ ] **Step 2: 修测试工厂（先让现有测试编译通过）**

`taskStatus.test.ts`/`taskTimestamp.test.ts`/`useLinkedTask.test.ts` 的 Task 字面量各加：

```ts
    priority: 'P2',
    deadline: null,
    is_operator: 0,
    label: 'other',
    remark: null,
```

（找到 `verdict_at: null,` 行，紧跟其后加。）

- [ ] **Step 3: 写 taskStatus 工具 + 测试**

`taskStatus.ts` 末尾加：

```ts
export const PRIORITY_ORDER: TaskPriority[] = ['P0', 'P1', 'P2', 'P3'];

export const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  P0: { label: 'P0 紧急', color: '#ef4444' },
  P1: { label: 'P1 高', color: '#f97316' },
  P2: { label: 'P2 中', color: '#3b82f6' },
  P3: { label: 'P3 低', color: '#6b7280' },
};

export const LABEL_ORDER: TaskLabel[] = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other'];

export const LABEL_META: Record<TaskLabel, { label: string; color: string }> = {
  bug: { label: 'BUG', color: '#ef4444' },
  feature: { label: '新特性', color: '#22c55e' },
  optimization: { label: '优化', color: '#3b82f6' },
  refactor: { label: '重构', color: '#a855f7' },
  docs: { label: '文档', color: '#06b6d4' },
  other: { label: '其他', color: '#6b7280' },
};
```

import 行加 `TaskPriority, TaskLabel`。`taskStatus.test.ts` 追加：

```ts
import { PRIORITY_ORDER, PRIORITY_META, LABEL_ORDER, LABEL_META } from './taskStatus';
test('PRIORITY_META covers all priorities', () => {
  assert.deepEqual(PRIORITY_ORDER, ['P0', 'P1', 'P2', 'P3']);
  for (const p of PRIORITY_ORDER) assert.ok(PRIORITY_META[p].label && PRIORITY_META[p].color);
});
test('LABEL_META covers all labels', () => {
  assert.deepEqual(LABEL_ORDER, ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other']);
  for (const l of LABEL_ORDER) assert.ok(LABEL_META[l].label && LABEL_META[l].color);
});
```

- [ ] **Step 4: 写 taskDeadline + 测试**

Create `taskDeadline.ts`：

```ts
import type { Task } from '../../types/app';

/** 剩余天数/逾期文案。deadline 是 YYYY-MM-DD，按本地时区当天 23:59:59.999 算截止。 */
export function deadlineInfo(deadline: string, now: Date): { label: string; overdue: boolean } {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!parts) return { label: deadline, overdue: false };
  const due = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 23, 59, 59, 999);
  // floor：deadline 明天 → 剩 1 天；今天 → 0 → 「今天截止」；逾期用 -days
  const days = Math.floor((due.getTime() - now.getTime()) / 86400000);
  if (days < 0) return { label: `已逾期 ${-days} 天`, overdue: true };
  if (days === 0) return { label: '今天截止', overdue: false };
  return { label: `剩 ${days} 天`, overdue: false };
}

export function taskDeadlineInfo(task: Task, now: Date): { label: string; overdue: boolean } | null {
  return task.deadline ? deadlineInfo(task.deadline, now) : null;
}
```

Create `taskDeadline.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineInfo } from './taskDeadline';

const NOW = new Date('2026-08-11T12:00:00'); // 本地时间

test('deadlineInfo renders remaining/overdue labels', () => {
  assert.equal(deadlineInfo('2026-08-12', NOW).label, '剩 1 天');
  assert.equal(deadlineInfo('2026-08-11', NOW).label, '今天截止');
  assert.equal(deadlineInfo('2026-08-11', NOW).overdue, false);
  const past = deadlineInfo('2026-08-08', NOW);
  assert.equal(past.label, '已逾期 3 天');
  assert.equal(past.overdue, true);
});

test('deadlineInfo falls back to raw string on malformed input', () => {
  assert.equal(deadlineInfo('nonsense', NOW).label, 'nonsense');
});
```

- [ ] **Step 5: 写 projectOptions + 测试**

Create `projectOptions.ts`：

```ts
import type { Project } from '../../types/app';

/** 「Lovdex 助手」选项的哨兵 value。 */
export const ASSISTANT_OPTION_VALUE = '__lovdex_assistant__';

export const projectPathOf = (project: Project): string => project.fullPath || project.path || '';

/**
 * 任务表单的项目候选：排除主Agent工作目录，收藏优先，再按 displayName 升序。
 * 「Lovdex 助手」选项由调用方放在列表头部（见 ASSISTANT_OPTION_VALUE）。
 */
export function taskFormProjects(projects: Project[]): Project[] {
  return projects
    .filter((p) => !p.isMainAgentWorkspace)
    .sort((a, b) => {
      const aStarred = Boolean(a.isStarred);
      const bStarred = Boolean(b.isStarred);
      if (aStarred !== bStarred) return aStarred ? -1 : 1;
      return (a.displayName || projectPathOf(a)).localeCompare(b.displayName || projectPathOf(b));
    });
}
```

Create `projectOptions.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../../types/app';
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects } from './projectOptions';

const mkProject = (over: Partial<Project> & { displayName: string; fullPath: string }): Project => ({
  projectId: over.fullPath,
  path: over.fullPath,
  isStarred: false,
  isMainAgentWorkspace: false,
  ...over,
});

test('taskFormProjects excludes main agent workspace and sorts starred first', () => {
  const main = mkProject({ displayName: 'lovdex', fullPath: '/root', isMainAgentWorkspace: true });
  const star = mkProject({ displayName: 'zeta', fullPath: '/z', isStarred: true });
  const plain = mkProject({ displayName: 'alpha', fullPath: '/a' });
  const out = taskFormProjects([plain, main, star]);
  assert.deepEqual(out.map((p) => p.fullPath), ['/z', '/a']);
});

test('projectPathOf falls back from fullPath to path', () => {
  assert.equal(projectPathOf({ fullPath: '/x' } as Project), '/x');
  assert.equal(projectPathOf({ path: '/y' } as Project), '/y');
});

test('assistant sentinel is a stable string', () => {
  assert.equal(typeof ASSISTANT_OPTION_VALUE, 'string');
});
```

- [ ] **Step 6: 运行全部前端工具测试**

Run（`unset TSX_TSCONFIG_PATH`）：
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskStatus.test.ts src/components/tasks/taskDeadline.test.ts src/components/tasks/projectOptions.test.ts src/components/tasks/taskTimestamp.test.ts src/hooks/useLinkedTask.test.ts
```
Expected: 全部通过。

- [ ] **Step 7: Commit**

```bash
git -C lovdex-cli add src/types/app.ts src/components/tasks/taskStatus.ts src/components/tasks/taskStatus.test.ts src/components/tasks/taskTimestamp.test.ts src/hooks/useLinkedTask.test.ts src/components/tasks/taskDeadline.ts src/components/tasks/taskDeadline.test.ts src/components/tasks/projectOptions.ts src/components/tasks/projectOptions.test.ts
git -C lovdex-cli commit -m "feat(tasks): types + priority/deadline/label/project-sort utilities"
```

---

### Task 8: TaskBoard 防呆 + 下拉 + 优先级/Deadline

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: import 与 state**

顶部 import 加：

```ts
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects } from './projectOptions';
import { PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
```

删除本地 `projectPathOf` 定义（改为 import）。state 加：

```ts
  const [newPriority, setNewPriority] = useState<TaskPriority>('P2');
  const [newDeadline, setNewDeadline] = useState('');
```

`types/app` import 加 `TaskPriority`。`duplicateProjectNames` 的 `projects` 引用改为 `taskFormProjects(projects)`（去重逻辑只用显示名）。

- [ ] **Step 2: 防呆**

「＋ 新建任务」按钮加 `disabled={creating}`：

```tsx
          <Button size="sm" className="h-8 px-3 text-sm" onClick={toggleCreateForm} disabled={creating}>
            ＋ 新建任务
          </Button>
```

- [ ] **Step 3: 项目下拉改候选 + 助手选项**

load effect 里 `setNewProjectPath(projectPathOf(list[0]))` 改为：

```ts
        const formProjects = taskFormProjects(list);
        if (formProjects.length > 0) setNewProjectPath(projectPathOf(formProjects[0]));
```

下拉 JSX 改为（替换现有 `<select>` 块）：

```tsx
          <select
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground sm:w-64"
            value={newProjectPath}
            onChange={(e) => setNewProjectPath(e.target.value)}
          >
            <option value={ASSISTANT_OPTION_VALUE}>🤖 Lovdex 助手</option>
            {taskFormProjects(projects).map((project) => {
              const path = projectPathOf(project);
              const name = project.displayName || path;
              const label =
                duplicateProjectNames.has(name) && name !== path ? `${name} — ${path}` : name;
              return (
                <option key={project.projectId} value={path} title={path}>
                  {label}
                </option>
              );
            })}
          </select>
```

- [ ] **Step 4: 优先级/Deadline/Label/备注 输入**

引擎 select 后、模型 select 前（或按钮区前）加：

```tsx
          <select
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground sm:w-28"
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>{PRIORITY_META[p].label}</option>
            ))}
          </select>
          <Input
            type="date"
            className="h-9 w-full sm:w-40"
            value={newDeadline}
            onChange={(e) => setNewDeadline(e.target.value)}
          />
          <select
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground sm:w-32"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value as TaskLabel)}
          >
            {LABEL_ORDER.map((l) => (
              <option key={l} value={l}>{LABEL_META[l].label}</option>
            ))}
          </select>
          <Input
            className="h-9 w-full sm:w-56"
            placeholder="备注（需求来源等，可选）"
            value={newRemark}
            onChange={(e) => setNewRemark(e.target.value)}
          />
```

- [ ] **Step 5: createTask 逻辑**

`toggleCreateForm` 重置加 `setNewPriority('P2'); setNewDeadline(''); setNewLabel('other'); setNewRemark('');`。

`createTask()` 改为：

```ts
  async function createTask() {
    const projectPath = newProjectPath;
    const prompt = newPrompt.trim();
    const isAssistant = projectPath === ASSISTANT_OPTION_VALUE;
    if (!isAssistant && !projectPath) return;
    if (!prompt) return;
    const title = newName.trim() || deriveTaskName(prompt);
    try {
      const res = await api.tasks.create({
        projectPath: isAssistant ? '' : projectPath,
        title,
        description: prompt,
        executorProvider: isAssistant ? 'claude' : newEngine,
        executorModel: isAssistant ? null : (newModel || null),
        status: 'todo',
        priority: newPriority,
        deadline: newDeadline || null,
        isOperator: isAssistant,
        label: newLabel,
        remark: newRemark.trim() || null,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('createTask failed', err?.error?.message ?? res.status);
        return;
      }
      setCreating(false);
      setNewPrompt('');
      setNewName('');
      setNewPriority('P2');
      setNewDeadline('');
      setNewLabel('other');
      setNewRemark('');
      void refresh();
    } catch (err) {
      console.error('createTask failed', err);
    }
  }
```

> Step 1 的 state 里加 `const [newLabel, setNewLabel] = useState<TaskLabel>('other');` 与 `const [newRemark, setNewRemark] = useState('');`；`types/app` import 加 `TaskLabel`；`taskStatus` import 加 `LABEL_ORDER, LABEL_META`。

- [ ] **Step 6: 手动冒烟（dev 环境）**

Run: `cd lovdex-cli && npx vite` 或经 supervisor 前端（5187）。打开 `/tasks`，验证：表单打开时按钮置灰；下拉顶部是「🤖 Lovdex 助手」，主Agent工作目录项目不出现，收藏项目在前；优先级/Label/Deadline/备注可填；选助手创建任务 → 任务出现在看板且带助手标记（后端逻辑生效）。

- [ ] **Step 7: Commit**

```bash
git -C lovdex-cli add src/components/tasks/TaskBoard.tsx
git -C lovdex-cli commit -m "feat(tasks): create form - guard, assistant option, priority/deadline/label/remark"
```

---

### Task 9: TaskCard 优先级/Deadline/助手徽章

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskCard.tsx`

- [ ] **Step 1: 改组件**

import 加：

```ts
import { LABEL_META, PRIORITY_META } from './taskStatus';
import { taskDeadlineInfo } from './taskDeadline';
```

`now` 已有。在组件内（`timeLabel` 之后）加：

```ts
  const deadline = taskDeadlineInfo(task, now);
```

标题行 `task.title` span 后、时间行前，加徽章行（替换现有项目/引擎徽章块开头，加优先级 + deadline + 助手）：

```tsx
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {task.label && LABEL_META[task.label] && (
          <span
            className="rounded-full px-2 py-0.5 font-semibold"
            style={{ color: LABEL_META[task.label].color, backgroundColor: `${LABEL_META[task.label].color}1a` }}
          >
            {LABEL_META[task.label].label}
          </span>
        )}
        {task.priority && (
          <span
            className="rounded-full px-2 py-0.5 font-semibold"
            style={{ color: PRIORITY_META[task.priority].color, backgroundColor: `${PRIORITY_META[task.priority].color}1a` }}
          >
            {PRIORITY_META[task.priority].label}
          </span>
        )}
        {task.is_operator === 1 && (
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 font-semibold text-violet-500 dark:text-violet-400">
            🤖 助手
          </span>
        )}
        {deadline && (
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              deadline.overdue
                ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {deadline.overdue ? '⏰ ' : ''}{deadline.label}
          </span>
        )}
        <span className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
          {task.project_path}
        </span>
```

（保留原引擎/模型徽章。）

- [ ] **Step 2: 冒烟 + Commit**

Run: 前端 `unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskDeadline.test.ts`（确保工具通过，卡片本身靠手验）。

```bash
git -C lovdex-cli add src/components/tasks/TaskCard.tsx
git -C lovdex-cli commit -m "feat(tasks): card shows label/priority/deadline/assistant badges"
```

---

### Task 10: TaskDetail 属性编辑 + 下拉 + 助手徽章

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: import 与 state**

import 加：

```ts
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects } from './projectOptions';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
```

删除本地 `projectPathOf` 定义（改用 import）。state 加：

```ts
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [deadline, setDeadline] = useState('');
  const [label, setLabel] = useState<TaskLabel>('other');
  const [remark, setRemark] = useState('');
```

`types/app` import 加 `TaskPriority, TaskLabel`。`duplicateProjectNames` 的 `projects` 改为 `taskFormProjects(projects)`。

- [ ] **Step 2: 同步 task 加载**

`load` 成功分支 `setDescription(...)` 后加：

```ts
      setPriority(data.priority ?? 'P2');
      setDeadline(data.deadline ?? '');
      setLabel(data.label ?? 'other');
      setRemark(data.remark ?? '');
```

WS upsert 分支的 `setTask` 补 `priority: next.priority ?? prev.priority, deadline: next.deadline ?? prev.deadline, is_operator: next.is_operator ?? prev.is_operator, label: next.label ?? prev.label, remark: next.remark ?? prev.remark,`。

- [ ] **Step 3: 保存 handler**

`saveFields` 后加：

```ts
  async function savePriority(nextPriority: TaskPriority) {
    if (!task || nextPriority === task.priority) return;
    setPriority(nextPriority);
    try {
      const res = await api.tasks.update(task.task_id, { priority: nextPriority });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save priority failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save priority failed', err); }
  }

  async function saveDeadline(nextDeadline: string) {
    if (!task) return;
    setDeadline(nextDeadline);
    const value = nextDeadline || null;
    if (value === task.deadline) return;
    try {
      const res = await api.tasks.update(task.task_id, { deadline: value });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save deadline failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save deadline failed', err); }
  }

  async function saveLabel(nextLabel: TaskLabel) {
    if (!task || nextLabel === task.label) return;
    setLabel(nextLabel);
    try {
      const res = await api.tasks.update(task.task_id, { label: nextLabel });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save label failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save label failed', err); }
  }

  async function saveRemark(nextRemark: string) {
    if (!task) return;
    setRemark(nextRemark);
    const value = nextRemark.trim() || null;
    if (value === task.remark) return;
    try {
      const res = await api.tasks.update(task.task_id, { remark: value });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save remark failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save remark failed', err); }
  }
```

- [ ] **Step 4: 标题旁助手徽章 + 项目下拉**

标题行 `<p className="mt-1 font-mono text-xs ...">` 前加助手徽章（当 `task.is_operator === 1`）：

```tsx
            {task.is_operator === 1 && (
              <span className="mt-1 inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-500 dark:text-violet-400">
                🤖 Lovdex 助手
              </span>
            )}
```

「所属项目」块：operator 任务只读；否则下拉用 `taskFormProjects`，且当前项目不在候选时补一个禁用 option：

```tsx
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">所属项目</div>
                  {task.status === 'todo' && task.is_operator !== 1 ? (
                    <select
                      className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                      value={projectPath}
                      onChange={(e) => void changeProject(e.target.value)}
                    >
                      {!taskFormProjects(projects).some((p) => projectPathOf(p) === projectPath) && (
                        <option value={projectPath} disabled>{projectPath}</option>
                      )}
                      {taskFormProjects(projects).map((project) => {
                        const path = projectPathOf(project);
                        const name = project.displayName || path;
                        const label =
                          duplicateProjectNames.has(name) && name !== path ? `${name} — ${path}` : name;
                        return (
                          <option key={project.projectId} value={path} title={path}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                  ) : (
                    <div className="text-sm text-foreground">{task.project_path}</div>
                  )}
                </div>
```

- [ ] **Step 5: 属性区优先级 + Deadline 编辑**

「属性」grid 里「创建时间」之前加：

```tsx
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">优先级</div>
                  <select
                    className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={priority}
                    onChange={(e) => void savePriority(e.target.value as TaskPriority)}
                  >
                    {PRIORITY_ORDER.map((p) => (
                      <option key={p} value={p}>{PRIORITY_META[p].label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">截止日期</div>
                  <input
                    type="date"
                    className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={deadline}
                    onChange={(e) => void saveDeadline(e.target.value)}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Label</div>
                  <select
                    className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={label}
                    onChange={(e) => void saveLabel(e.target.value as TaskLabel)}
                  >
                    {LABEL_ORDER.map((l) => (
                      <option key={l} value={l}>{LABEL_META[l].label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">备注</div>
                  <input
                    className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={remark}
                    placeholder="需求来源等，可留空"
                    onChange={(e) => setRemark(e.target.value)}
                    onBlur={() => { if (remark.trim() !== (task?.remark ?? '')) void saveRemark(remark); }}
                  />
                </div>
```

> 备注用受控 input + onBlur 保存（和标题一致），避免每次按键都发请求。

- [ ] **Step 6: 冒烟 + Commit**

Run: `unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskDeadline.test.ts`（回归）。

```bash
git -C lovdex-cli add src/components/tasks/TaskDetail.tsx
git -C lovdex-cli commit -m "feat(tasks): detail page priority/deadline/label/remark edit + assistant badge"
```

---

### Task 11: 全量回归 + 收尾

**Files:**
- 两端各跑测试 + typecheck

- [ ] **Step 1: 后端全量测试**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/shared/tests/task-status-model.test.ts server/modules/database/tests/tasks.db.integration.test.ts server/modules/database/tests/tasks-status-migration.test.ts server/modules/tasks/tests/tasks.service.test.ts
```
Expected: 全部通过。

- [ ] **Step 2: 前端全量工具测试**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskStatus.test.ts src/components/tasks/taskTimestamp.test.ts src/components/tasks/taskDeadline.test.ts src/components/tasks/projectOptions.test.ts src/hooks/useLinkedTask.test.ts
```
Expected: 全部通过。

- [ ] **Step 3: typecheck（尽力而为）**

Run: `cd lovdex-cli && npx tsc --noEmit -p tsconfig.json`
Expected: 如报错，仅修与本次改动相关的（Task 字面量缺新字段等）；后端 `tsc` 已知有存量 utils.ts 错误，可跳过。

- [ ] **Step 4: 端到端冒烟（经 supervisor 或 dev server）**

验证清单：
1. `/tasks` 新建表单：打开时「＋新建任务」置灰；下拉顶部「🤖 Lovdex 助手」，主Agent工作目录项目不出现，收藏项目在前。
2. 新建任务填优先级 P0 + deadline + Label「BUG」+ 备注 → 创建成功，卡片显示 P0/Label/deadline 徽章 + 备注可见。
3. 选「🤖 Lovdex 助手」创建 → 任务带助手徽章；「开始执行」→ 会话走 operator 分支（聊天 UI 无 Bash/Edit 工具提示）。
4. 详情页改优先级/deadline/Label/备注 → 保存生效。
5. 前端构建 `cd lovdex-cli && npx vite build` 无错（或至少 `npm run build` 通过）。

- [ ] **Step 5: 合入 main + 推送**

按仓库偏好 ff-merge 到 main 并 push（两仓库分别）：

```bash
git -C lovdex-backend add -A && git -C lovdex-backend commit -m "chore: task board enhancements" # 若有未提交
git -C lovdex-backend checkout main && git -C lovdex-backend merge --ff-only <feature-branch>
git -C lovdex-backend push origin main
git -C lovdex-cli checkout main && git -C lovdex-cli merge --ff-only <feature-branch>
git -C lovdex-cli push origin main
```

> 提交前 `git -C <repo> status` 确认无并发会话改动（见 memory：并发会话坑）。

---

## Self-Review

- **Spec 覆盖**：①排除主Agent工作目录+助手选项 → Task 6 + 7 + 8；②防呆 → Task 8 Step 2；③优先级+Deadline → Task 1-5 + 7 + 8 + 10；④收藏优先 → Task 7 projectOptions + Task 8；⑤Label+备注 → Task 1-5 + 7 + 8 + 10。全部覆盖。
- **占位符扫描**：无 TBD/TODO；每步都有代码/命令。
- **类型一致性**：后端 `is_operator`(number) ↔ 前端 `is_operator: number`；`priority: TaskPriority`/`TaskPriority`；`deadline: string | null`；`label: TaskLabel`/`TaskLabel`；`remark: string | null`；`isMainAgentWorkspace` 前后端同名。`ASSISTANT_OPTION_VALUE` 全局唯一哨兵。
