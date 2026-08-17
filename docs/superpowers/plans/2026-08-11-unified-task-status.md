# 统一任务状态（两层模型）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务状态整理成两层：`status`（4 列：待办/进行中/评审/完成，backlog 并入 todo）+ `sub_status`（卡片左下角标签，完整 10 值枚举）。

**Architecture:** 后端新增 `server/shared/task-status.ts` 作为 status + sub_status 单一来源；`tasks` 表 status CHECK 收为 4 值、新增 `sub_status` 列（持久化 5 值）、删 `verdict` 列（迁移时 verdict 折进 sub_status）；状态机 `writeSummary` 写 sub_status 并按判定移列（done 留评审列、only_plan/needs_review/blocked 移回进行中列）、`failed` 持久化、`decorate()` 派生有效 sub_status（含实时 running/waiting_*/pending_acceptance）。前端 `STATUS_META`（4 列）+ `SUB_STATUS_META`（10 标签）单一来源，一个 `SubStatusBadge` 统一渲染，删 `VerdictBadge`/`VERDICT_HEADER_*`/`waitReasonLabel`。分 4 阶段：P1 定义收口 → P2 DB+状态机 → P3 UI → P4 清理文档。

**Tech Stack:** Node.js + better-sqlite3 + tsx（后端）；React + Vite + TypeScript（前端）。测试用 `node:test`。

---

## 约定（先读）

- **测试命令**：
  - 后端：`TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test <file>`（`@/` 别名靠它；若环境已全局导出可省略前缀）。
  - 前端：`unset TSX_TSCONFIG_PATH && npx tsx --test <file>`；类型检查 `npm run typecheck`（前端）。
- **git**：用 `git -C <repo> ...` 形式（`cd && git` 在 sandbox 会 Stream closed）。两仓：`lovdex-backend`、`lovdex-cli`，各自开 `feat/unified-task-status` 分支（从 main 起）。
- **后端 typecheck 基线**：main 上有 28 个**既有**错误（tasks.service.ts deleteSessionHard 返回类型、execution-linkage.test.ts 缺 writeSummary stub、shared/utils.ts 等）——不是本计划引入，验收 = **不新增**错误。
- **既有 3 个失败测试**：`execution-linkage.test.ts` 的 approval_pending 测试把 `new Set(['s1'])` 传给期望 `Map` 的 API（main 上已坏）。T5 会动这个文件，顺手改成 `new Map([['s1','tool']])` 修绿。
- **跨仓协调**：P2 与 P3 **同一轮** ff-merge 到 main + push（后端先发 `sub_status`、删 `verdict`，旧前端会短暂退化，同轮合入避免长期窗口）。

---

## Phase 1 — 定义收口（后端，无行为变化）

### Task 1: 新建唯一状态定义源 `server/shared/task-status.ts`

**Files:**
- Create: `lovdex-backend/server/shared/task-status.ts`
- Test: `lovdex-backend/server/shared/tests/task-status-model.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// server/shared/tests/task-status-model.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_VERDICTS, PERSISTED_SUB_STATUSES, STATUS_ORDER, SUB_STATUSES,
  isAiVerdict, isPersistedSubStatus, isSubStatus, isTaskStatus,
} from '@/shared/task-status.js';

test('status list is the legacy 5 (P1)', () => {
  assert.deepEqual([...STATUS_ORDER], ['backlog', 'todo', 'in_progress', 'in_review', 'done']);
  assert.equal(isTaskStatus('in_review'), true);
  assert.equal(isTaskStatus('blocked'), false); // blocked 是 sub_status，不是 status
});

test('sub_status is the full 10', () => {
  assert.deepEqual([...SUB_STATUSES], [
    'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
    'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
  ]);
  assert.equal(isSubStatus('running'), true);
  assert.equal(isSubStatus('done'), true);
  assert.equal(isSubStatus('todo'), false);
});

test('persisted subset + ai verdicts', () => {
  assert.deepEqual([...PERSISTED_SUB_STATUSES], ['failed', 'done', 'only_plan', 'needs_review', 'blocked']);
  assert.equal(isPersistedSubStatus('failed'), true);
  assert.equal(isPersistedSubStatus('running'), false);
  assert.deepEqual([...AI_VERDICTS], ['done', 'only_plan', 'needs_review', 'blocked']);
  assert.equal(isAiVerdict('blocked'), true);
  assert.equal(isAiVerdict('failed'), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/shared/tests/task-status-model.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND）。

- [ ] **Step 3: 实现模块**

```ts
// server/shared/task-status.ts
/**
 * Single source of truth for the two-layer task status domain.
 *
 * Layer 1 `status` — board column (4 values): todo / in_progress / in_review /
 * done. `backlog` is folded into `todo` (P2 removes it from the enum).
 *
 * Layer 2 `sub_status` — the fine-grained badge shown at a card's bottom-left,
 * a refinement of the column it sits in. Persisted subset (DB CHECK) holds the
 * AI verdicts (done/only_plan/needs_review/blocked) plus `failed`; realtime
 * values (running/waiting_*/pending_acceptance) are derived by the service's
 * decorate() on every read.
 */

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export const SUB_STATUSES = [
  'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
  'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

/** Persisted subset — the only values allowed in the tasks.sub_status column. */
export const PERSISTED_SUB_STATUSES = ['failed', 'done', 'only_plan', 'needs_review', 'blocked'] as const;
export type PersistedSubStatus = (typeof PERSISTED_SUB_STATUSES)[number];

/** AI post-run verdicts (written by writeSummary → sub_status column). */
export const AI_VERDICTS = ['done', 'only_plan', 'needs_review', 'blocked'] as const;
export type AiVerdict = (typeof AI_VERDICTS)[number];

export function isSubStatus(value: unknown): value is SubStatus {
  return typeof value === 'string' && (SUB_STATUSES as readonly string[]).includes(value);
}

export function isPersistedSubStatus(value: unknown): value is PersistedSubStatus {
  return typeof value === 'string' && (PERSISTED_SUB_STATUSES as readonly string[]).includes(value);
}

export function isAiVerdict(value: unknown): value is AiVerdict {
  return typeof value === 'string' && (AI_VERDICTS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: 运行通过**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/shared/tests/task-status-model.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: 提交**

```bash
git -C lovdex-backend checkout main -q
git -C lovdex-backend checkout -b feat/unified-task-status
git -C lovdex-backend add server/shared/task-status.ts server/shared/tests/task-status-model.test.ts
git -C lovdex-backend commit -m "feat(tasks): add canonical two-layer status model module"
```

### Task 2: `shared/types.ts`、`tasks.db.ts`、`schema.ts` 改引用唯一源

**Files:**
- Modify: `lovdex-backend/server/shared/types.ts`（TaskStatus/TaskVerdict 定义区 ~642-655）
- Modify: `lovdex-backend/server/modules/database/repositories/tasks.db.ts`（头部 ~1-12）
- Modify: `lovdex-backend/server/modules/database/schema.ts`（status CHECK 由数组生成）
- Test: `lovdex-backend/server/modules/database/tests/tasks.db.integration.test.ts`

- [ ] **Step 1: 加回归测试**

在 `tasks.db.integration.test.ts` 顶部 import 加 `getConnection`（来自 `@/modules/database/connection.js`），追加：

```ts
test('tasks status CHECK reflects the canonical status list', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string }).sql;
    for (const s of TASK_STATUSES) {
      assert.ok(sql.includes(`'${s}'`), `tasks CHECK missing ${s}`);
    }
  });
});
```

（需 import `TASK_STATUSES` from `@/shared/task-status.js`。）此测试在 P1 应**通过**（回归护栏，P2 自动覆盖新值）。

- [ ] **Step 2: types.ts 改为 re-export**

把 `shared/types.ts` 里的 `TaskStatus` union、`TaskVerdict` type、`TASK_VERDICTS`、`isTaskVerdict` 替换为：

```ts
export type { TaskStatus } from '@/shared/task-status.js';
```

并保留文件内 `TaskRow` 等对 `TaskStatus` 的引用（若需本地作用域，加 `import type { TaskStatus } from '@/shared/task-status.js';`）。`TaskVerdict`/`TASK_VERDICTS`/`isTaskVerdict` 在 P2 删列后无引用，本任务先删（P2 迁移一并清理引用）。

- [ ] **Step 3: tasks.db.ts 改为引用 + re-export**

头部改为：

```ts
import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { TASK_STATUSES, isTaskStatus, type TaskStatus } from '@/shared/task-status.js';
import type { TaskEngine, TaskRow } from '@/shared/types.js';

export { TASK_STATUSES, isTaskStatus } from '@/shared/task-status.js';
export const TASK_ENGINES: readonly TaskEngine[] = ['claude', 'codex'];
```

（删本地 `TASK_STATUSES`/`isTaskStatus` 定义。`isTaskVerdict` 本文件里 `writeSummary` 用——先保留对 `shared/types.js` 的 import；P2 改 writeSummary 时一并迁走。）

- [ ] **Step 4: schema.ts 的 status CHECK 由数组生成**

顶部加 `import { TASK_STATUSES } from '@/shared/task-status.js';`，定义 `const STATUS_CHECK = \`CHECK (status IN (${TASK_STATUSES.map((s) => `'${s}'`).join(',')}))\`;`，把 `TASKS_TABLE_SCHEMA_SQL` 里硬编码的 status CHECK 行替换为 `${STATUS_CHECK}`。verdict 列不动。

- [ ] **Step 5: 运行 + 类型检查**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts server/shared/tests/task-status-model.test.ts` → PASS。
Run: `npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -E 'types\.ts|tasks\.db\.ts|schema\.ts'` → 零错误（基线 28 个既有错误忽略）。注意：删 `TaskVerdict` 后，`operator.tools.ts` 等仍 import 它会在 grep 之外报错——把引用点一并改（`operator.tools.ts` 的 `isTaskVerdict`/`TaskVerdict` → `isAiVerdict`/`AiVerdict`，import from `@/shared/task-status.js`）。目标：类型检查**不新增**错误。

- [ ] **Step 6: 提交**

```bash
git -C lovdex-backend add server/shared/types.ts server/modules/database/repositories/tasks.db.ts server/modules/database/schema.ts server/modules/database/tests/tasks.db.integration.test.ts server/modules/operators/operator.tools.ts
git -C lovdex-backend commit -m "refactor(tasks): route status through canonical two-layer model"
```

---

## Phase 2 — DB + 状态机（后端，行为变化）

### Task 3: status 收为 4 值（去掉 backlog）

**Files:**
- Modify: `lovdex-backend/server/shared/task-status.ts`
- Test: `lovdex-backend/server/shared/tests/task-status-model.test.ts`

- [ ] **Step 1: 改测试断言 4 值**

第一个测试改为：

```ts
test('status list is the unified 4', () => {
  assert.deepEqual([...STATUS_ORDER], ['todo', 'in_progress', 'in_review', 'done']);
  assert.equal(isTaskStatus('todo'), true);
  assert.equal(isTaskStatus('backlog'), false);
  assert.equal(isTaskStatus('blocked'), false);
});
```

- [ ] **Step 2: 运行确认失败** → 改数组

把 `TASK_STATUSES` 改为 `['todo', 'in_progress', 'in_review', 'done'] as const`。更新模块 doc comment（backlog 已并入 todo）。

- [ ] **Step 3: 运行通过 + 提交**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/shared/tests/task-status-model.test.ts` → PASS。

```bash
git -C lovdex-backend add server/shared/task-status.ts server/shared/tests/task-status-model.test.ts
git -C lovdex-backend commit -m "feat(tasks): collapse backlog into todo, status is 4 columns"
```

### Task 4: 迁移重建 tasks 表（backlog→todo、verdict→sub_status、删 verdict 列）

**Files:**
- Modify: `lovdex-backend/server/modules/database/schema.ts`（新 schema：4 值 status CHECK、加 sub_status 列、删 verdict 列）
- Modify: `lovdex-backend/server/modules/database/migrations.ts`（`migrateTasksTable` 重建）
- Test: `lovdex-backend/server/modules/database/tests/tasks-status-migration.test.ts`（新建）

- [ ] **Step 1: 改 schema.ts 的 `TASKS_TABLE_SCHEMA_SQL`**

status 行改为 `TEXT NOT NULL DEFAULT 'todo' ${STATUS_CHECK}`（CHECK 已由 4 值数组生成）；删 `verdict` 列；加 `sub_status` 列；保留 `verdict_reason`/`verdict_at`/`ai_summary`：

```sql
    status            TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','in_review','done')),
    ...
    ai_summary       TEXT,
    sub_status       TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked')),
    verdict_reason   TEXT,
    verdict_at       DATETIME
```

- [ ] **Step 2: 写失败迁移测试**

```ts
// server/modules/database/tests/tasks-status-migration.test.ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

const LEGACY_TASKS_DDL = `
CREATE TABLE tasks (
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
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary       TEXT,
    verdict          TEXT CHECK (verdict IS NULL OR verdict IN ('done','only_plan','needs_review','blocked')),
    verdict_reason   TEXT,
    verdict_at       DATETIME
);
`;

test('migrateTasksTable rebuilds: backlog→todo, verdict→sub_status, drops verdict column', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      custom_project_name TEXT DEFAULT NULL,
      isStarred BOOLEAN DEFAULT 0,
      isArchived BOOLEAN DEFAULT 0
    );
  `);
  legacy.exec(LEGACY_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  const ins = legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, status, verdict, verdict_reason) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('t1', '/tmp/example-repo', 'backlogged', 'backlog', null, null);
  ins.run('t2', '/tmp/example-repo', 'judged-done', 'in_review', 'done', 'all good');
  ins.run('t3', '/tmp/example-repo', 'judged-blocked', 'in_review', 'blocked', 'broke');
  ins.run('t4', '/tmp/example-repo', 'plain-review', 'in_review', null, null);
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const rows = db.prepare('SELECT task_id, status, sub_status, verdict_reason FROM tasks ORDER BY task_id').all() as {
      task_id: string; status: string; sub_status: string | null; verdict_reason: string | null;
    }[];
    const byId = Object.fromEntries(rows.map((r) => [r.task_id, r]));

    assert.equal(byId['t1'].status, 'todo');            // backlog → todo
    assert.equal(byId['t1'].sub_status, null);
    assert.equal(byId['t2'].status, 'in_review');       // done 判定留评审列
    assert.equal(byId['t2'].sub_status, 'done');
    assert.equal(byId['t2'].verdict_reason, 'all good');
    assert.equal(byId['t3'].status, 'in_progress');     // 非 done 判定移回进行中
    assert.equal(byId['t3'].sub_status, 'blocked');
    assert.equal(byId['t3'].verdict_reason, 'broke');
    assert.equal(byId['t4'].status, 'in_review');       // 无判定留评审列
    assert.equal(byId['t4'].sub_status, null);

    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'sub_status'));
    assert.ok(!cols.some((c) => c.name === 'verdict')); // verdict 列已删
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: 运行确认失败**（迁移未加 → t1.status 仍 backlog、无 sub_status 列）

- [ ] **Step 4: 实现迁移**

`migrations.ts` `migrateTasksTable`：保留全部 `addColumnToTableIfNotExists`（started_at/completed_at/ai_summary/**verdict**/verdict_reason/verdict_at）。`verdict` 那行对旧库幂等（存在则跳过、缺失则补），确保重建前的 `INSERT...SELECT ... verdict ... FROM tasks_legacy` 不会因列缺失而失败。然后检测旧 schema（`!tasksTableSql.includes('sub_status')`）时重建：

```ts
const tasksTableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
if (!tasksTableSql.includes('sub_status')) {
  console.log('Running migration: rebuild tasks table for two-layer status');
  try {
    db.exec('BEGIN');
    // tasks 是叶子表（无表 REFERENCES tasks），无需 PRAGMA foreign_keys 开关。
    db.exec('ALTER TABLE tasks RENAME TO tasks_legacy;');
    db.exec(TASKS_TABLE_SCHEMA_SQL);
    db.exec(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at)
      SELECT task_id, project_path, title, description,
             CASE
               WHEN status = 'backlog' THEN 'todo'
               WHEN status = 'in_review' AND verdict IN ('only_plan','needs_review','blocked') THEN 'in_progress'
               ELSE status
             END,
             executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary,
             verdict,
             verdict_reason, verdict_at
      FROM tasks_legacy;
    `);
    db.exec('DROP TABLE tasks_legacy;');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

（`TASKS_TABLE_SCHEMA_SQL` 已含 4 值 status CHECK + sub_status 列 + 无 verdict 列，所以重建即完成全部映射。）

- [ ] **Step 5: 运行迁移测试 + 回归 + 幂等**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/database/tests/tasks-status-migration.test.ts` → PASS。
回归：`... --test server/modules/database/tests/tasks.db.integration.test.ts server/modules/database/tests/tasks-status-migration.test.ts server/shared/tests/task-status-model.test.ts` → PASS。
幂等：重复跑迁移测试（初始化两次）不重建、不重复行。

- [ ] **Step 6: 提交**

```bash
git -C lovdex-backend add server/modules/database/schema.ts server/modules/database/migrations.ts server/modules/database/tests/tasks-status-migration.test.ts
git -C lovdex-backend commit -m "feat(tasks): rebuild tasks table with sub_status, drop verdict column"
```

### Task 5: 状态机——sub_status 写入与派生、failed 持久化、移列规则

**Files:**
- Modify: `lovdex-backend/server/modules/database/repositories/tasks.db.ts`（`writeSummary` 写 sub_status、加 `updateTaskSubStatus`、`createTask` 默认 todo、`statusTimestampSets`）
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`（decorate、writeSummary、onSessionStatus、删 applyVerdict、reconcileFailedTasks、createTask 默认 todo、startExecution、删 getOperatorConfig/getRunningSessions opt）
- Test: `lovdex-backend/server/modules/tasks/tests/tasks.service.status.test.ts`（新建）
- Modify: `lovdex-backend/server/modules/tasks/tests/execution-linkage.test.ts`、`operator-summary.test.ts`（适配 + 修 3 个 Set→Map）

- [ ] **Step 1: 写失败测试**

```ts
// server/modules/tasks/tests/tasks.service.status.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { createTasksService, type TaskBroadcast } from '../services/tasks.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-status-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function makeService(events: unknown[] = []) {
  const broadcast: TaskBroadcast = (e) => { events.push(e); };
  return createTasksService(tasksDb, { broadcast });
}

function seedTask() {
  projectsDb.createProjectPath('/tmp/example-repo');
  const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude' });
  tasksDb.linkSession(created.task_id, 's1');
  return created.task_id;
}

test('createTask defaults to todo', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude' });
    assert.equal(created.status, 'todo');
  });
});

test('failed session persists sub_status=failed, status stays in_progress', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed');
    const row = svc.getTask(id);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.sub_status, 'failed');
    assert.equal(tasksDb.getTask(id)?.sub_status, 'failed'); // 持久化
  });
});

test('running clears a persisted failed sub_status', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed');
    svc.onSessionStatus('s1', 'running'); // retry
    assert.equal(svc.getTask(id)?.sub_status, 'running'); // 派生为 running，持久值已清
    assert.equal(tasksDb.getTask(id)?.sub_status, null);
  });
});

test('writeSummary folds verdict into sub_status and moves non-done back to in_progress', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed'); // → in_review
    svc.writeSummary(id, { summary: 'blocked', verdict: 'blocked', reason: 'broke' });
    let row = svc.getTask(id);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.sub_status, 'blocked');
    assert.equal(row?.verdict_reason, 'broke');
    assert.equal(row?.ai_summary, 'blocked');

    // done 判定：留评审列，sub_status=done
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.writeSummary(id, { summary: 'done', verdict: 'done', reason: 'ok' });
    row = svc.getTask(id);
    assert.equal(row?.status, 'in_review');
    assert.equal(row?.sub_status, 'done');
  });
});

test('writeSummary does not move a task the user already dragged out of in_review', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.applyStatusChange(id, 'todo', 'user');
    svc.writeSummary(id, { summary: 'late', verdict: 'blocked' });
    assert.equal(svc.getTask(id)?.status, 'todo');
    assert.equal(svc.getTask(id)?.sub_status, 'blocked'); // 审计记录但不动 status
  });
});

test('reconcileFailedTasks marks orphaned in_progress tasks failed', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    const changed = svc.reconcileFailedTasks(() => new Set());
    assert.equal(changed, 1);
    assert.equal(tasksDb.getTask(id)?.sub_status, 'failed');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/tasks.service.status.test.ts`
Expected: FAIL（writeSummary 仍写 verdict 列、无 sub_status 派生、failed 不是持久化、reconcileFailedTasks 不存在）。

- [ ] **Step 3: 改 `tasks.db.ts`**

- `createTask` 默认 `status = input.status ?? 'todo'`。
- 新增：

```ts
updateTaskSubStatus(taskId: string, subStatus: PersistedSubStatus | null): void {
  const db = getConnection();
  db.prepare('UPDATE tasks SET sub_status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(subStatus, taskId);
},
```

- `writeSummary` 改为写 sub_status：

```ts
writeSummary(taskId: string, input: { summary: string; verdict: AiVerdict; reason?: string | null }): TaskRow | null {
  if (!isAiVerdict(input.verdict)) throw new Error(`invalid verdict: ${String(input.verdict)}`);
  const db = getConnection();
  db.prepare(`
    UPDATE tasks
    SET ai_summary = ?, sub_status = ?, verdict_reason = ?, verdict_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ?
  `).run(input.summary, input.verdict, input.reason ?? null, taskId);
  return tasksDb.getTask(taskId);
},
```

- `TaskDbLike` 的 `writeSummary` 签名同步；import 改为 `isAiVerdict, type AiVerdict, type PersistedSubStatus` from task-status。

- [ ] **Step 4: 改 `tasks.service.ts`**

a) 移除 `getOperatorConfig`/`getRunningSessions` opt 及其 doc/import（applyVerdict 删除后无引用）。

b) `decorate` 派生有效 sub_status：

```ts
function decorate(row: TaskRow): TaskRow {
  const pendingTool = row.session_id ? pendingApprovalSessions().get(row.session_id as string) ?? null : null;
  const approvalPending = Boolean(row.session_id) && pendingTool !== null;
  let subStatus: SubStatus | null = row.sub_status;
  if (row.status === 'in_progress') {
    if (approvalPending) {
      subStatus = pendingTool === 'AskUserQuestion' ? 'waiting_answer'
        : (pendingTool === 'ExitPlanMode' || pendingTool === 'exit_plan_mode') ? 'waiting_plan'
        : 'waiting_approval';
    } else if (row.sub_status && row.sub_status !== 'done') {
      // failed/only_plan/needs_review/blocked 是进行中列的有效标签；done 是
      // 评审列标签，若用户把 AI done 任务拖回进行中，视作 running。
      subStatus = row.sub_status;
    } else {
      subStatus = 'running';
    }
  } else if (row.status === 'in_review') {
    subStatus = row.sub_status === 'done' ? 'done' : 'pending_acceptance';
  }
  return { ...row, approval_pending: approvalPending, pending_tool: pendingTool, sub_status: subStatus };
}
```

c) `onSessionStatus`：
- `running`：status → in_progress（原逻辑）；并 `resolveDb.updateTaskSubStatus(row.task_id, null)`（清 failed）。
- `failed`：`if (row.status === 'in_progress') resolveDb.updateTaskSubStatus(row.task_id, 'failed'); emit(...)`。
- `completed`：in_progress → in_review；`updateTaskSubStatus(row.task_id, null)`（sub_status 复位待 AI 判定）；`opts.onTaskCompleted`。
- `aborted`：in_progress → todo；`updateTaskSubStatus(row.task_id, null)`。

d) `writeSummary`：

```ts
writeSummary(taskId: string, input: { summary: string; verdict: AiVerdict; reason?: string | null }): TaskRow | null {
  const row = resolveDb.writeSummary(taskId, input);
  if (row) emit({ kind: 'task_upserted', task: row, actor: 'engine' });
  if (row) {
    const current = resolveDb.getTask(taskId);
    if (current && current.status === 'in_review' && input.verdict !== 'done') {
      // 非 done 判定移回进行中列；done 判定留评审列（人 gate）。
      applyStatusChange(taskId, 'in_progress', 'engine');
    }
    return decorate(resolveDb.getTask(taskId) ?? row);
  }
  return row ? decorate(row) : null;
}
```

e) 删整个 `applyVerdict`。

f) 加 `reconcileFailedTasks`：

```ts
reconcileFailedTasks(getRunningSessionIds: () => Set<string>): number {
  const running = getRunningSessionIds();
  let changed = 0;
  for (const row of resolveDb.listTasks({})) {
    if (row.status === 'in_progress' && row.session_id && !running.has(row.session_id)) {
      resolveDb.updateTaskSubStatus(row.task_id, 'failed');
      emit({ kind: 'task_upserted', task: row, actor: 'engine' });
      changed += 1;
    }
  }
  return changed;
},
```

g) `startExecution`：删掉 backlog→todo 推进块（无 backlog 了）；`createTask` 默认 `'todo'`。

- [ ] **Step 5: 运行通过 + 修既有测试**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/tasks.service.status.test.ts` → PASS。

修既有测试：
- `execution-linkage.test.ts`：`new Set(['s1'])` → `new Map([['s1', 'AskUserQuestion']])`（3 处，修绿既有失败）；删/改依赖实时 `failed` 装饰的断言（decorate 不再有 `failed` 字段，改用 `sub_status`）。
- `operator-summary.test.ts`：`writeSummary` 断言的 auto-move → sub_status/移列语义（done 留 in_review、only_plan/blocked 移 in_progress）；删 `DEFAULT_OPERATOR_CONFIG` 引用。

- [ ] **Step 6: 回归 + 类型检查 + 提交**

Run: `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/tasks.service.status.test.ts server/modules/tasks/tests/execution-linkage.test.ts server/modules/tasks/tests/operator-summary.test.ts server/modules/database/tests/tasks.db.integration.test.ts server/modules/database/tests/tasks-status-migration.test.ts server/shared/tests/task-status-model.test.ts` → 全 PASS（不含基线 28 个 typecheck 错误之外的运行时错误）。
Typecheck：`npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -E 'tasks\.service|tasks\.db'` → 零新增错误。

```bash
git -C lovdex-backend add server/modules/database/repositories/tasks.db.ts server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/
git -C lovdex-backend commit -m "feat(tasks): sub_status state machine, persisted failed, verdict-driven column moves"
```

### Task 6: operator tools/config + index.js 接线

**Files:**
- Modify: `lovdex-backend/server/modules/operators/operator.tools.ts`（create_task 默认 todo、write_task_summary）
- Modify: `lovdex-backend/server/modules/operators/operator.config.ts`（删 auto_move_* 三字段）
- Modify: `lovdex-backend/server/index.js`（删 getRunningSessions opt、加 reconcile 调用）

- [ ] **Step 1: operator.tools.ts**

`create_task` description 与默认：`'Create a task (defaults to todo). Uses contextProjectPath if projectPath omitted.'` + `status: i.status ?? 'todo'`。`write_task_summary` 校验 `isAiVerdict(i.verdict)`（import 已从 task-status，Task 2 处理过）。

- [ ] **Step 2: operator.config.ts 删 auto_move_***

从 `OperatorConfig` type 与 `DEFAULT_OPERATOR_CONFIG` 中删 `auto_move_enabled`/`auto_move_done`/`auto_move_only_plan_to_todo`。

- [ ] **Step 3: index.js**

删 185-189 行的 `getRunningSessions` opt 块（含注释）；在 `setTaskLinkage(tasksService);` 后加：

```js
// Mark orphaned in_progress tasks (linked session has no live run after a
// backend restart) as failed so the board reads truth on boot.
tasksService.reconcileFailedTasks(() => new Set(chatRunRegistry.listRunningRuns().map((run) => run.sessionId)));
```

- [ ] **Step 4: 验证 + 提交**

Run: `node --check server/index.js`；`TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/operators/tests/operator-config.test.ts server/modules/tasks/tests/tasks.service.status.test.ts` → PASS；`grep -rn "getRunningSessions\|auto_move" server/` → 无残留。

```bash
git -C lovdex-backend add server/index.js server/modules/operators/operator.tools.ts server/modules/operators/operator.config.ts
git -C lovdex-backend commit -m "feat(tasks): startup failed-reconcile, create_task default todo, drop auto_move config"
```

**P2 验收（人工）**：后端重启后孤儿 in_progress → sub_status=failed；AI 判定 done 留评审列、blocked 移回进行中列；`?status=` 过滤 4 值。**暂不 merge**，等 P3。

---

## Phase 3 — UI 统一（前端，行为变化）

> **协调**：P3 完成后与 P2 同轮 ff-merge 两仓到 main + push。

### Task 7: 前端类型 + STATUS_META/SUB_STATUS_META 常量

**Files:**
- Modify: `lovdex-cli/src/types/app.ts`
- Modify: `lovdex-cli/src/components/tasks/taskStatus.ts`
- Modify: `lovdex-cli/src/components/tasks/taskTimestamp.ts`
- Test: `lovdex-cli/src/components/tasks/taskStatus.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
// src/components/tasks/taskStatus.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';
import { STATUS_META, STATUS_ORDER, SUB_STATUS_META, SUB_STATUS_ORDER, groupByStatus } from './taskStatus';

function mkTask(task_id: string, status: Task['status']): Task {
  return {
    task_id, project_path: '/p', title: 't', description: null, status,
    executor_provider: 'claude', executor_model: null, position: 0, session_id: null,
    started_at: null, completed_at: null, ai_summary: null,
    sub_status: null, verdict_reason: null, verdict_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
}

test('STATUS_ORDER is the unified 4', () => {
  assert.deepEqual(STATUS_ORDER, ['todo', 'in_progress', 'in_review', 'done']);
});

test('STATUS_META covers every status', () => {
  for (const s of STATUS_ORDER) assert.ok(STATUS_META[s], `missing meta for ${s}`);
});

test('SUB_STATUS_ORDER is the full 10', () => {
  assert.equal(SUB_STATUS_ORDER.length, 10);
  assert.ok(SUB_STATUS_ORDER.includes('blocked'));
  assert.ok(SUB_STATUS_ORDER.includes('pending_acceptance'));
});

test('SUB_STATUS_META covers every sub_status', () => {
  for (const s of SUB_STATUS_ORDER) assert.ok(SUB_STATUS_META[s], `missing meta for ${s}`);
});

test('groupByStatus buckets into 4 columns', () => {
  const tasks = [mkTask('a', 'todo'), mkTask('b', 'in_progress'), mkTask('c', 'in_review'), mkTask('d', 'done')];
  const g = groupByStatus(tasks);
  assert.equal(g['todo'].length, 1);
  assert.equal(g['done'].length, 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskStatus.test.ts`
Expected: FAIL（SUB_STATUS_* 不存在、STATUS_ORDER 是 5）。

- [ ] **Step 3: 改 `types/app.ts`**

- `TaskStatus` → `'todo' | 'in_progress' | 'in_review' | 'done'`。
- 加 `export type SubStatus = 'running' | 'failed' | 'waiting_answer' | 'waiting_plan' | 'waiting_approval' | 'pending_acceptance' | 'done' | 'only_plan' | 'needs_review' | 'blocked';`
- 删 `TaskVerdict` 与 `Task.verdict`；`Task` 加 `sub_status: SubStatus | null`；保留 `verdict_reason`/`verdict_at`/`ai_summary`；删 `failed?: boolean`。

- [ ] **Step 4: 重写 `taskStatus.ts`**

```ts
import type { SubStatus, Task, TaskStatus } from '../../types/app';

export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: '待办', color: '#fbbf24' },
  in_progress: { label: '进行中', color: '#60a5fa' },
  in_review: { label: '评审', color: '#a78bfa' },
  done: { label: '完成', color: '#34d399' },
};

export const SUB_STATUS_ORDER: SubStatus[] = [
  'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
  'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
];

export const SUB_STATUS_META: Record<SubStatus, { label: string; color: string }> = {
  running: { label: '会话运行中', color: '#60a5fa' },
  failed: { label: '执行失败', color: '#ef4444' },
  waiting_answer: { label: '等你回答', color: '#f59e0b' },
  waiting_plan: { label: '等你确认计划', color: '#6366f1' },
  waiting_approval: { label: '等你批准', color: '#f59e0b' },
  pending_acceptance: { label: '待你验收', color: '#a855f7' },
  done: { label: '已完成', color: '#34d399' },
  only_plan: { label: '计划待执行', color: '#3b82f6' },
  needs_review: { label: '待你决策', color: '#eab308' },
  blocked: { label: '需协助', color: '#ef4444' },
};

function statusSortTime(task: Task): number {
  const ms = Date.parse(taskTimeLabel(task).iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const groups = Object.fromEntries(STATUS_ORDER.map((s) => [s, [] as Task[]])) as Record<TaskStatus, Task[]>;
  for (const t of tasks) {
    if (groups[t.status]) groups[t.status].push(t);
  }
  for (const status of STATUS_ORDER) {
    groups[status].sort((a, b) => statusSortTime(b) - statusSortTime(a));
  }
  return groups;
}

export function taskSessionState(t: Task): 'none' | 'running' | 'review' | 'done' {
  if (!t.session_id) return 'none';
  switch (t.status) {
    case 'in_progress': return 'running';
    case 'in_review': return 'review';
    case 'done': return 'done';
    default: return 'none';
  }
}
```

（保留 `import { taskTimeLabel } from './taskTimestamp';`。）

- [ ] **Step 5: 改 `taskTimestamp.ts`**

`taskTimeLabel` 分支：`in_progress`→开始于、`in_review`→评审于、`done`→完成于、默认→创建于。（sub_status 不参与时间标签；AI 判定时刻走 `verdict_at` 展示。）

- [ ] **Step 6: 测试通过 + 类型检查**

Run: `unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskStatus.test.ts` → PASS。
Run: `npm run typecheck` → 错误应只在 TaskCard/TaskDetail/TaskBoard 引用已删字段（`task.failed`/`task.verdict`/`VerdictBadge`/`VERDICT_HEADER`），Task 9-11 修。

- [ ] **Step 7: 提交**

```bash
git -C lovdex-cli checkout main -q
git -C lovdex-cli checkout -b feat/unified-task-status
git -C lovdex-cli add src/types/app.ts src/components/tasks/taskStatus.ts src/components/tasks/taskTimestamp.ts src/components/tasks/taskStatus.test.ts
git -C lovdex-cli commit -m "feat(tasks): two-layer status meta (4 columns + 10 sub-status labels)"
```

### Task 8: 新建 `SubStatusBadge` 组件

**Files:**
- Create: `lovdex-cli/src/components/tasks/SubStatusBadge.tsx`

- [ ] **Step 1: 实现**

```tsx
// src/components/tasks/SubStatusBadge.tsx
import type { SubStatus } from '../../types/app';
import { SUB_STATUS_META } from './taskStatus';

/** Renders a sub-status tag (card bottom-left badge) from SUB_STATUS_META. */
export function SubStatusBadge({ subStatus }: { subStatus: SubStatus | null | undefined }) {
  if (!subStatus) return null;
  const meta = SUB_STATUS_META[subStatus];
  if (!meta) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: meta.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git -C lovdex-cli add src/components/tasks/SubStatusBadge.tsx
git -C lovdex-cli commit -m "feat(tasks): add SubStatusBadge component"
```

### Task 9: TaskCard 统一渲染

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskCard.tsx`

- [ ] **Step 1: 改渲染**

- 删 `import { VerdictBadge }`、`waitReasonLabel` 函数、`operatorEnabled` prop。
- 左下角徽标区（原 107-135）整体替换为：

```tsx
{task.sub_status && (
  <div className="mt-2">
    <SubStatusBadge subStatus={task.sub_status} />
  </div>
)}
```

（`running`/`waiting_*`/`failed`/`only_plan`/`needs_review`/`blocked`/`pending_acceptance`/`done` 全由后端 decorate 派生成单一 `sub_status`，卡片不再自行分支。）

- 动作区：`task.failed` → `task.sub_status === 'failed'`；`waitingApproval` prop 保留与否由你判断——`sub_status` 已含 waiting_*，`approvalTaskIds` 集合可删（看板不再需要单独传）。删 `waitingApproval`/`operatorEnabled` 相关 prop。

- [ ] **Step 2: 类型检查 + 提交**

Run: `npm run typecheck` → TaskCard 相关错误消失。

```bash
git -C lovdex-cli add src/components/tasks/TaskCard.tsx
git -C lovdex-cli commit -m "feat(tasks): card renders sub_status tag, drop VerdictBadge/waitReason"
```

### Task 10: TaskDetail 统一渲染

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 删 `VERDICT_HEADER_LABEL/COLOR`、`liveHeaderBadge` 简化**

```ts
function liveHeaderBadge(task: Task): { label: string; color: string; pulse?: boolean } {
  if (task.sub_status) {
    const meta = SUB_STATUS_META[task.sub_status];
    return { label: meta.label, color: meta.color, pulse: task.sub_status === 'running' || task.sub_status.startsWith('waiting_') };
  }
  return { label: STATUS_META[task.status].label, color: STATUS_META[task.status].color };
}
```

- [ ] **Step 2: 状态 `<select>`** 列 `STATUS_ORDER`（4 值，自动）。

- [ ] **Step 3: "完成度"卡**：删 `VerdictBadge`；条件改 `(task.ai_summary || task.verdict_reason || task.verdict_at)`；徽标用 `<SubStatusBadge subStatus={task.sub_status} />`（仅当 sub_status 是 4 个 AI 判定值之一时显示，避免 done 列显示标签——判断 `task.status === 'in_review'` 时显示）。

- [ ] **Step 4: 执行区**：`task.failed` → `task.sub_status === 'failed'`；删 `operatorEnabled` state/effect 与等待分类分支（sub_status 已统一）。

- [ ] **Step 5: 类型检查 + 提交**

```bash
git -C lovdex-cli add src/components/tasks/TaskDetail.tsx
git -C lovdex-cli commit -m "feat(tasks): detail page renders unified sub_status badge"
```

### Task 11: TaskBoard 4 列 + OperatorSettingsPage 删 auto_move

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskBoard.tsx`
- Modify: `lovdex-cli/src/components/operators/OperatorSettingsPage.tsx`

- [ ] **Step 1: TaskBoard**

- 列渲染：`STATUS_ORDER.map`（4 列，`STATUS_META[status]`）。`approvalTaskIds`/`waitingApproval`/`operatorEnabled` 删（sub_status 已含）。
- `runTask`：`task.failed` → `task.sub_status === 'failed'`。
- `TaskCard` 调用去掉 `waitingApproval`/`operatorEnabled` props。

- [ ] **Step 2: OperatorSettingsPage**

删「自动判定与移列」区里 `auto_move_enabled`/`auto_move_only_plan_to_todo`/`auto_move_done` 三个 `<Toggle>`；`OperatorConfig` type 同步删三字段（EMPTY 同步）；区块标题改「自动判定」，描述改为「session 跑完后自动读 transcript 出 summary + verdict，写入 sub_status 标签。」

- [ ] **Step 3: 类型检查 + 构建 + 提交**

Run: `npm run typecheck` → 通过；`npm run build` → 通过。

```bash
git -C lovdex-cli add src/components/tasks/TaskBoard.tsx src/components/operators/OperatorSettingsPage.tsx
git -C lovdex-cli commit -m "feat(tasks): 4-column board, persistent failed in retry, drop auto_move settings"
```

**P3 验收（人工）**：看板 4 列；评审列里 AI done 卡片带「已完成」绿标、非 done 判定卡片在「进行中」列带对应标；失败卡片持久「执行失败」；详情页下拉 4 值、头部徽标与下拉一致。

**P2+P3 合并**：

```bash
git -C lovdex-backend checkout main && git -C lovdex-backend merge --ff-only feat/unified-task-status && git -C lovdex-backend push
git -C lovdex-cli checkout main && git -C lovdex-cli merge --ff-only feat/unified-task-status && git -C lovdex-cli push
```

---

## Phase 4 — 清理与文档

### Task 12: 清理残留 + 更新设计文档

**Files:**
- Delete: `lovdex-cli/src/components/tasks/VerdictBadge.tsx`（若 P3 未删）
- Modify: `docs/task-board-design.md`、`docs/task-state-flow.html`（`docs/` 在 git 外，直接改）

- [ ] **Step 1: 删 `VerdictBadge.tsx` + 全局搜残留**

Run: `grep -rn "VerdictBadge\|VERDICT_HEADER\|TaskVerdict\|\bverdict\b" src/` → 确认无渲染引用后删文件。类型检查 + 构建通过。

- [ ] **Step 2: 更新设计文档**

把 `docs/task-board-design.md` 与 `docs/task-state-flow.html` 更新为两层模型：4 列（待办/进行中/评审/完成）+ sub_status 10 标签 + AI 判定行为（done 留评审列、其余移回进行中）。

- [ ] **Step 3: 提交前端清理**

```bash
git -C lovdex-cli add -A
git -C lovdex-cli commit -m "chore(tasks): remove VerdictBadge, refresh docs to two-layer model"
```

**P4 合并**：ff-merge 前端到 main + push。

---

## 自审记录

- **Spec 覆盖**：§2.1 4 值 status → Task 3；§2.2 sub_status 10 值 + 持久化 5 → Task 1、7；§2.3 decorate 派生 → Task 5、9；§2.4 门控（done 留评审列、非 done 移回进行中、项目变更仅 todo）→ Task 5、3；§3 schema/迁移 → Task 4；§4 后端机制 → Task 5、6；§5 前端 → Task 7-11；§6 文件清单 → 覆盖；§7 测试要点 → 各 Task；§9 风险（备份、同轮合并）→ 迁移测试 + 合并步骤。
- **占位符扫描**：无 TBD/TODO；代码步骤含完整实现。
- **类型一致性**：`TaskStatus`（4）先后端（T3）后前端（T7）；`SubStatus`/`AiVerdict`/`PersistedSubStatus` 定义一致；`SubStatusBadge` 在 T8 定义、T9/T10 使用；`reconcileFailedTasks` T5 定义、T6 接线；`updateTaskSubStatus` T5 定义使用一致。
- **与上一版 flat-9 的差异**：status 收为 4 值（删 backlog）而非扩到 9；verdict 折进新增 sub_status 列而非 status；AI 判定 done 留评审列、only_plan/needs_review/blocked 移回进行中列（上一版是四值都进 in_review 等待）。
