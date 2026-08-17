# Lovdex 定时任务 — 后端实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 lovdex-backend 新增定时任务能力：`scheduled_tasks` 模板表 + 进程内轮询调度器 + CRUD API + WS 事件 + Lovdex助手 5 个定时工具。

**Architecture:** 独立 `scheduled_tasks` 模板表；`scheduler.service.ts` 每 15s tick 扫到期项 → `tasksService.createTask` 建任务（带 `source_schedule_id` 回链）→ `auto_run=1` 时 `startExecution` + `startHeadlessTaskRun` 无人值守跑；启动时 `reconcileMissedRuns` 把停机错过的触发聚合成一条 `label='reminder'` 提醒任务（不补跑）。cron 解析用 croner。调度器 service 是完整门面（CRUD + tick + runNow + 校验 + broadcast），路由直接调它。调度/执行实例分离，verdict 生命周期完全复用现有 tasks 机制。

**Tech Stack:** Node + Express + better-sqlite3 + node:test + croner。

**Spec:** `docs/superpowers/specs/2026-08-13-scheduled-tasks-design.md`

**仓库**：`/mnt/b/workdir/github/lovdex/lovdex-backend`（独立 git 仓库）。测试命令：`npx tsx --tsconfig server/tsconfig.json --test server/<path>/tests/<file>.test.ts`（先 `unset TSX_TSCONFIG_PATH`，见记忆 lovdex-tsx-env-gotcha）。API 路由测试用**进程内 Express + 内置 fetch**（`operator-routes.test.ts` 的先例），不引 supertest。

---

### Task 1: 共享类型 + `reminder` label

**Files:**
- Modify: `server/shared/task-status.ts`
- Modify: `server/shared/types.ts`
- Test: `server/shared/tests/task-status.test.ts`（不存在则新建）

- [ ] **Step 1: `server/shared/task-status.ts` 的 `TASK_LABELS` 加 `'reminder'`**

```ts
export const TASK_LABELS = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder'] as const;
```

`isTaskLabel` 由 `TASK_LABELS` 驱动自动生效；`schema.ts` 的 `LABEL_CHECK` 也由它生成，但**已存在的 DB 的 CHECK 是旧值**——由 Task 3 迁移重建。

- [ ] **Step 2: `server/shared/types.ts` 追加定时任务类型**；`TaskRow` 同时加 `source_schedule_id`

```ts
export type ScheduledTaskScheduleType = 'once' | 'interval' | 'cron';

export type ScheduledTaskRow = {
  schedule_id: string;
  title: string;
  description: string | null;
  project_path: string | null;
  executor_provider: string;
  executor_model: string | null;
  priority: string;
  label: string;
  is_operator: number; // 0 | 1 — project_path 为 NULL 时 1
  auto_run: number;    // 0 | 1
  schedule_type: ScheduledTaskScheduleType;
  cron_expr: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  last_task_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};
```

`TaskRow` 加一行（放 `session_id` 附近）：`source_schedule_id: string | null;`

- [ ] **Step 3: 写测试** `server/shared/tests/task-status.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskLabel, isTaskStatus } from '@/shared/task-status.js';

test('reminder is a valid task label', () => {
  assert.equal(isTaskLabel('reminder'), true);
});

test('status guards unchanged', () => {
  assert.equal(isTaskStatus('todo'), true);
  assert.equal(isTaskStatus('backlog'), false);
});
```

- [ ] **Step 4: 跑测试**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/task-status.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/shared/task-status.ts server/shared/types.ts server/shared/tests/task-status.test.ts
git commit -m "feat(scheduled-tasks): add reminder label and ScheduledTaskRow types"
```

---

### Task 2: schema — `scheduled_tasks` 建表

**Files:**
- Modify: `server/modules/database/schema.ts`

- [ ] **Step 1: `schema.ts` 追加 `SCHEDULED_TASKS_TABLE_SCHEMA_SQL`**（放 `TASKS_TABLE_SCHEMA_SQL` 之后）

```ts
export const SCHEDULED_TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    schedule_id       TEXT PRIMARY KEY NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    project_path      TEXT,
    executor_provider TEXT NOT NULL DEFAULT 'claude',
    executor_model    TEXT,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
    is_operator       INTEGER DEFAULT 0,
    auto_run          INTEGER DEFAULT 1,
    schedule_type     TEXT NOT NULL CHECK (schedule_type IN ('once','interval','cron')),
    cron_expr         TEXT,
    interval_seconds  INTEGER,
    run_at            DATETIME,
    timezone          TEXT DEFAULT 'local',
    next_run_at       DATETIME NOT NULL,
    last_run_at       DATETIME,
    last_task_id      TEXT,
    enabled           INTEGER DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(enabled, next_run_at);
`;
```

- [ ] **Step 2: 并入 `INIT_SCHEMA_SQL`**——在 `${TASKS_TABLE_SCHEMA_SQL}` 的索引之后追加 `${SCHEDULED_TASKS_TABLE_SCHEMA_SQL}`

> 启动 `db.exec(INIT_SCHEMA_SQL)`（`init-db.ts:9`）对所有表跑 `CREATE TABLE IF NOT EXISTS`，现有库升级自动建新表，无需额外迁移。

- [ ] **Step 3: 验证建表**

Run:
```bash
unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && DATABASE_PATH=/tmp/st-schema-test.db npx tsx --tsconfig server/tsconfig.json -e "
import { initializeDatabase } from './server/modules/database/init-db.js';
import { getConnection, closeConnection } from './server/modules/database/connection.js';
await initializeDatabase();
const t = getConnection().prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'\").get();
console.log('scheduled_tasks table:', Boolean(t));
closeConnection();
"
```
Expected: `scheduled_tasks table: true`

- [ ] **Step 4: Commit**

```bash
git add server/modules/database/schema.ts
git commit -m "feat(scheduled-tasks): add scheduled_tasks table schema"
```

---

### Task 3: 迁移 — `tasks.source_schedule_id` 列 + label CHECK 重建

**Files:**
- Modify: `server/modules/database/migrations.ts`

- [ ] **Step 1: `runMigrations(db)` 末尾追加两段**（仿 435-444 行加列写法 + 482-496 行重建 CHECK 写法）

第一段——加列 + 索引：

```ts
  // Scheduled-tasks: link created tasks back to their schedule template.
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'source_schedule_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id)');
```

第二段——重建 tasks 表扩展 label CHECK 含 `'reminder'`（SQLite 不能 ALTER CHECK，仿 executor 重建：改名 → 用当前 schema 重建 → 拷贝所有列 → 删旧表；**拷贝列清单含 `source_schedule_id`**）：

```ts
  const tasksDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
  if (tasksDdl && !/reminder/.test(tasksDdl.sql)) {
    console.log('Running migration: rebuilding tasks table for label CHECK (reminder)');
    db.exec('ALTER TABLE tasks RENAME TO tasks_legacy_label;');
    db.exec(TASKS_TABLE_SCHEMA_SQL);
    db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id)
      SELECT task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id
      FROM tasks_legacy_label
    `).run();
    db.exec('DROP TABLE tasks_legacy_label;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id)');
  }
```

> 需要 `TASKS_TABLE_SCHEMA_SQL` 已 import（migrations.ts 顶部已 import schema 常量，若缺则加）。

- [ ] **Step 2: 验证迁移**（幂等：连续跑两次无报错）

Run:
```bash
unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && DATABASE_PATH=/tmp/st-mig-test.db npx tsx --tsconfig server/tsconfig.json -e "
import { initializeDatabase } from './server/modules/database/init-db.js';
import { getConnection, closeConnection } from './server/modules/database/connection.js';
await initializeDatabase();
const db = getConnection();
const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c: any) => c.name);
console.log('source_schedule_id column:', cols.includes('source_schedule_id'));
const ddl = db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'\").get() as any;
console.log('reminder in CHECK:', /reminder/.test(ddl.sql));
closeConnection();
"
```
Expected: `source_schedule_id column: true` + `reminder in CHECK: true`。再跑一遍确认幂等。

- [ ] **Step 3: Commit**

```bash
git add server/modules/database/migrations.ts
git commit -m "feat(scheduled-tasks): migrate tasks.source_schedule_id + label reminder CHECK"
```

---

### Task 4: `scheduled-tasks.db.ts` repository

**Files:**
- Create: `server/modules/database/repositories/scheduled-tasks.db.ts`
- Test: `server/modules/database/tests/scheduled-tasks.db.test.ts`
- Modify: `server/modules/database/index.ts`（re-export）

- [ ] **Step 1: 写失败测试**（`withIsolatedDatabase` 模式，仿 `tasks.db.integration.test.ts`）

```ts
// server/modules/database/tests/scheduled-tasks.db.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { scheduledTasksDb } from '@/modules/database/repositories/scheduled-tasks.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sched-db-'));
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

test('scheduledTasksDb CRUD + due query', async () => {
  await withIsolatedDatabase(() => {
    const created = scheduledTasksDb.createScheduledTask({
      title: '每日站会提醒',
      scheduleType: 'cron',
      cronExpr: '0 9 * * 1-5',
      nextRunAt: '2026-08-14T01:00:00.000Z',
      autoRun: 0,
    });
    assert.equal(created.schedule_type, 'cron');
    assert.equal(created.enabled, 1);
    assert.equal(created.is_operator, 1); // projectPath 缺省 → 助手工作区
    assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(scheduledTasksDb.getScheduledTask(created.schedule_id)?.title, '每日站会提醒');
    assert.equal(scheduledTasksDb.listScheduledTasks({}).length, 1);

    assert.equal(scheduledTasksDb.listDueScheduledTasks('2026-08-14T02:00:00.000Z').length, 1);
    assert.equal(scheduledTasksDb.listDueScheduledTasks('2026-08-13T00:00:00.000Z').length, 0);

    scheduledTasksDb.updateScheduledTask(created.schedule_id, { enabled: 0 });
    assert.equal(scheduledTasksDb.getScheduledTask(created.schedule_id)?.enabled, 0);
    assert.equal(scheduledTasksDb.listDueScheduledTasks('2026-08-14T02:00:00.000Z').length, 0);

    scheduledTasksDb.deleteScheduledTask(created.schedule_id);
    assert.equal(scheduledTasksDb.getScheduledTask(created.schedule_id), null);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/scheduled-tasks.db.test.ts`
Expected: FAIL——找不到模块。

- [ ] **Step 3: 实现 repository** `server/modules/database/repositories/scheduled-tasks.db.ts`

```ts
import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { ScheduledTaskRow, ScheduledTaskScheduleType } from '@/shared/types.js';

export const SCHEDULE_TYPES: readonly ScheduledTaskScheduleType[] = ['once', 'interval', 'cron'];

export function isScheduleType(value: unknown): value is ScheduledTaskScheduleType {
  return typeof value === 'string' && (SCHEDULE_TYPES as readonly string[]).includes(value);
}

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeScheduledTaskRow(row: ScheduledTaskRow): ScheduledTaskRow {
  return {
    ...row,
    next_run_at: normalizeTimestamp(row.next_run_at) ?? row.next_run_at,
    last_run_at: row.last_run_at ? (normalizeTimestamp(row.last_run_at) ?? row.last_run_at) : null,
    run_at: row.run_at ? (normalizeTimestamp(row.run_at) ?? row.run_at) : null,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

export const scheduledTasksDb = {
  createScheduledTask(input: {
    title: string;
    description?: string | null;
    projectPath?: string | null;
    executorProvider?: string;
    executorModel?: string | null;
    priority?: string;
    label?: string;
    autoRun?: boolean;
    scheduleType: ScheduledTaskScheduleType;
    cronExpr?: string | null;
    intervalSeconds?: number | null;
    runAt?: string | null;
    timezone?: string;
    nextRunAt: string;
  }): ScheduledTaskRow {
    const db = getConnection();
    const scheduleId = randomUUID();
    const row = db.prepare(`
      INSERT INTO scheduled_tasks (schedule_id, title, description, project_path, executor_provider, executor_model, priority, label, is_operator, auto_run, schedule_type, cron_expr, interval_seconds, run_at, timezone, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      scheduleId,
      input.title,
      input.description ?? null,
      input.projectPath ?? null,
      input.executorProvider ?? 'claude',
      input.executorModel ?? null,
      input.priority ?? 'P2',
      input.label ?? 'other',
      input.projectPath ? 0 : 1,
      input.autoRun === false ? 0 : 1,
      input.scheduleType,
      input.cronExpr ?? null,
      input.intervalSeconds ?? null,
      input.runAt ?? null,
      input.timezone ?? 'local',
      input.nextRunAt,
    ) as ScheduledTaskRow;
    return normalizeScheduledTaskRow(row);
  },

  getScheduledTask(scheduleId: string): ScheduledTaskRow | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE schedule_id = ?').get(scheduleId) as ScheduledTaskRow | undefined;
    return row ? normalizeScheduledTaskRow(row) : null;
  },

  listScheduledTasks(filter: { projectPath?: string; enabled?: boolean } = {}): ScheduledTaskRow[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectPath) { clauses.push('project_path = ?'); params.push(filter.projectPath); }
    if (filter.enabled !== undefined) { clauses.push('enabled = ?'); params.push(filter.enabled ? 1 : 0); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return (db.prepare(`SELECT * FROM scheduled_tasks ${where} ORDER BY next_run_at ASC`).all(...params) as ScheduledTaskRow[]).map(normalizeScheduledTaskRow);
  },

  updateScheduledTask(scheduleId: string, updates: Record<string, unknown>): ScheduledTaskRow | null {
    const db = getConnection();
    const sets: string[] = [];
    const params: unknown[] = [];
    const allowed: Record<string, (v: unknown) => unknown> = {
      title: (v) => v, description: (v) => v, project_path: (v) => v,
      executor_provider: (v) => v, executor_model: (v) => v, priority: (v) => v, label: (v) => v,
      is_operator: (v) => (v ? 1 : 0), auto_run: (v) => (v ? 1 : 0),
      schedule_type: (v) => v, cron_expr: (v) => v, interval_seconds: (v) => v, run_at: (v) => v,
      timezone: (v) => v, next_run_at: (v) => v, last_run_at: (v) => v, last_task_id: (v) => v,
      enabled: (v) => (v ? 1 : 0),
    };
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in allowed)) continue;
      sets.push(`${key} = ?`);
      params.push(allowed[key](value));
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(scheduleId);
    if (sets.length === 1) return scheduledTasksDb.getScheduledTask(scheduleId);
    db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE schedule_id = ?`).run(...params);
    return scheduledTasksDb.getScheduledTask(scheduleId);
  },

  deleteScheduledTask(scheduleId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM scheduled_tasks WHERE schedule_id = ?').run(scheduleId);
  },

  listDueScheduledTasks(now: string): ScheduledTaskRow[] {
    const db = getConnection();
    return (db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC').all(now) as ScheduledTaskRow[]).map(normalizeScheduledTaskRow);
  },

  listMissedSince(now: string): ScheduledTaskRow[] {
    const db = getConnection();
    return (db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at < ? ORDER BY next_run_at ASC').all(now) as ScheduledTaskRow[]).map(normalizeScheduledTaskRow);
  },
};
```

- [ ] **Step 4: re-export** `server/modules/database/index.ts` 加 `export { scheduledTasksDb } from './repositories/scheduled-tasks.db.js';`

- [ ] **Step 5: 跑测试验证通过** → **Step 6: Commit**

Run: 同 Step 2 → PASS
```bash
git add server/modules/database/repositories/scheduled-tasks.db.ts server/modules/database/tests/scheduled-tasks.db.test.ts server/modules/database/index.ts
git commit -m "feat(scheduled-tasks): add scheduled_tasks repository"
```

---

### Task 5: `tasks.service`/`tasks.db`/`tasks.routes` 透传 `source_schedule_id`

**Files:**
- Modify: `server/modules/database/repositories/tasks.db.ts`
- Modify: `server/modules/tasks/services/tasks.service.ts`
- Modify: `server/modules/tasks/tasks.routes.ts`

- [ ] **Step 1: `tasks.db.ts` createTask**——input 加 `sourceScheduleId?: string | null`，INSERT 列与参数补上，`RETURNING *` 自动带回

```ts
  createTask(input: {
    projectPath: string;
    title: string;
    description?: string | null;
    executorProvider: TaskEngine;
    executorModel?: string | null;
    status?: TaskStatus;
    sessionId?: string | null;
    priority?: TaskPriority;
    deadline?: string | null;
    isOperator?: boolean;
    label?: TaskLabel;
    remark?: string | null;
    sourceScheduleId?: string | null;
  }): TaskRow {
    // …现有 position/startedAtSet 逻辑不变…
    const row = db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, priority, deadline, is_operator, label, remark, source_schedule_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${startedAtSet}, ${completedAtSet}, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      taskId, input.projectPath, input.title, input.description ?? null, status,
      input.executorProvider, input.executorModel ?? null, position, input.sessionId ?? null,
      input.priority ?? 'P2', input.deadline ?? null, input.isOperator ? 1 : 0,
      input.label ?? 'other', input.remark ?? null, input.sourceScheduleId ?? null,
    ) as TaskRow;
    return normalizeTaskRow(row);
  },
```

- [ ] **Step 2: `tasks.service.ts`**——`CreateTaskInput` 加 `sourceScheduleId?: string | null`，`createTask` 内 `resolveDb.createTask({...})` 透传 `sourceScheduleId: input.sourceScheduleId ?? null`

- [ ] **Step 3: `tasks.routes.ts` POST**——body 解析补 `sourceScheduleId: typeof body.sourceScheduleId === 'string' ? body.sourceScheduleId : null,`

- [ ] **Step 4: 回归测试**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts server/modules/database/tests/tasks.db.integration.test.ts`
Expected: PASS（无回归）。

- [ ] **Step 5: Commit**

```bash
git add server/modules/database/repositories/tasks.db.ts server/modules/tasks/services/tasks.service.ts server/modules/tasks/tasks.routes.ts
git commit -m "feat(scheduled-tasks): thread source_schedule_id through task creation"
```

---

### Task 6: `scheduler.service.ts` — 完整门面（CRUD + tick + reconcile + runNow）

**Files:**
- Create: `server/modules/scheduler/services/scheduler.service.ts`
- Create: `server/modules/scheduler/services/scheduled-task-db-like.ts`
- Create: `server/modules/scheduler/tests/scheduler.service.test.ts`
- Create: `server/modules/scheduler/index.ts`

依赖：先 `npm install croner`。

- [ ] **Step 1: 装依赖**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npm install croner`
Expected: package.json + lock 更新。

- [ ] **Step 2: 写失败测试**

```ts
// server/modules/scheduler/tests/scheduler.service.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNext, createSchedulerService } from '@/modules/scheduler/services/scheduler.service.js';
import type { ScheduledTaskRow } from '@/shared/types.js';

function mkRow(over: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    schedule_id: 's1', title: 't', description: null, project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, schedule_type: 'once', cron_expr: null,
    interval_seconds: null, run_at: null, timezone: 'local',
    next_run_at: '2026-08-13T00:00:00.000Z', last_run_at: null, last_task_id: null,
    enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}

test('computeNext: once returns run_at; interval preserves phase; cron advances', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');
  // once → 固定 run_at
  assert.equal(
    computeNext(mkRow({ schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' }), now, now),
    '2026-08-14T01:00:00.000Z',
  );
  // interval 固定相位：从 08:00 每 1h，推进到第一个 > 12:00 → 13:00
  const from = new Date('2026-08-13T08:00:00.000Z');
  assert.equal(
    computeNext(mkRow({ schedule_type: 'interval', interval_seconds: 3600 }), from, now),
    '2026-08-13T13:00:00.000Z',
  );
  // cron 取下一个 09:00
  assert.equal(
    computeNext(mkRow({ schedule_type: 'cron', cron_expr: '0 9 * * *' }), now, now),
    '2026-08-14T09:00:00.000Z',
  );
});

function makeService(nowIso: string) {
  const rows = new Map<string, ScheduledTaskRow>();
  const createdTasks: unknown[] = [];
  const launches: Array<{ taskId: string; sessionId: string }> = [];
  const broadcasts: unknown[] = [];
  const db = {
    operatorWorkspacePath: '/op-ws',
    createScheduledTask: (i: never) => { const row = mkRow({ schedule_id: 'new', ...i }); rows.set('new', row); return row; },
    getScheduledTask: (id: string) => rows.get(id) ?? null,
    listScheduledTasks: () => [...rows.values()],
    updateScheduledTask: (id: string, u: Record<string, unknown>) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, ...u } as ScheduledTaskRow; rows.set(id, next); return next;
    },
    deleteScheduledTask: (id: string) => { rows.delete(id); },
    listDueScheduledTasks: (n: string) => [...rows.values()].filter((s) => s.enabled === 1 && s.next_run_at <= n),
    listMissedSince: (n: string) => [...rows.values()].filter((s) => s.enabled === 1 && s.next_run_at < n),
  };
  const svc = createSchedulerService({
    scheduledTasksDb: db,
    tasksService: {
      createTask: (i: unknown) => { createdTasks.push(i); return { task_id: 'task-1', ...i }; },
      startExecution: () => ({ sessionId: 'sess-1' }),
    },
    createSession: () => 'sess-1',
    startTaskRun: (taskId: string, sessionId: string) => { launches.push({ taskId, sessionId }); return true; },
    broadcast: (e: unknown) => broadcasts.push(e),
    now: () => new Date(nowIso),
  });
  return { svc, rows, createdTasks, launches, broadcasts };
}

test('tick dispatches once + auto-run, auto-disables once, skips auto_run=0', () => {
  const { svc, rows, createdTasks, launches, broadcasts } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('due-once', mkRow({ schedule_id: 'due-once', run_at: '2026-08-13T00:00:00.000Z', next_run_at: '2026-08-13T00:00:00.000Z' }));
  rows.set('due-remind', mkRow({ schedule_id: 'due-remind', auto_run: 0, schedule_type: 'interval', interval_seconds: 3600, next_run_at: '2026-08-13T11:00:00.000Z' }));

  svc.tickNow();

  assert.equal(createdTasks.length, 2);
  assert.equal((createdTasks[0] as { sourceScheduleId?: string }).sourceScheduleId, 'due-once');
  assert.equal(rows.get('due-once')?.enabled, 0); // once 触发后停用
  assert.equal(rows.get('due-once')?.last_task_id, 'task-1');
  assert.deepEqual(launches, [{ taskId: 'task-1', sessionId: 'sess-1' }]); // 只有 auto_run=1 启动
  assert.ok(broadcasts.some((e) => (e as { kind?: string }).kind === 'scheduled_task_upserted'));
});

test('reconcileMissedRuns creates one reminder task and advances next_run_at without re-dispatch', () => {
  const { svc, rows, createdTasks } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('missed', mkRow({ schedule_id: 'missed', schedule_type: 'interval', interval_seconds: 3600, next_run_at: '2026-08-13T10:00:00.000Z' }));
  rows.set('ok', mkRow({ schedule_id: 'ok', schedule_type: 'cron', cron_expr: '0 9 * * *', next_run_at: '2026-08-14T09:00:00.000Z' }));

  svc.reconcileMissedRuns();

  assert.equal(createdTasks.length, 1); // 只聚合一条提醒任务
  assert.equal((createdTasks[0] as { label?: string }).label, 'reminder');
  // interval 固定相位推进到未来：10:00 + 3h → 13:00
  assert.equal(rows.get('missed')?.next_run_at, '2026-08-13T13:00:00.000Z');
  assert.equal(rows.get('ok')?.next_run_at, '2026-08-14T09:00:00.000Z'); // 未被触碰
});

test('create validates scheduleType and computes initial next_run_at', () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');
  const row = svc.create({ title: 't', scheduleType: 'cron', cronExpr: '0 9 * * *' }) as ScheduledTaskRow;
  assert.equal(rows.has(row.schedule_id), true);
  assert.equal(row.next_run_at, '2026-08-14T09:00:00.000Z');
  assert.throws(() => svc.create({ title: 'bad', scheduleType: 'once' }));
});
```

- [ ] **Step 3: 跑测试验证失败**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/scheduler/tests/scheduler.service.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 4: 实现 `scheduled-task-db-like.ts`**

```ts
// server/modules/scheduler/services/scheduled-task-db-like.ts
import type { ScheduledTaskRow, ScheduledTaskScheduleType } from '@/shared/types.js';

export type ScheduledTaskDbLike = {
  operatorWorkspacePath: string;
  createScheduledTask: (input: {
    title: string;
    description?: string | null;
    projectPath?: string | null;
    executorProvider?: string;
    executorModel?: string | null;
    priority?: string;
    label?: string;
    autoRun?: boolean;
    scheduleType: ScheduledTaskScheduleType;
    cronExpr?: string | null;
    intervalSeconds?: number | null;
    runAt?: string | null;
    timezone?: string;
    nextRunAt: string;
  }) => ScheduledTaskRow;
  getScheduledTask: (scheduleId: string) => ScheduledTaskRow | null;
  listScheduledTasks: (filter: { projectPath?: string; enabled?: boolean }) => ScheduledTaskRow[];
  updateScheduledTask: (scheduleId: string, updates: Record<string, unknown>) => ScheduledTaskRow | null;
  deleteScheduledTask: (scheduleId: string) => void;
  listDueScheduledTasks: (now: string) => ScheduledTaskRow[];
  listMissedSince: (now: string) => ScheduledTaskRow[];
};
```

- [ ] **Step 5: 实现 `scheduler.service.ts`**

```ts
import { Cron } from 'croner';

import { isScheduleType } from '@/modules/database/repositories/scheduled-tasks.db.js';
import type { TasksService } from '@/modules/tasks/services/tasks.service.js';
import { AppError } from '@/shared/utils.js';
import type { ScheduledTaskRow, TaskEngine } from '@/shared/types.js';
import type { ScheduledTaskDbLike } from './scheduled-task-db-like.js';

export type SchedulerDeps = {
  scheduledTasksDb: ScheduledTaskDbLike;
  tasksService: Pick<TasksService, 'createTask' | 'startExecution'>;
  createSession: (provider: TaskEngine, projectPath: string, isOperator?: boolean) => string;
  startTaskRun: (taskId: string, sessionId: string) => boolean;
  broadcast: (event: { kind: string; [k: string]: unknown }) => void;
  now?: () => Date;
};

/**
 * 触发后的 next_run_at：
 * - once：固定 run_at（触发即终，调用方负责 enabled=0）
 * - interval：固定相位——从 store 里的 next_run_at 推进，避免漂移
 * - cron：croner 的下一时刻
 */
export function computeNext(schedule: ScheduledTaskRow, from: Date, now: Date): string {
  switch (schedule.schedule_type) {
    case 'once':
      return schedule.run_at ?? from.toISOString();
    case 'interval': {
      const stepMs = (schedule.interval_seconds ?? 0) * 1000;
      let next = from.getTime();
      while (next <= now.getTime()) next += stepMs;
      return new Date(next).toISOString();
    }
    case 'cron': {
      if (!schedule.cron_expr) return now.toISOString();
      const tz = schedule.timezone === 'local' ? undefined : schedule.timezone;
      return (new Cron(schedule.cron_expr, { timezone: tz }).nextRun(from) ?? now).toISOString();
    }
    default:
      return now.toISOString();
  }
}

/** 创建/编辑后的首轮 next_run_at（从 now 起，interval 重定相位）。 */
export function initialNextRun(
  input: { scheduleType: string; cronExpr?: string | null; intervalSeconds?: number | null; runAt?: string | null; timezone?: string },
  now: Date,
): string {
  switch (input.scheduleType) {
    case 'once':
      return input.runAt ?? now.toISOString();
    case 'interval':
      return new Date(now.getTime() + (input.intervalSeconds ?? 0) * 1000).toISOString();
    case 'cron': {
      if (!input.cronExpr) return now.toISOString();
      const tz = input.timezone === 'local' ? undefined : input.timezone;
      return (new Cron(input.cronExpr, { timezone: tz }).nextRun(now) ?? now).toISOString();
    }
    default:
      return now.toISOString();
  }
}

export function createSchedulerService(deps: SchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function dispatch(schedule: ScheduledTaskRow): void {
    const projectPath = schedule.project_path ?? deps.scheduledTasksDb.operatorWorkspacePath;
    const task = deps.tasksService.createTask({
      projectPath,
      title: schedule.title,
      description: schedule.description,
      executorProvider: schedule.executor_provider as TaskEngine,
      executorModel: schedule.executor_model,
      priority: schedule.priority as 'P0' | 'P1' | 'P2' | 'P3',
      label: schedule.label as never,
      isOperator: schedule.is_operator === 1,
      sourceScheduleId: schedule.schedule_id,
    });
    if (task && schedule.auto_run === 1) {
      try {
        const started = deps.tasksService.startExecution(task.task_id, deps.createSession);
        if (started?.sessionId) deps.startTaskRun(task.task_id, started.sessionId);
      } catch (error) {
        console.error('[scheduler] auto-run dispatch failed', error instanceof Error ? error.message : error);
      }
    }
    const firedAt = now();
    const updates: Record<string, unknown> = {
      last_run_at: firedAt.toISOString(),
      last_task_id: task?.task_id ?? null,
      next_run_at: computeNext(schedule, new Date(schedule.next_run_at), firedAt),
    };
    if (schedule.schedule_type === 'once') updates.enabled = 0;
    const updated = deps.scheduledTasksDb.updateScheduledTask(schedule.schedule_id, updates);
    deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: updated ?? schedule, timestamp: firedAt.toISOString() });
    deps.broadcast({ kind: 'task_upserted', task, actor: 'engine', timestamp: firedAt.toISOString() });
  }

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      for (const schedule of deps.scheduledTasksDb.listDueScheduledTasks(now().toISOString())) {
        try {
          dispatch(schedule);
        } catch (error) {
          console.error('[scheduler] tick dispatch failed', error instanceof Error ? error.message : error);
        }
      }
    } finally {
      ticking = false;
    }
  }

  /** 启动时：停机错过不补跑，聚合成一条 reminder 任务，推进 next_run_at。 */
  function reconcileMissedRuns(): void {
    const missed = deps.scheduledTasksDb.listMissedSince(now().toISOString());
    if (missed.length === 0) return;
    const lines = missed.map((s) => `- ${s.title}（原定 ${s.next_run_at}）`);
    deps.tasksService.createTask({
      projectPath: deps.scheduledTasksDb.operatorWorkspacePath,
      title: `⏰ 错过 ${missed.length} 次定时触发`,
      description: `后端停机期间以下定时任务未触发，已跳过：\n${lines.join('\n')}`,
      executorProvider: 'claude',
      priority: 'P2',
      label: 'reminder' as never,
      isOperator: true,
    });
    for (const s of missed) {
      const firedAt = now();
      const updates: Record<string, unknown> = { next_run_at: computeNext(s, new Date(s.next_run_at), firedAt) };
      if (s.schedule_type === 'once') updates.enabled = 0;
      deps.scheduledTasksDb.updateScheduledTask(s.schedule_id, updates);
    }
  }

  function validateScheduleInput(input: Record<string, unknown>): void {
    const scheduleType = input.scheduleType;
    if (typeof scheduleType !== 'string' || !isScheduleType(scheduleType)) {
      throw new AppError(`invalid scheduleType: ${String(scheduleType)}`, { code: 'INVALID_SCHEDULE_TYPE', statusCode: 400 });
    }
    if (scheduleType === 'cron' && typeof input.cronExpr !== 'string') {
      throw new AppError('cron schedule requires cronExpr', { code: 'INVALID_SCHEDULE', statusCode: 400 });
    }
    if (scheduleType === 'interval' && typeof input.intervalSeconds !== 'number') {
      throw new AppError('interval schedule requires intervalSeconds', { code: 'INVALID_SCHEDULE', statusCode: 400 });
    }
    if (scheduleType === 'once' && typeof input.runAt !== 'string') {
      throw new AppError('once schedule requires runAt', { code: 'INVALID_SCHEDULE', statusCode: 400 });
    }
  }

  return {
    list(filter: { projectPath?: string; enabled?: boolean } = {}): unknown[] {
      return deps.scheduledTasksDb.listScheduledTasks(filter);
    },
    get(scheduleId: string): unknown {
      return deps.scheduledTasksDb.getScheduledTask(scheduleId);
    },
    create(input: Record<string, unknown>): unknown {
      validateScheduleInput(input);
      const row = deps.scheduledTasksDb.createScheduledTask({
        title: String(input.title ?? ''),
        description: typeof input.description === 'string' ? input.description : null,
        projectPath: typeof input.projectPath === 'string' && input.projectPath ? input.projectPath : null,
        executorProvider: typeof input.executorProvider === 'string' ? input.executorProvider : undefined,
        executorModel: typeof input.executorModel === 'string' ? input.executorModel : null,
        priority: typeof input.priority === 'string' ? input.priority : undefined,
        label: typeof input.label === 'string' ? input.label : undefined,
        autoRun: input.autoRun !== 0,
        scheduleType: input.scheduleType as never,
        cronExpr: typeof input.cronExpr === 'string' ? input.cronExpr : null,
        intervalSeconds: typeof input.intervalSeconds === 'number' ? input.intervalSeconds : null,
        runAt: typeof input.runAt === 'string' ? input.runAt : null,
        timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
        nextRunAt: initialNextRun(input as never, now()),
      });
      deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      return row;
    },
    update(scheduleId: string, updates: Record<string, unknown>): unknown {
      const current = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!current) return null;
      if (updates.scheduleType !== undefined && typeof updates.scheduleType === 'string' && !isScheduleType(updates.scheduleType)) {
        throw new AppError(`invalid scheduleType: ${String(updates.scheduleType)}`, { code: 'INVALID_SCHEDULE_TYPE', statusCode: 400 });
      }
      const recompute = ['cron_expr', 'interval_seconds', 'run_at', 'schedule_type', 'timezone'].some((k) => updates[k] !== undefined);
      const cleaned: Record<string, unknown> = { ...updates };
      if (recompute) {
        const merged = { ...current, ...cleaned } as ScheduledTaskRow;
        cleaned.next_run_at = initialNextRun(merged as never, now());
      }
      const row = deps.scheduledTasksDb.updateScheduledTask(scheduleId, cleaned);
      if (row) deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      return row;
    },
    remove(scheduleId: string): void {
      deps.scheduledTasksDb.deleteScheduledTask(scheduleId);
      deps.broadcast({ kind: 'scheduled_task_deleted', scheduleId, timestamp: now().toISOString() });
    },
    setEnabled(scheduleId: string, enabled: boolean): unknown {
      const row = deps.scheduledTasksDb.updateScheduledTask(scheduleId, { enabled: enabled ? 1 : 0 });
      if (row) deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      return row;
    },
    runNow(scheduleId: string): unknown {
      const schedule = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!schedule) return null;
      dispatch(schedule);
      return { ok: true };
    },
    reconcileMissedRuns,
    start(): void {
      try { reconcileMissedRuns(); } catch (error) {
        console.error('[scheduler] reconcileMissedRuns failed', error instanceof Error ? error.message : error);
      }
      timer = setInterval(tick, 15_000);
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
    tickNow: tick,
  };
}
```

- [ ] **Step 6: barrel** `server/modules/scheduler/index.ts`

```ts
export { createSchedulerService, computeNext, initialNextRun } from './services/scheduler.service.js';
export type { SchedulerDeps } from './services/scheduler.service.js';
export { buildSchedulerRouter } from './scheduler.routes.js';
```

- [ ] **Step 7: 跑测试验证通过**

Run: 同 Step 3
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/modules/scheduler server/package.json server/package-lock.json
git commit -m "feat(scheduled-tasks): scheduler service facade"
```

> 注：`scheduler.routes.js` 在 Task 7 创建，barrel 第 5 行此时会解析失败——**把该行留到 Task 7 再加**。

---

### Task 7: `scheduler.routes.ts` — CRUD API

**Files:**
- Create: `server/modules/scheduler/scheduler.routes.ts`
- Test: `server/modules/scheduler/tests/scheduler.routes.test.ts`
- Modify: `server/modules/scheduler/index.ts`（补 barrel 第 5 行）

- [ ] **Step 1: 写失败测试**（进程内 Express + 内置 fetch，仿 `operator-routes.test.ts`）

```ts
// server/modules/scheduler/tests/scheduler.routes.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { buildSchedulerRouter } from '@/modules/scheduler/scheduler.routes.js';

async function startServer(svc: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled-tasks', buildSchedulerRouter(svc as never));
  const server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(r)) };
}

function makeSvc() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id) ?? null,
    create: (i: Record<string, unknown>) => {
      const row = { schedule_id: 's1', ...i, next_run_at: '2026-08-14T09:00:00.000Z' };
      rows.set('s1', row); return row;
    },
    update: (id: string, u: Record<string, unknown>) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, ...u }; rows.set(id, next); return next;
    },
    remove: (id: string) => { rows.delete(id); },
    runNow: (id: string) => rows.has(id) ? { ok: true } : null,
    setEnabled: (id: string, enabled: boolean) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, enabled: enabled ? 1 : 0 }; rows.set(id, next); return next;
    },
  };
}

test('POST / creates a scheduled task', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { schedule_id: string };
    assert.equal(body.schedule_id, 's1');
  } finally { await close(); }
});

test('POST / rejects invalid scheduleType', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scheduleType: 'bogus' }),
    });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('DELETE /:id removes', async () => {
  const svc = makeSvc(); svc.create({ title: 'x', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' });
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  } finally { await close(); }
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/scheduler/tests/scheduler.routes.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `scheduler.routes.ts`**

```ts
import express from 'express';
import { AppError, asyncHandler } from '@/shared/utils.js';

export type SchedulerServiceLike = {
  list: (filter: { projectPath?: string; enabled?: boolean }) => unknown[];
  get: (scheduleId: string) => unknown;
  create: (input: Record<string, unknown>) => unknown;
  update: (scheduleId: string, updates: Record<string, unknown>) => unknown;
  remove: (scheduleId: string) => void;
  runNow: (scheduleId: string) => unknown;
  setEnabled: (scheduleId: string, enabled: boolean) => unknown;
};

export function buildSchedulerRouter(svc: SchedulerServiceLike) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
    const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined;
    res.json(svc.list({ projectPath, enabled }));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    res.status(201).json(svc.create((req.body ?? {}) as Record<string, unknown>));
  }));

  router.get('/:scheduleId', asyncHandler(async (req, res) => {
    const row = svc.get(String(req.params.scheduleId));
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.patch('/:scheduleId', asyncHandler(async (req, res) => {
    const row = svc.update(String(req.params.scheduleId), (req.body ?? {}) as Record<string, unknown>);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.delete('/:scheduleId', asyncHandler(async (req, res) => {
    svc.remove(String(req.params.scheduleId));
    res.json({ success: true });
  }));

  router.post('/:scheduleId/run-now', asyncHandler(async (req, res) => {
    const result = svc.runNow(String(req.params.scheduleId));
    if (!result) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(result);
  }));

  router.post('/:scheduleId/enable', asyncHandler(async (req, res) => {
    const row = svc.setEnabled(String(req.params.scheduleId), true);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.post('/:scheduleId/disable', asyncHandler(async (req, res) => {
    const row = svc.setEnabled(String(req.params.scheduleId), false);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  return router;
}

export default buildSchedulerRouter;
```

> 校验（scheduleType/required 字段）由 service 的 `validateScheduleInput` 承担，路由保持薄。

- [ ] **Step 4: barrel 补上第 5 行** `server/modules/scheduler/index.ts`

```ts
export { buildSchedulerRouter } from './scheduler.routes.js';
```

- [ ] **Step 5: 跑测试验证通过** → **Step 6: Commit**

Run: 同 Step 2 → PASS
```bash
git add server/modules/scheduler/scheduler.routes.ts server/modules/scheduler/tests/scheduler.routes.test.ts server/modules/scheduler/index.ts
git commit -m "feat(scheduled-tasks): CRUD routes"
```

---

### Task 8: index.js 接线 — scheduler + routes + WS + operator deps

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: imports**——在现有 import 区追加：

```js
import { scheduledTasksDb } from './modules/database/index.js';
import { createSchedulerService, buildSchedulerRouter } from './modules/scheduler/index.js';
import { getOperatorConfig } from './modules/operators/operator.config.js';
```

- [ ] **Step 2: 构造 scheduler service**——放在 `startTaskRun` 定义之后、`initOperatorHeadless` 之前。**注意用原始 `tasksService`（不用 adapter——adapter 会丢掉 executor/label/isOperator/sourceScheduleId 透传），调度器传的是已类型化的值，无需窄化。**

```js
// Scheduled tasks: 15s tick dispatch. Missed runs during downtime are skipped
// but surfaced as a single label=reminder task (see scheduler service).
const broadcastScheduledTask = (event) => {
    connectedClients.forEach((client) => {
        if (client.readyState === WS_OPEN_STATE) client.send(JSON.stringify(event));
    });
};
const schedulerService = createSchedulerService({
    scheduledTasksDb: {
        ...scheduledTasksDb,
        operatorWorkspacePath: getOperatorConfig().workspace,
    },
    tasksService,
    createSession: createAppSession,
    startTaskRun,
    broadcast: broadcastScheduledTask,
});
```

- [ ] **Step 3: `start()` 在 `startServer()` 里调用**（放 `backfillSessionNames` 之后）：

```js
    try {
        schedulerService.start();
    } catch (error) {
        console.error('[scheduler] start failed:', error instanceof Error ? error.message : error);
    }
```

- [ ] **Step 4: 挂路由**（放 `app.use('/api/tasks', ...)` 附近）：

```js
app.use('/api/scheduled-tasks', authenticateToken, buildSchedulerRouter(schedulerService));
```

- [ ] **Step 5: `initOperatorHeadless` 注入 `scheduledTasks`**（Task 9 用到，先接好；`schedulerService` 的 list/get/create/update/remove 与 `OperatorToolDeps.scheduledTasks` 形状匹配）：

```js
initOperatorHeadless({
    tasks: adaptTasksServiceForOperatorTools(tasksService),
    scheduledTasks: schedulerService,
    projects: projectsDb,
    sessions: sessionsService,
    createSession: createAppSession,
    startTaskRun,
});
```

- [ ] **Step 6: 启动冒烟**——后端起来后 `GET /api/scheduled-tasks` 返回 `[]`，无报错。

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && AUTH_ENABLED=false npx tsx --tsconfig server/tsconfig.json server/index.js`
另开终端：
```bash
curl -s http://localhost:PORT/api/scheduled-tasks
```
Expected: `[]`，日志无 `[scheduler]` 错误。停掉进程。

- [ ] **Step 7: Commit**

```bash
git add server/index.js
git commit -m "feat(scheduled-tasks): wire scheduler service, routes, WS broadcast"
```

---

### Task 9: Lovdex助手 — 5 个定时工具 + prompt

**Files:**
- Modify: `server/modules/operators/operator.tools.ts`
- Modify: `server/modules/operators/tests/operator-tools.test.ts`
- Modify: `server/claude-sdk.js`（两处 system prompt）

- [ ] **Step 1: `OperatorToolDeps` 加 `scheduledTasks`**（可选注入，仿 `tasks`）：

```ts
  scheduledTasks?: {
    list: (f: { projectPath?: string; enabled?: boolean }) => unknown[];
    get: (scheduleId: string) => unknown;
    create: (i: Record<string, unknown>) => unknown;
    update: (scheduleId: string, u: Record<string, unknown>) => Promise<unknown> | unknown;
    remove: (scheduleId: string) => void;
  };
```

- [ ] **Step 2: 加 5 个工具**（全部 string/number 输入，遵守 `jsonSchemaToZodRawShape` 约束；`autoRun`/`enabled` 用 0/1 number）：

```ts
    create_scheduled_task: {
      description: 'Create a scheduled-task template. On each trigger it creates a real task (seen in list_tasks). autoRun=1 dispatches the agent run immediately; autoRun=0 creates a todo/reminder only. scheduleType: once (runAt) | interval (intervalSeconds) | cron (cronExpr). projectPath empty = Lovdex 助手 workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title created on each trigger' },
          description: { type: 'string' },
          projectPath: { type: 'string', description: 'Project path; empty = Lovdex 助手 workspace' },
          scheduleType: { type: 'string', enum: ['once', 'interval', 'cron'] },
          cronExpr: { type: 'string', description: 'cron expression when scheduleType=cron, e.g. "0 9 * * 1-5"' },
          intervalSeconds: { type: 'number', description: 'seconds between runs when scheduleType=interval' },
          runAt: { type: 'string', description: 'ISO datetime when scheduleType=once' },
          autoRun: { type: 'number', description: '1 = auto-execute, 0 = reminder only' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          label: { type: 'string' },
          executorModel: { type: 'string' },
        },
        required: ['title', 'scheduleType'],
      },
      handler: async (i: Record<string, unknown>) => deps.scheduledTasks!.create(i),
    },
    list_scheduled_tasks: {
      description: 'List scheduled-task templates (optional projectPath/enabled filter). Returns nextRunAt and scheduleType for each.',
      inputSchema: {
        type: 'object',
        properties: { projectPath: { type: 'string' }, enabled: { type: 'number', description: '1 = enabled only' } },
      },
      handler: async (i: { projectPath?: string; enabled?: number }) =>
        deps.scheduledTasks!.list({ projectPath: i.projectPath, enabled: i.enabled === 1 }),
    },
    get_scheduled_task: {
      description: 'Get a single scheduled-task template by scheduleId.',
      inputSchema: { type: 'object', properties: { scheduleId: { type: 'string' } }, required: ['scheduleId'] },
      handler: async (i: { scheduleId: string }) => deps.scheduledTasks!.get(i.scheduleId),
    },
    update_scheduled_task: {
      description: 'Update a scheduled-task template (schedule field changes recompute nextRunAt).',
      inputSchema: {
        type: 'object',
        properties: {
          scheduleId: { type: 'string' },
          title: { type: 'string' }, description: { type: 'string' },
          cronExpr: { type: 'string' }, intervalSeconds: { type: 'number' }, runAt: { type: 'string' },
          autoRun: { type: 'number' }, priority: { type: 'string' }, label: { type: 'string' },
          enabled: { type: 'number', description: '0 = disable' },
        },
        required: ['scheduleId'],
      },
      handler: async (i: Record<string, unknown>) => {
        const { scheduleId, ...rest } = i;
        return deps.scheduledTasks!.update(scheduleId, rest);
      },
    },
    delete_scheduled_task: {
      description: 'Delete a scheduled-task template (already-created tasks are kept).',
      inputSchema: { type: 'object', properties: { scheduleId: { type: 'string' } }, required: ['scheduleId'] },
      handler: async (i: { scheduleId: string }) => deps.scheduledTasks!.remove(i.scheduleId),
    },
```

- [ ] **Step 3: 补测试**（仿 `operator-tools.test.ts` 的 fake 断言；`fakeTasks` 复用该文件已有的空 stub）

```ts
test('create_scheduled_task passes through to scheduledTasks.create', async () => {
  let received: Record<string, unknown> = {};
  const fakeScheduled = {
    create: (i: unknown) => { received = i as Record<string, unknown>; return { schedule_id: 's1' }; },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never, scheduledTasks: fakeScheduled as never });
  await tools.create_scheduled_task.handler({ title: 't', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z', autoRun: 1 });
  assert.equal(received.scheduleType, 'once');
  assert.equal(received.autoRun, 1);
});

test('update_scheduled_task splits scheduleId from the rest', async () => {
  let received: { id?: string; rest?: Record<string, unknown> } = {};
  const fakeScheduled = {
    update: (id: string, u: unknown) => { received = { id, rest: u as Record<string, unknown> }; return { schedule_id: id }; },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never, scheduledTasks: fakeScheduled as never });
  await tools.update_scheduled_task.handler({ scheduleId: 's1', enabled: 0, title: 'new' });
  assert.equal(received.id, 's1');
  assert.equal(received.rest?.enabled, 0);
  assert.equal(received.rest?.title, 'new');
});
```

- [ ] **Step 4: 跑测试验证通过**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-tools.test.ts`
Expected: PASS

- [ ] **Step 5: 更新两处 system prompt**（`server/claude-sdk.js`）

交互式 operator prompt（约 568 行）工具清单追加 `create_scheduled_task/list_scheduled_tasks/get_scheduled_task/update_scheduled_task/delete_scheduled_task`，并补一句：

```
定时任务=到点自动建任务的模板；auto_run=1 无人值守执行，auto_run=0 只生成待办（提醒）；停机错过触发会以一条 label=reminder 的提醒任务通知。被问"有什么定时/待办任务"时用 list_scheduled_tasks + list_tasks 回答。
```

headless verdict prompt（约 1191 行）工具清单同样追加 5 个工具名。

- [ ] **Step 6: Commit**

```bash
git add server/modules/operators/operator.tools.ts server/modules/operators/tests/operator-tools.test.ts server/claude-sdk.js
git commit -m "feat(scheduled-tasks): operator assistant scheduled-task tools + prompts"
```

---

### Task 10: 全量回归 + 推送

- [ ] **Step 1: 跑后端全部测试**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --tsconfig server/tsconfig.json --test server/**/*.test.ts server/**/tests/*.test.ts`
Expected: 全绿。若既有测试因 `TaskRow` 加字段失败（fixture 用 `as` 断言），补 `source_schedule_id` 即可。

- [ ] **Step 2: 启动冒烟 + 建一条定时任务实测**

启动后端（`AUTH_ENABLED=false`），然后：
```bash
# 创建每 10 秒间隔的定时任务（auto_run=0，避免真跑；project 需已存在）
curl -s -X POST http://localhost:PORT/api/scheduled-tasks -H 'Content-Type: application/json' \
  -d '{"title":"冒烟-每10秒","scheduleType":"interval","intervalSeconds":10,"autoRun":0,"projectPath":"<一个已登记项目路径>"}'
curl -s http://localhost:PORT/api/scheduled-tasks
```
Expected: 列表有该模板；约 10 秒后 `GET /api/tasks` 出现 `source_schedule_id` 非空的任务，模板 `last_run_at` 更新。清理测试模板与任务。

- [ ] **Step 3: 推送分支**（先 `git -C /mnt/b/workdir/github/lovdex/lovdex-backend status` 确认无并发会话改动）

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git checkout -b feat/scheduled-tasks
git add -A && git commit -m "feat(scheduled-tasks): backend scheduler + API + operator tools"
git checkout main && git merge --ff-only feat/scheduled-tasks && git push origin main
```
