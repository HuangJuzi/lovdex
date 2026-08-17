# 任务生命周期时间戳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任务页面（看板卡片 + 详情页）的每个任务，无论处于什么状态，都展示一个与当前状态语义对应的时间戳。

**Architecture:** 后端 `tasks` 表新增可空字段 `started_at` / `completed_at`，在状态流转时（`updateTaskStatus` / `moveTask`）写入；前端按状态选择最相关的时间字段，兜底到 `updated_at → created_at`，保证任何任务任何状态必有时间戳。

**Tech Stack:** Node.js + better-sqlite3（后端）、React + TypeScript + Tailwind（前端）、`node:test` 经 `tsx` 运行。

**仓库布局（重要）：** `/mnt/b/workdir/github/lovdex` 下有两个独立 git 仓库：`lovdex-backend/` 和 `lovdex-cli/`。所有后端命令在 `lovdex-backend/` 内执行，所有前端命令在 `lovdex-cli/` 内执行。本计划在两个仓库各开一个 `feat/task-timestamps` 分支。

**测试命令（已验证可用）：**
- 后端：`npx tsx --tsconfig server/tsconfig.json --test <file>`
- 前端：`npx tsx --tsconfig tsconfig.json --test <file>`

---

## File Structure

**后端 (`lovdex-backend/`)**
- Modify: `server/modules/database/schema.ts` — 建表 SQL 加两列
- Modify: `server/modules/database/migrations.ts` — 老库 ALTER 补两列
- Modify: `server/modules/database/repositories/tasks.db.ts` — 状态流转写时间戳 + normalize 覆盖新字段
- Modify: `server/shared/types.ts` — `TaskRow` 加两字段
- Modify: `server/modules/database/tests/tasks.db.integration.test.ts` — 补状态流转时间戳用例
- Modify: `server/modules/tasks/tests/execution-linkage.test.ts` — `makeRow` 补两字段以适配类型

**前端 (`lovdex-cli/`)**
- Modify: `src/types/app.ts` — `Task` 加两字段
- Create: `src/components/tasks/taskTimestamp.ts` — label 选择 + 相对/绝对时间格式化
- Create: `src/components/tasks/taskTimestamp.test.ts` — helper 单测
- Modify: `src/components/tasks/TaskCard.tsx` — 卡片底部展示时间戳
- Modify: `src/components/tasks/TaskDetail.tsx` — 属性卡片展示创建/更新/开始/完成时间

---

### Task 0: 开 feature 分支

**Files:** 无

- [ ] **Step 1: 在两个仓库各开 `feat/task-timestamps` 分支**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git checkout -b feat/task-timestamps
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git checkout -b feat/task-timestamps
```

Expected: 两个仓库均切换到新分支 `feat/task-timestamps`。

---

### Task 1: 后端 schema + migration 加 started_at / completed_at

**Files:**
- Modify: `lovdex-backend/server/modules/database/schema.ts:124-137`
- Modify: `lovdex-backend/server/modules/database/migrations.ts:425-432`

- [ ] **Step 1: 在 `TASKS_TABLE_SCHEMA_SQL` 建表语句中、`session_id` 之后、`created_at` 之前加两列**

把 `schema.ts` 中的 `tasks` 建表块改为：

```sql
CREATE TABLE IF NOT EXISTS tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'backlog'
                      CHECK (status IN ('backlog','todo','in_progress','in_review','done')),
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 2: 改 `migrateTasksTable`，对已存在的 tasks 表补两列**

把 `migrations.ts` 中的 `migrateTasksTable` 改为：

```ts
const migrateTasksTable = (db: Database): void => {
  if (!tableExists(db, 'tasks')) {
    console.log('Running migration: creating tasks table');
    db.exec(TASKS_TABLE_SCHEMA_SQL);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
    return;
  }
  const tasksTableInfo = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  const taskColumnNames = tasksTableInfo.map((column) => column.name);
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'started_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'completed_at', 'DATETIME');
};
```

- [ ] **Step 3: 运行现有集成测试确认无回归**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks.db.integration.test.ts`
Expected: `# pass 3`，`# fail 0`。

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/database/schema.ts server/modules/database/migrations.ts
git commit -m "feat(tasks): add started_at/completed_at columns and migration

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 后端 TaskRow 类型加两字段

**Files:**
- Modify: `lovdex-backend/server/shared/types.ts:649-661`

- [ ] **Step 1: 在 `TaskRow` 中 `session_id` 之后、`created_at` 之前加两字段**

```ts
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
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 2: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npm run typecheck`
Expected: 无错误退出。（`tasks.db.ts` 的 `normalizeTaskRow` 用 `...row` 展开，新字段会原样透传，类型仍兼容；Task 3 才正式处理新字段。）

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/shared/types.ts
git commit -m "feat(tasks): add started_at/completed_at to TaskRow

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 后端状态流转写时间戳（TDD）

**Files:**
- Modify: `lovdex-backend/server/modules/database/repositories/tasks.db.ts`
- Test: `lovdex-backend/server/modules/database/tests/tasks.db.integration.test.ts`
- Modify: `lovdex-backend/server/modules/tasks/tests/execution-linkage.test.ts`（`makeRow` 适配类型）

- [ ] **Step 1: 先写失败测试。在 `tasks.db.integration.test.ts` 末尾追加两个 test**

```ts
test('tasksDb status transitions write started_at / completed_at', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/ts');
    const created = tasksDb.createTask({ projectPath: '/tmp/ts', title: 't', executorProvider: 'claude' });
    assert.equal(created.started_at, null);
    assert.equal(created.completed_at, null);

    tasksDb.updateTaskStatus(created.task_id, 'in_progress');
    const running = tasksDb.getTask(created.task_id)!;
    assert.ok(running.started_at, 'started_at set on in_progress');
    assert.equal(running.completed_at, null);

    tasksDb.updateTaskStatus(created.task_id, 'done');
    const done = tasksDb.getTask(created.task_id)!;
    assert.ok(done.completed_at, 'completed_at set on done');

    // Reopen: leaving done clears completed_at; entering in_progress refreshes started_at
    tasksDb.updateTaskStatus(created.task_id, 'in_progress');
    const reopened = tasksDb.getTask(created.task_id)!;
    assert.equal(reopened.completed_at, null, 'completed_at cleared when leaving done');
    assert.ok(reopened.started_at, 'started_at remains set on re-run');
  });
});

test('tasksDb.moveTask writes started_at / completed_at like updateTaskStatus', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/mv');
    const created = tasksDb.createTask({ projectPath: '/tmp/mv', title: 't', executorProvider: 'claude' });
    tasksDb.moveTask(created.task_id, 'in_progress', null, null);
    assert.ok(tasksDb.getTask(created.task_id)?.started_at, 'moveTask to in_progress sets started_at');
    tasksDb.moveTask(created.task_id, 'done', null, null);
    assert.ok(tasksDb.getTask(created.task_id)?.completed_at, 'moveTask to done sets completed_at');
  });
});
```

- [ ] **Step 2: 运行新测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks.db.integration.test.ts`
Expected: `# fail 2`（`started_at` 为 `undefined`/null，断言 `assert.ok(running.started_at)` 失败）。

- [ ] **Step 3: 实现。改 `tasks.db.ts`**

3a. 在文件顶部 `normalizeTaskRow` 之前加一个辅助函数（紧挨 `normalizeTaskRow` 上方）：

```ts
/**
 * Extra SET clauses written alongside a status change so each lifecycle
 * timestamp records the moment the task entered its corresponding state.
 * - entering in_progress  → started_at = now (refreshed on every re-run)
 * - entering done         → completed_at = now
 * - leaving done          → completed_at = NULL (task reopened, completion invalidated)
 */
function statusTimestampSets(from: TaskStatus, to: TaskStatus): string[] {
  const sets: string[] = [];
  if (to === 'in_progress') sets.push('started_at = CURRENT_TIMESTAMP');
  if (to === 'done') sets.push('completed_at = CURRENT_TIMESTAMP');
  if (to !== 'done' && from === 'done') sets.push('completed_at = NULL');
  return sets;
}
```

3b. 扩展 `normalizeTaskRow` 覆盖新字段（NULL 透传）：

```ts
function normalizeTaskRow(row: TaskRow): TaskRow {
  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
    started_at: row.started_at ? (normalizeTimestamp(row.started_at) ?? row.started_at) : null,
    completed_at: row.completed_at ? (normalizeTimestamp(row.completed_at) ?? row.completed_at) : null,
  };
}
```

3c. 改 `updateTaskStatus`，先读旧 status 再带 side-effect SET：

```ts
  updateTaskStatus(taskId: string, status: TaskStatus): void {
    const db = getConnection();
    const current = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status: TaskStatus } | undefined;
    if (!current) return;
    const sets = ['status = ?', 'updated_at = CURRENT_TIMESTAMP', ...statusTimestampSets(current.status, status)];
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(status, taskId);
  },
```

3d. 改 `moveTask`，在算 position 前读旧 status，UPDATE 时带 side-effect SET：

```ts
  moveTask(taskId: string, status: TaskStatus, beforeId: string | null, afterId: string | null): void {
    const db = getConnection();
    const current = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status: TaskStatus } | undefined;
    if (!current) return;
    let position: number;
    if (beforeId && afterId) {
      const before = tasksDb.getTask(beforeId);
      const after = tasksDb.getTask(afterId);
      const beforePos = before?.position ?? 0;
      const afterPos = after?.position ?? beforePos;
      position = (beforePos + afterPos) / 2;
    } else if (beforeId) {
      const before = tasksDb.getTask(beforeId);
      position = (before?.position ?? 0) - 1;
    } else if (afterId) {
      const after = tasksDb.getTask(afterId);
      position = (after?.position ?? 0) + 1;
    } else {
      const max = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE status = ?').get(status) as { p: number };
      position = max.p;
    }
    const sets = ['status = ?', 'position = ?', 'updated_at = CURRENT_TIMESTAMP', ...statusTimestampSets(current.status, status)];
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(status, position, taskId);
  },
```

- [ ] **Step 4: 适配 `execution-linkage.test.ts` 的 `makeRow`，补两字段**

把该文件 `makeRow` 的返回对象改为（在 `session_id: 's1',` 之后、`created_at` 之前加两行）：

```ts
function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    task_id: 't1',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'todo',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id: 's1',
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks.db.integration.test.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/execution-linkage.test.ts`
Expected: 集成测试 `# pass 5`（原 3 + 新 2），execution-linkage 全绿。

- [ ] **Step 6: typecheck + lint**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npm run typecheck && npm run lint`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/database/repositories/tasks.db.ts server/modules/database/tests/tasks.db.integration.test.ts server/modules/tasks/tests/execution-linkage.test.ts
git commit -m "feat(tasks): record started_at/completed_at on status transitions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 前端 Task 类型加两字段

**Files:**
- Modify: `lovdex-cli/src/types/app.ts:79-91`

- [ ] **Step 1: 在 `Task` 中 `session_id` 之后、`created_at` 之前加两字段**

```ts
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
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: 无错误。（`taskStatus.test.ts` 的 `mk` 用 `...overrides` 且不涉及新字段，但需补默认值以避免 `started_at` 为 `undefined` 触发类型错误——见 Step 3。）

- [ ] **Step 3: 给 `taskStatus.test.ts` 的 `mk` 补两字段默认值**

把 `src/components/tasks/taskStatus.test.ts` 中 `mk` 的返回对象改为（在 `session_id: null,` 之后、`created_at: '',` 之前加两行）：

```ts
function mk(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'x',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'todo',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id: null,
    started_at: null,
    completed_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}
```

- [ ] **Step 4: 再 typecheck + 跑现有 taskStatus 测试**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck && npx tsx --tsconfig tsconfig.json --test src/components/tasks/taskStatus.test.ts`
Expected: typecheck 无错误，测试 `# pass 4`。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/types/app.ts src/components/tasks/taskStatus.test.ts
git commit -m "feat(tasks): add started_at/completed_at to Task type

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 前端 taskTimestamp helper（TDD）

**Files:**
- Create: `lovdex-cli/src/components/tasks/taskTimestamp.ts`
- Test: `lovdex-cli/src/components/tasks/taskTimestamp.test.ts`

- [ ] **Step 1: 先写测试文件 `taskTimestamp.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { taskTimeLabel, formatRelativeTime, formatAbsoluteTime } from './taskTimestamp';

function mk(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'x',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'todo',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-08-07T10:00:00.000Z',
    updated_at: '2026-08-07T10:00:00.000Z',
    ...overrides,
  };
}

test('taskTimeLabel: backlog/todo → 创建于 created_at', () => {
  assert.deepEqual(taskTimeLabel(mk({ status: 'backlog' })), { label: '创建于', iso: '2026-08-07T10:00:00.000Z' });
  assert.deepEqual(taskTimeLabel(mk({ status: 'todo' })), { label: '创建于', iso: '2026-08-07T10:00:00.000Z' });
});

test('taskTimeLabel: in_progress → 开始于 started_at with fallback', () => {
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'in_progress', started_at: '2026-08-07T11:00:00.000Z' })),
    { label: '开始于', iso: '2026-08-07T11:00:00.000Z' },
  );
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'in_progress', started_at: null, updated_at: '2026-08-07T11:30:00.000Z' })),
    { label: '开始于', iso: '2026-08-07T11:30:00.000Z' },
  );
});

test('taskTimeLabel: in_review → 完成于 updated_at', () => {
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'in_review', updated_at: '2026-08-07T12:00:00.000Z' })),
    { label: '完成于', iso: '2026-08-07T12:00:00.000Z' },
  );
});

test('taskTimeLabel: done → 完成于 completed_at with fallback', () => {
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'done', completed_at: '2026-08-07T13:00:00.000Z' })),
    { label: '完成于', iso: '2026-08-07T13:00:00.000Z' },
  );
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'done', completed_at: null, updated_at: '2026-08-07T13:30:00.000Z' })),
    { label: '完成于', iso: '2026-08-07T13:30:00.000Z' },
  );
});

test('formatRelativeTime buckets', () => {
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-07T10:00:30.000Z')), '刚刚');
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-07T10:05:00.000Z')), '5 分钟前');
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-07T12:00:00.000Z')), '2 小时前');
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-10T10:00:00.000Z')), '3 天前');
});

test('formatRelativeTime invalid → —', () => {
  assert.equal(formatRelativeTime('not-a-date', new Date()), '—');
});

test('formatAbsoluteTime invalid → —', () => {
  assert.equal(formatAbsoluteTime('not-a-date'), '—');
});

test('formatAbsoluteTime formats Y-M-D H:m shape', () => {
  assert.match(formatAbsoluteTime('2026-08-07T10:00:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});
```

- [ ] **Step 2: 运行测试确认失败（模块不存在）**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsx --tsconfig tsconfig.json --test src/components/tasks/taskTimestamp.test.ts`
Expected: 失败，找不到模块 `./taskTimestamp`。

- [ ] **Step 3: 实现 `taskTimestamp.ts`**

```ts
import type { Task } from '../../types/app';

/**
 * Pick the timestamp most relevant to the task's current lifecycle state.
 * Every branch falls back through updated_at → created_at so a card always
 * renders a time regardless of how sparse the row is.
 */
export function taskTimeLabel(task: Task): { label: string; iso: string } {
  switch (task.status) {
    case 'in_progress':
      return { label: '开始于', iso: task.started_at ?? task.updated_at ?? task.created_at };
    case 'in_review':
      return { label: '完成于', iso: task.updated_at ?? task.created_at };
    case 'done':
      return { label: '完成于', iso: task.completed_at ?? task.updated_at ?? task.created_at };
    default:
      return { label: '创建于', iso: task.created_at };
  }
}

export function formatRelativeTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return '刚刚'; // clock skew / future timestamp
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsx --tsconfig tsconfig.json --test src/components/tasks/taskTimestamp.test.ts`
Expected: `# pass 8`，`# fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/tasks/taskTimestamp.ts src/components/tasks/taskTimestamp.test.ts
git commit -m "feat(tasks): task timestamp label + relative/absolute formatters

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 前端 TaskCard 展示时间戳

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskCard.tsx`

- [ ] **Step 1: 在 `TaskCard.tsx` 顶部加 import**

在已有的 `import { STATUS_META, taskSessionState } from './taskStatus';` 之后加：

```ts
import { formatAbsoluteTime, formatRelativeTime, taskTimeLabel } from './taskTimestamp';
```

- [ ] **Step 2: 在组件体内（`const isClaude = ...` 之后）计算时间标签**

```ts
  const timeLabel = taskTimeLabel(task);
  const now = new Date();
```

- [ ] **Step 3: 在 meta 行 `</div>`（project/引擎/model 那段，原第 62 行）之后、`{/* Session/approval indicator */}` 之前插入时间戳行**

```tsx
      <div className="mt-1 text-[11px] text-muted-foreground/80" title={formatAbsoluteTime(timeLabel.iso)}>
        {timeLabel.label} {formatRelativeTime(timeLabel.iso, now)}
      </div>
```

- [ ] **Step 4: typecheck + lint**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck && npm run lint`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/tasks/TaskCard.tsx
git commit -m "feat(tasks): show lifecycle timestamp on task card

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 前端 TaskDetail 展示时间戳

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 在 `TaskDetail.tsx` 顶部加 import**

在 `import { STATUS_META, STATUS_ORDER } from './taskStatus';` 之后加：

```ts
import { formatAbsoluteTime } from './taskTimestamp';
```

- [ ] **Step 2: 在属性卡片的"执行引擎"块（原第 232-238 行 `</div>` 闭合处）之后、属性卡片外层 `</div>` 之前，插入时间块**

即把属性卡片末尾的：

```tsx
              <div>
                <div className="mb-1 text-xs text-muted-foreground">执行引擎</div>
                <div className="text-sm text-foreground">
                  {task.executor_provider}
                  {task.executor_model ? ` · ${task.executor_model}` : ''}
                </div>
              </div>
            </div>
```

改为：

```tsx
              <div>
                <div className="mb-1 text-xs text-muted-foreground">执行引擎</div>
                <div className="text-sm text-foreground">
                  {task.executor_provider}
                  {task.executor_model ? ` · ${task.executor_model}` : ''}
                </div>
              </div>
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-1 text-xs text-muted-foreground">创建时间</div>
                <div className="text-sm text-foreground">{formatAbsoluteTime(task.created_at)}</div>
              </div>
              <div className="mt-3">
                <div className="mb-1 text-xs text-muted-foreground">更新时间</div>
                <div className="text-sm text-foreground">{formatAbsoluteTime(task.updated_at)}</div>
              </div>
              {task.started_at && (
                <div className="mt-3">
                  <div className="mb-1 text-xs text-muted-foreground">开始时间</div>
                  <div className="text-sm text-foreground">{formatAbsoluteTime(task.started_at)}</div>
                </div>
              )}
              {task.completed_at && (
                <div className="mt-3">
                  <div className="mb-1 text-xs text-muted-foreground">完成时间</div>
                  <div className="text-sm text-foreground">{formatAbsoluteTime(task.completed_at)}</div>
                </div>
              )}
            </div>
```

- [ ] **Step 3: typecheck + lint**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck && npm run lint`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/tasks/TaskDetail.tsx
git commit -m "feat(tasks): show created/updated/started/completed times on task detail

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 全量验证

**Files:** 无

- [ ] **Step 1: 后端 typecheck + lint + 全部相关测试**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
npm run typecheck && npm run lint
npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks.db.integration.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/execution-linkage.test.ts
```
Expected: 全部通过。

- [ ] **Step 2: 前端 typecheck + lint + 全部 tasks 相关测试**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
npm run typecheck && npm run lint
npx tsx --tsconfig tsconfig.json --test src/components/tasks/taskStatus.test.ts
npx tsx --tsconfig tsconfig.json --test src/components/tasks/taskTimestamp.test.ts
```
Expected: 全部通过。

- [ ] **Step 3: 手动核对（可选，需启动前后端）**

启动后端与前端，在看板新建一个任务：
- backlog 卡片显示「创建于 刚刚」。
- 点开始执行，进入 in_progress 后卡片显示「开始于 …」。
- 会话完成后进入 in_review，卡片显示「完成于 …」。
- 标记完成后卡片显示「完成于 …」；详情页属性区显示创建/更新/开始/完成四个时间。
- 把 done 任务改回 in_progress，详情页完成时间消失，卡片显示「开始于 …」。

---

## Self-Review 记录

- **Spec 覆盖**：状态-字段映射表 → Task 3（后端写入）+ Task 5（前端选择）；兜底链 → Task 5 `taskTimeLabel`；迁移幂等 → Task 1；详情页四时间 → Task 7；卡片相对时间 + tooltip 绝对时间 → Task 6；测试 → Task 3/5。全覆盖。
- **类型一致**：`started_at` / `completed_at` 在后端 `TaskRow`、前端 `Task`、`statusTimestampSets`、`taskTimeLabel`、两处 `mk`/`makeRow` 中均为 `string | null`。`taskTimeLabel` 返回 `{ label, iso }`，Task 6 解构一致。
- **无占位符**：每个代码步骤均给出完整代码与确切命令。
