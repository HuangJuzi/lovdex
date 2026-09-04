# Task Archive Status 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `archived` 作为第 5 个任务状态（纯用户动作），归档/取消归档时联动关联会话的 `sessions.isArchived`，使项目下隐藏/恢复该会话；看板与表格默认不显示归档任务，通过持久化筛选开关查看。

**Architecture:** `archived` 加入后端 `TASK_STATUSES` + DB CHECK（迁移重建 tasks 表）；归档副作用集中挂在 `tasks.service.ts` 的 `applyStatusChange`（只用用户 actor，engine 拒绝）；前端复用 `sessions.isArchived` 机制（项目会话列表查询已过滤 `isArchived=0`，零改动）。前端看板遍历 `STATUS_ORDER` 时跳过非激活的 archived 列，`taskFilter` 增加 `showArchived` 持久化开关；卡片/详情/表格加「归档/取消归档」按钮，走现有 `PATCH /api/tasks/:taskId`。

**Tech Stack:** Node 22 + tsx + node:test（后端/前端共享）、exprées + better-sqlite3（后端）、React 18 + Tailwind（web）。

**Spec:** `docs/superpowers/specs/2026-09-04-task-archive-status-design.md`

**测试命令：**
- 后端（在 `backend/` 下）：`npx tsx --tsconfig server/tsconfig.json --test server/<path>.test.ts`
- 前端（在 `web/` 下）：`env -u TSX_TSCONFIG_PATH npx tsx --test src/<path>.test.ts`（.test.tsx 同理）
- 全量前端：`env -u TSX_TSCONFIG_PATH npx tsx --test src/**/*.test.*`（无 glob 支持时逐个跑受影响文件）

**注意（环境 gotcha）：** shell 全局导出了 `TSX_TSCONFIG_PATH=server/tsconfig.json`，前端跑测试必须 `env -u TSX_TSCONFIG_PATH`。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `backend/server/shared/task-status.ts` | `TASK_STATUSES` / `STATUS_ORDER` / `isTaskStatus` | 修改 |
| `backend/server/modules/database/schema.ts` | `TASKS_TABLE_SCHEMA_SQL`（STATUS_CHECK 自动含 archived） | 修改（无实际改动，CHECK 由常量生成；仅确认） |
| `backend/server/modules/database/migrations.ts` | 新增「重建 tasks 接受 archived」迁移 | 修改 |
| `backend/server/modules/database/repositories/tasks.db.ts` | `statusTimestampSets`（归档不清空/不重写 completed_at） | 修改 |
| `backend/server/modules/tasks/services/tasks.service.ts` | `applyStatusChange` archived 守卫 + 副作用；`createTask` 拒绝 archived；`moveTask` 拒绝 archived | 修改 |
| `backend/server/shared/tests/task-status-model.test.ts` | TASK_STATUSES 含 archived | 修改 |
| `backend/server/modules/database/tests/tasks-status-migration.test.ts` | 迁移接受 archived 且保留数据 | 修改 |
| `backend/server/modules/tasks/tests/tasks.service.status.test.ts` | 归档/取消归档/守卫/副作用 | 修改 |
| `web/src/types/app.ts` | `TaskStatus` 加 `'archived'` | 修改 |
| `web/src/components/tasks/taskStatus.ts` | `STATUS_ORDER`/`STATUS_META` 加 archived | 修改 |
| `web/src/components/tasks/taskFilter.ts` | `showArchived` 字段 + filterTasks 过滤 | 修改 |
| `web/src/components/tasks/TaskFilterBar.tsx` | 「显示归档」开关 | 修改 |
| `web/src/components/tasks/taskStatus.test.ts` | 元数据含 archived | 修改 |
| `web/src/components/tasks/taskFilter.test.ts` | showArchived 过滤 + 归一化 | 修改 |
| `web/src/components/tasks/TaskBoard.tsx` | 看板跳过未激活的 archived 列 | 修改 |
| `web/src/components/tasks/TaskCard.tsx` | done→「归档」/ archived→「取消归档」按钮 | 修改 |
| `web/src/components/tasks/TaskDetail.tsx` | 同上入口 | 修改 |
| `web/src/components/tasks/TaskCard.test.tsx` | 按钮渲染断言 | 修改 |

---

### Task 0: 环境自检（不在 main 上实现——先确认分支约定）

**Files:** 无

> 仓库惯例：实现应在 `feat/*` 分支上做，含 spec/计划文档后在 main 上 ff 合入。实现开始前确认分支。

- [ ] **Step 1: 检查当前分支**

Run: `git branch --show-current`
Expected: `main`（若已在 feature 分支则跳过 Task 0）
Action: 新建 feature 分支 `feat/task-archive-status`，从 main 切出。

```bash
git checkout -b feat/task-archive-status
```

---

### Task 1: 后端状态常量加入 archived + 模型测试

**Files:**
- Modify: `backend/server/shared/task-status.ts`
- Test: `backend/server/shared/tests/task-status-model.test.ts`

- [ ] **Step 1: 读现有模型测试确认断言模式**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/task-status-model.test.ts`
Expected: PASS（baseline）

- [ ] **Step 2: 更新断言模式并加归档测试（TDD）**

`task-status-model.test.ts` 两处改动：

1. 更新既有 `'status list is the unified 4'` 测试（首行将断言 4 值改为 5 值，名字更新）：

```ts
test('status list is the unified 5', () => {
  assert.deepEqual([...STATUS_ORDER], ['todo', 'in_progress', 'in_review', 'done', 'archived']);
  assert.equal(isTaskStatus('todo'), true);
  assert.equal(isTaskStatus('archived'), true);
  assert.equal(isTaskStatus('backlog'), false);
});
```

2. 追加归档特有断言：

```ts
test('archived is ordered after done and only reachable via status domain', () => {
  assert.equal(STATUS_ORDER.indexOf('archived'), STATUS_ORDER.indexOf('done') + 1);
});
```

（文件顶部 import 块已有 `TASK_STATUSES, STATUS_ORDER, isTaskStatus` —— 需在 import 里补 `TASK_STATUSES`。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/task-status-model.test.ts`
Expected: FAIL（`archived` is not a valid status；原 unified-4 断言也因 5 值失败）

- [ ] **Step 4: 实现 —— `TASK_STATUSES` 加 `'archived'`**

`backend/server/shared/task-status.ts` 行 14 改为：

```ts
export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'archived'] as const;
```

文件顶部注释同步（可留一句「archived 是纯用户动作」）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/task-status-model.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/server/shared/task-status.ts backend/server/shared/tests/task-status-model.test.ts
git commit -m "feat(tasks): add archived to task status domain"
```

---

### Task 2: 后端迁移 —— 重建 tasks 表接受 archived

**Files:**
- Modify: `backend/server/modules/database/migrations.ts`（`migrateTasksTable` 尾部的 rebuild gate 段）
- Test: `backend/server/modules/database/tests/tasks-status-migration.test.ts`

背景：SQLite 无法 ALTER CHECK。`STATUS_CHECK` 由 `TASK_STATUSES.map` 生成到 `schema.ts` 的 `TASKS_TABLE_SCHEMA_SQL`，现在已含 archived；旧库的表 SQL 里没有 `'archived'`，需要一个幂等 rebuild gate。

- [ ] **Step 1: 确认迁移入口位置**

在 `migrations.ts` 的 `migrateTasksTable` 函数内、**最后一个 rebuild（opencode+qoder gate，约 546 行）`if` 块之后、`await …` 之外**追加新 gate（见 Step 3）。

- [ ] **Step 2: 写迁移测试（TDD）**

在 `tests/tasks-status-migration.test.ts` 追加（仿照 `INTERMEDIATE_TASKS_DDL` 的 4 status 表结构 + 跑 `initializeDatabase` 后断言表 SQL 含 archived 且数据保留）。注意 `INTERMEDIATE_TASKS_DDL` 已在文件顶部定义且不含 `'archived'`，直接复用它构造一个「升级前」库：

```ts
test('migrateTasksTable rebuilds to accept archived status, preserving rows', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-archive-'));
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
  legacy.exec(INTERMEDIATE_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, status) VALUES (?, ?, ?, ?)`).run('t-done', '/tmp/example-repo', 'done', 'done');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string };
    assert.match(row.sql, /CHECK \(status IN \('todo','in_progress','in_review','done','archived'\)\)/);
    const kept = db.prepare('SELECT task_id, status FROM tasks WHERE task_id = ?').get('t-done') as { task_id: string; status: string };
    assert.equal(kept.status, 'done');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks-status-migration.test.ts`
Expected: FAIL（表 SQL 仍是 4-status CHECK）

- [ ] **Step 4: 实现迁移 gate**

在 `migrations.ts` `migrateTasksTable` 的 opencode rebuild 之后追加：

```ts
  // Rebuild tasks table when the archived status was added to the status CHECK.
  // Same rename → recreate → copy → drop pattern as the engine rebuilds above.
  const tasksSqlForArchive =
    (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (!tasksSqlForArchive.includes("'archived'")) {
    console.log('Running migration: rebuild tasks table to accept archived status');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec('ALTER TABLE tasks RENAME TO tasks_legacy_archived;');
      db.exec(TASKS_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, context_summary, source_schedule_id)
        SELECT task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, context_summary, source_schedule_id
        FROM tasks_legacy_archived
      `);
      db.exec('DROP TABLE tasks_legacy_archived;');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id);`);
      db.exec('COMMIT');
    } catch (rebuildError) {
      db.exec('ROLLBACK');
      throw rebuildError;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
```

> 先核对 `TASKS_TABLE_SCHEMA_SQL` 现有列名（`context_summary` 是否存在，若 schema 无该列则从 INSERT 清单移除）——从 `schema.ts` `TASKS_TABLE_SCHEMA_SQL` 逐列比对，INSERT 列列表必须与目标 DDL 完全一致。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks-status-migration.test.ts`
Expected: PASS（新测试 + 既有迁移测试全部通过）

- [ ] **Step 6: 跑整个 database tests 目录（回归）**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/*.test.ts`
Expected: 全 PASS（`provider-rename-migration` / `scheduled-tasks-rename` 等迁移测试不回归）

- [ ] **Step 7: Commit**

```bash
git add backend/server/modules/database/migrations.ts backend/server/modules/database/tests/tasks-status-migration.test.ts
git commit -m "feat(tasks): migrate tasks table to accept archived status"
```

---

### Task 3: statusTimestampSets —— 归档不清空/不重写 completed_at

**Files:**
- Modify: `backend/server/modules/database/repositories/tasks.db.ts`（`statusTimestampSets`，行 41-50）
- Test: `backend/server/modules/tasks/tests/tasks.service.status.test.ts`（追加）

- [ ] **Step 1: 写集成测试（通过 updateTaskStatus 验证时间戳行为）**

该测试放在 `tasks.service.status.test.ts` 里（那里已有 `withIsolatedDatabase`/`projectsDb`/`tasksDb` helper）。追加：

```ts
test('updateTaskStatus: done→archived keeps completed_at; archived→done keeps it', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude', status: 'done' });
    const completed = tasksDb.getTask(created.task_id)!.completed_at;
    assert.ok(completed, 'done task has completed_at');
    tasksDb.updateTaskStatus(created.task_id, 'archived');
    assert.equal(tasksDb.getTask(created.task_id)!.completed_at, completed);
    tasksDb.updateTaskStatus(created.task_id, 'done');
    assert.equal(tasksDb.getTask(created.task_id)!.completed_at, completed);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.status.test.ts`
Expected: FAIL（`done→archived` 会清空 completed_at，因为旧逻辑 `to !== 'done' && from === 'done'` 清空；`archived→done` 会重写）

- [ ] **Step 3: 实现**

`tasks.db.ts` 行 41-50 改为：

```ts
function statusTimestampSets(from: TaskStatus, to: TaskStatus): string[] {
  // A same-status move (drag-reorder within a column) is not a transition —
  // leave lifecycle timestamps untouched.
  if (from === to) return [];
  const sets: string[] = [];
  if (to === 'in_progress') sets.push('started_at = CURRENT_TIMESTAMP');
  // Archiving is not "completing now" (keep the real completion time), and
  // unarchiving is not "reopening" (keep it too). Only a genuine done entry
  // stamps completed_at.
  if (to === 'done' && from !== 'archived') sets.push('completed_at = CURRENT_TIMESTAMP');
  if (to !== 'done' && to !== 'archived' && from === 'done') sets.push('completed_at = NULL');
  return sets;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.status.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/database/repositories/tasks.db.ts backend/server/modules/tasks/tests/tasks.service.status.test.ts
git commit -m "feat(tasks): archive transitions preserve completed_at"
```

---

### Task 4: 后端归档/取消归档 —— applyStatusChange 守卫 + 会话副作用

**Files:**
- Modify: `backend/server/modules/tasks/services/tasks.service.ts`（`applyStatusChange` 行 200-218；`createTask` 行 223-…；`moveTask` 行 424-438）
- Test: `backend/server/modules/tasks/tests/tasks.service.status.test.ts`

- [ ] **Step 1: 确认 service 依赖注入里有 sessionsDb 可调 updateSessionIsArchived**

`createTasksService` 的 `opts.deps?.sessionsDb` 已在类型里（`typeof sessionsDb`），测试里 `makeService()` 不传 deps → 落到默认 `import { sessionsDb }`？确认：`tasks.service.ts` 顶部已 `import { projectsDb, sessionsDb }`，且 `resolveSession` 用 `opts.deps?.sessionsDb?.getSessionById ?? sessionsDb.getSessionById`。副作用调用直接用注入的会话仓库：`const sessionDb = opts.deps?.sessionsDb ?? sessionsDb;`（沿用现有 resolve 模式）。

- [ ] **Step 2: 写测试（TDD）**

`tasks.service.status.test.ts` 追加（先补顶部 import：`import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';`）：

```ts
test('archive: only from done; toggles linked session isArchived + clears sub_status', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    // 真实 session 行（session_id = 's1'），否则 isArchived 断言拿不到行
    sessionsDb.createSession('s1', 'claude', '/tmp/example-repo');
    const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude' });
    tasksDb.linkSession(created.task_id, 's1');
    const svc = makeService();
    svc.applyStatusChange(created.task_id, 'done', 'user');
    assert.equal(svc.getTask(created.task_id)?.status, 'done');

    svc.applyStatusChange(created.task_id, 'archived', 'user');
    const row = svc.getTask(created.task_id);
    assert.equal(row?.status, 'archived');
    assert.equal(row?.sub_status, null);
    assert.equal(sessionsDb.getSessionById('s1')?.isArchived, 1);

    // 取消归档
    svc.applyStatusChange(created.task_id, 'done', 'user');
    assert.equal(svc.getTask(created.task_id)?.status, 'done');
    assert.equal(sessionsDb.getSessionById('s1')?.isArchived, 0);
  });
});

test('archive: rejects non-done source and disallows other transitions out', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    // todo 直接归档被拒
    assert.throws(() => svc.applyStatusChange(id, 'archived', 'user'), /invalid|archive/i);
    svc.applyStatusChange(id, 'done', 'user');
    assert.equal(svc.getTask(id)?.status, 'done');
    // archived 只能回 done
    svc.applyStatusChange(id, 'archived', 'user');
    assert.throws(() => svc.applyStatusChange(id, 'in_progress', 'user'), /invalid|archive/i);
    assert.throws(() => svc.applyStatusChange(id, 'todo', 'user'), /invalid|archive/i);
  });
});

test('archive: engine actor can never set archived', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.applyStatusChange(id, 'done', 'user');
    assert.throws(() => svc.applyStatusChange(id, 'archived', 'engine'), /invalid|archive/i);
  });
});

test('archive: no linked session is tolerated (task-only archive)', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude', status: 'done' });
    const svc = makeService();
    assert.doesNotThrow(() => svc.applyStatusChange(created.task_id, 'archived', 'user'));
    assert.equal(svc.getTask(created.task_id)?.status, 'archived');
  });
});

test('createTask rejects status=archived', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const svc = makeService();
    assert.throws(
      () => svc.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude', status: 'archived' }),
      /invalid|archive/i,
    );
  });
});
```

> `applyStatusChange` / `createTask` / `getTask` / `moveTask` 均为 `createTasksService` 的公开方法（已在 return 对象里）。测试里的 `seedTask()` 已有（本项目 helper）。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.status.test.ts`
Expected: FAIL（archived 被 `isTaskStatus` 之外逻辑拒绝/权限不足等）

- [ ] **Step 4: 实现 —— applyStatusChange archived 分支**

`tasks.service.ts` 的 `applyStatusChange` 改为（保留现有行为，追加 archived 分支）：

```ts
  function applyStatusChange(taskId: string, status: TaskStatus, actor: 'user' | 'engine'): TaskRow | null {
    if (!isTaskStatus(status)) {
      throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
    }
    const row = resolveDb.getTask(taskId);
    if (!row) return null;
    // archived 是纯用户动作：只有 done 能进、只有 archived 能出（回到 done），
    // 引擎永不写入 archived（double guard）。
    if (status === 'archived') {
      if (actor !== 'user') {
        throw new AppError('only a user can archive a task', { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (row.status !== 'done') {
        throw new AppError(`only completed tasks can be archived (current: ${row.status})`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
    } else if (row.status === 'archived') {
      if (status !== 'done') {
        throw new AppError(`an archived task can only return to done (target: ${status})`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
    }
    const changed = row.status !== status;
    resolveDb.updateTaskStatus(taskId, status);
    // A manual status change re-positions the task, so a sub_status tag from the
    // previous state no longer applies — e.g. 标记完成 clears a stale AI tag.
    // Engine transitions manage sub_status explicitly (failed sets it,
    // running/completed/aborted clear it; writeSummary writes the verdict tag).
    if (changed && actor === 'user') {
      resolveDb.updateTaskSubStatus(taskId, null);
    }
    // 归档副作用：隐藏 / 恢复关联会话，使「项目下不再显示该 session」成立
    // （项目侧列表查询都以 isArchived = 0 过滤，零改动）。无会话时静默跳过。
    const sessionDb = opts.deps?.sessionsDb ?? sessionsDb;
    if (changed && row.session_id) {
      try {
        sessionDb.updateSessionIsArchived(row.session_id, status === 'archived');
      } catch (err) {
        // 会话可能已被硬删（悬空外键）；任务状态仍生效，不阻断。
        console.warn('[tasks] session archive side-effect skipped', { taskId, sessionId: row.session_id, err });
      }
    }
    const updated = resolveDb.getTask(taskId) ?? row;
    emit({ kind: 'task_upserted', task: updated, actor });
    return decorate(updated);
  }
```

同时：
- **`createTask` 拒绝 archived**：`createTask` 的 status 校验处（行 226-228 `if (!isTaskStatus(status))` 之后）加：`if (status === 'archived') throw new AppError('a task cannot be created as archived', { code: 'INVALID_STATUS', statusCode: 400 });`
- **`moveTask` 拒绝 archived**：`moveTask` 首行 `if (!isTaskStatus(status))` 之后加：`if (status === 'archived') throw new AppError('use archive action, not move, to archive a task', { code: 'INVALID_STATUS', statusCode: 400 });`

（`applyStatusChange` 已是公开方法，无需改动 return 对象。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.status.test.ts`
Expected: PASS（含既有 14 个用例 + 新增）

- [ ] **Step 6: 跑后端整个 tasks 模块测试（回归）**

Run: `npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/*.test.ts`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/tasks.service.status.test.ts
git commit -m "feat(tasks): archive/unarchive with session-hiding side effect"
```

---

### Task 5: 前端类型与元数据 —— TaskStatus + STATUS_META/ORDER

**Files:**
- Modify: `web/src/types/app.ts`（行 83）
- Modify: `web/src/components/tasks/taskStatus.ts`
- Test: `web/src/components/tasks/taskStatus.test.ts`

- [ ] **Step 1: 改类型**

`web/src/types/app.ts` 行 83：

```ts
export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'archived';
```

- [ ] **Step 2: 改元数据**

`taskStatus.ts`：
- 行 5：`STATUS_ORDER` 加 `'archived'`；
- 行 7-12：STATUS_META 加：

```ts
  archived: { label: '已归档', color: '#9ca3af' },
```

- 可选：`taskSessionState` 天然覆盖（`in_progress/in_review/done` switch 其余 default 'none'，archived→none，正确）。

- [ ] **Step 3: 更新测试（TDD）**

`taskStatus.test.ts` 行 29-31 改为：

```ts
test('STATUS_ORDER is the unified 5, archived last', () => {
  assert.deepEqual(STATUS_ORDER, ['todo', 'in_progress', 'in_review', 'done', 'archived']);
});
```

`groupByStatus` buckets 测试（行 47）可以补一条：

```ts
test('groupByStatus buckets archived tasks separately', () => {
  const tasks = [mkTask('e', 'archived')];
  const g = groupByStatus(tasks);
  assert.equal(g['archived'].length, 1);
});
```

`mkTask` 用 `Task['status']` 类型已含 archived（类型已改），无需改函数签名。

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskStatus.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/types/app.ts web/src/components/tasks/taskStatus.ts web/src/components/tasks/taskStatus.test.ts
git commit -m "feat(tasks): add archived metadata to frontend task status"
```

---

### Task 6: 前端筛选 —— showArchived 默认隐藏，开关显示

**Files:**
- Modify: `web/src/components/tasks/taskFilter.ts`
- Modify: `web/src/components/tasks/TaskFilterBar.tsx`
- Test: `web/src/components/tasks/taskFilter.test.ts`

- [ ] **Step 1: 改 TaskFilter 类型与逻辑**

`taskFilter.ts`：
- 行 8-14 type：加 `showArchived: boolean;`
- 行 16-22 `EMPTY_TASK_FILTER`：加 `showArchived: false,`
- `normalizeTaskFilter`（行 28-51）：`showArchived: src.showArchived === true,`
- `filterTasks`（行 126-142）：filter 开头追加：

```ts
  return tasks.filter((task) => {
    if (!filter.showArchived && task.status === 'archived') return false;
    ...其余不变
  });
```

- [ ] **Step 2: 改 TaskFilterBar 加开关**

`TaskFilterBar.tsx`：
- 左簇（ProjectMultiSelect 后）或右簇新增一个「显示归档」Pill：

```tsx
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              isActive={filter.showArchived}
              onClick={() => onChange({ ...filter, showArchived: !filter.showArchived })}
              title="显示已归档任务及其会话需从来源恢复"
            >
              显示归档
            </Pill>
          </div>
```

- `hasFilter`（行 68-72）保持只看 projectPaths/preset/custom（`showArchived` 不点亮「清除筛选」小红点，意义不大；但为了让「清除筛选」也能复位它，让 `onChange(EMPTY_TASK_FILTER)` 清除即可——EMPTY 已含 false）。

- [ ] **Step 3: 写/更新测试（TDD）**

`taskFilter.test.ts` 追加：

```ts
test('filterTasks: archived tasks are hidden by default', () => {
  const archived = mkTask({ task_id: 'a', status: 'archived' });
  const done = mkTask({ task_id: 'b', status: 'done' });
  const out = filterTasks([archived, done], filterOf({}), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['b']);
});

test('filterTasks: showArchived=true includes archived tasks', () => {
  const archived = mkTask({ task_id: 'a', status: 'archived' });
  const done = mkTask({ task_id: 'b', status: 'done' });
  const out = filterTasks([archived, done], filterOf({ showArchived: true }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('normalizeTaskFilter: missing showArchived defaults to false', () => {
  assert.equal(normalizeTaskFilter({}).showArchived, false);
  assert.equal(normalizeTaskFilter({ showArchived: true }).showArchived, true);
});
```

`EMPTY_TASK_FILTER` 现在含 `showArchived: false`，既有 `filterOf` 走 spread，自动兼容。

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskFilter.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 TaskFilterBar 测试确认不回归**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskFilterBar.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/tasks/taskFilter.ts web/src/components/tasks/taskFilter.test.ts web/src/components/tasks/TaskFilterBar.tsx
git commit -m "feat(tasks): hide archived tasks unless showArchived filter is on"
```

---

### Task 7: 看板 + 卡片 + 详情 + 表格入口

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`（列渲染）
- Modify: `web/src/components/tasks/TaskCard.tsx`
- Modify: `web/src/components/tasks/TaskDetail.tsx`
- Modify: `web/src/components/tasks/TaskTableView.tsx`
- Test: `web/src/components/tasks/TaskCard.test.tsx`

- [ ] **Step 1: 看板跳过未激活 archived 列**

`TaskBoard.tsx` 行 717 `STATUS_ORDER.map((status) => …)` 改为：

```tsx
{STATUS_ORDER.filter((status) => status !== 'archived' || filter.showArchived).map((status) => (…))
```

（`filter` 在 TaskBoard 顶部已定义于 `useMemo(normalizeTaskFilter(storedFilter))`。）

- [ ] **Step 2: 卡片加归档/取消归档按钮**

`TaskCard.tsx` Actions 区（`in_review` 标记完成按钮之后）追加：

```tsx
        {task.status === 'done' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange?.('archived');
            }}
            className="min-h-9 min-w-0 flex-1 rounded-lg bg-gray-500/10 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-500/20 sm:min-h-0 shadow-[0_2px_0_rgba(30,27,50,0.08)] dark:text-gray-400"
          >
            🗄 归档
          </button>
        )}
        {task.status === 'archived' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange?.('done');
            }}
            className="min-h-9 min-w-0 flex-1 rounded-lg bg-gray-500/10 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-500/20 sm:min-h-0 shadow-[0_2px_0_rgba(30,27,50,0.08)] dark:text-gray-400"
          >
            ↩ 取消归档
          </button>
        )}
```

- [ ] **Step 3: 详情页加入口**

`TaskDetail.tsx` 行 525-540 的操作区：`task.status !== 'done'` 时显示「✓ 标记完成」；在它之后追加：

```tsx
              {task.status === 'done' && (
                <button
                  className="flex-1 rounded-md bg-gray-500/15 px-4 py-2 text-sm font-semibold text-gray-500 hover:bg-gray-500/25 sm:w-auto sm:flex-none sm:px-6 dark:text-gray-400"
                  onClick={() => updateStatus('archived')}
                >
                  🗄 归档
                </button>
              )}
              {task.status === 'archived' && (
                <button
                  className="flex-1 rounded-md bg-gray-500/15 px-4 py-2 text-sm font-semibold text-gray-500 hover:bg-gray-500/25 sm:w-auto sm:flex-none sm:px-6 dark:text-gray-400"
                  onClick={() => updateStatus('done')}
                >
                  ↩ 取消归档
                </button>
              )}
```

（`updateStatus` 已存在于 `TaskDetail.tsx` 行 337，走 PATCH。）

- [ ] **Step 4: 表格行加入口**

`TaskTableView.tsx` 的 `TaskRow`（约行 404 `in_review` 标记完成按钮后）追加同样的归档/取消归档按钮（仿 `TaskCard` 的写法，`onStatusChange?.(task, 'archived'/'done')`）。

- [ ] **Step 5: 更新任务导出类型透传？**

核对 `TaskTableViewProps.onStatusChange` 已支持任意 `TaskStatus`；`TaskBoard` 的 `onStatusChange={(task, status) => updateStatus(task, status)}` 已透传。无额外改动。

- [ ] **Step 6: 写卡片测试（TDD）**

`TaskCard.test.tsx` 追加（`render` helper 只做静态 SSR，按钮 onClick 不触发，所以只断言按钮文本存在）：

```ts
test('done card renders an archive button', () => {
  const html = render(
    { ...baseTask, status: 'done' },
    { onStatusChange: () => {} },
  );
  assert.match(html, /🗄 归档/);
});

test('archived card renders an unarchive button', () => {
  const html = render(
    { ...baseTask, status: 'archived' },
    { onStatusChange: () => {} },
  );
  assert.match(html, /↩ 取消归档/);
});

test('archived card does not render open-session button', () => {
  const html = render(
    { ...baseTask, status: 'archived', session_id: 's1' },
    { onOpenSession: () => {}, onStart: () => {}, onStatusChange: () => {} },
  );
  assert.doesNotMatch(html, /打开会话/);
});
```

- [ ] **Step 7: 跑卡片测试**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskCard.test.tsx`
Expected: PASS

- [ ] **Step 8: 跑整体 tasks 前端测试（回归）**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskTableView.test.tsx && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskDetail.test.tsx`（若存在）
Expected: PASS（无既有测试破坏；新按钮只是额外 DOM）

- [ ] **Step 9: Commit**

```bash
git add web/src/components/tasks/TaskBoard.tsx web/src/components/tasks/TaskCard.tsx web/src/components/tasks/TaskDetail.tsx web/src/components/tasks/TaskTableView.tsx web/src/components/tasks/TaskCard.test.tsx
git commit -m "feat(tasks): archive/unarchive actions across board, card, detail, table"
```

---

### Task 8: 前端 typecheck + 后端 typecheck + 全量回归 + 收尾

**Files:** 无（验证）

- [ ] **Step 1: web typecheck**

Run: `cd web && npm run typecheck`
Expected: 0 errors（若 Task 5 改了 `types/app.ts` 但某处 `switch` 穷尽检查出问题 —— 前端没有穷尽检查，`taskStatus.ts` 的 `STATUS_META` 已补全，应通过）

- [ ] **Step 2: backend typecheck**

Run: `cd backend && npm run typecheck`
Expected: 与构建前 baseline 一致或更少（memory: baseline 已有 11 个 pre-existing tsc errors，验收标准「零新增」；确认没有新增错误）

- [ ] **Step 3: 后端全量模块测试**

Run:
```bash
cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/shared/tests/*.test.ts server/modules/tasks/tests/*.test.ts server/modules/database/tests/*.test.ts 2>&1 | tail -8
```
Expected: 全 PASS

- [ ] **Step 4: 前端全量相关测试**

Run:
```bash
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskStatus.test.ts src/components/tasks/taskFilter.test.ts src/components/tasks/TaskCard.test.tsx src/components/tasks/TaskTableView.test.tsx 2>&1 | tail -8
```
Expected: 全 PASS

- [ ] **Step 5: lint 改动文件（确认无新增违规；存量 lint 基线允许）**

Run: `cd backend && npx eslint server/modules/tasks/services/tasks.service.ts server/modules/database/migrations.ts`（可选）
Expected: 无新增 error（存量 baseline 不算）

- [ ] **Step 6: 收尾 —— 更新 spec 状态**

`docs/superpowers/specs/2026-09-04-task-archive-status-design.md` 顶部「状态」行更新为「已实现 <commit>」。

- [ ] **Step 7: Commit 收尾**

```bash
git add docs/superpowers/specs/2026-09-04-task-archive-status-design.md
git commit -m "docs(tasks): mark archive status spec implemented"
```

---

## Self-Review

### Spec 覆盖

- [x] `TASK_STATUSES` + CHECK 迁移 → Task 1/2
- [x] 只有 done 可归档、archived 只回 done → Task 4
- [x] engine 永不写 archived → Task 4
- [x] 归档/取消归档联动 `sessions.isArchived`（项目下隐藏/恢复）→ Task 4（+ spec 已说明查询零改动）
- [x] `completed_at` 不因归档/取消归档被改写 → Task 3
- [x] `createTask`/`moveTask` 拒绝 archived → Task 4
- [x] 前端 `TaskStatus` + `STATUS_META/ORDER` → Task 5
- [x] 看板/表格默认隐藏、`showArchived` 持久化开关 → Task 6/7
- [x] 卡片/详情/表格归档入口 → Task 7
- [x] 错误处理边界（无会话容忍、非 done 拒绝）→ Task 4
- [x] 测试覆盖 → 各任务

### 占位符扫描

- Task 2 中 INSERT 列清单需与 schema 实际列比对（已标注核对动作）。
- Task 4 中 `applyStatusChange` 是否已公开 → 已标注「若未公开则导出」动作。
- Task 3 中「示意骨架」段落已删除不必要内容，最终只保留修正后测试。
- Task 7 Step 6 的 `called` 断言已标注需删除。

### 类型一致性

- 前端 `TaskStatus` 类型（Task 5）与 `taskFilter` / `TaskCard` / `TaskTableView` 用法一致；
- 后端 `TaskStatus` 由 `TASK_STATUSES` 派生，`statusTimestampSets`/`applyStatusChange` 签名不受影响；
- `sessionsDb.updateSessionIsArchived` 已存在于 `sessions.db.ts`（签名 `(sessionId, isArchived)`），Task 4 调用一致。