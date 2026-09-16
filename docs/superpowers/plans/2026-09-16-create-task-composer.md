# 新建任务弹窗改版（Composer + 移动端 + 压缩方式）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 lovdex 新建任务弹窗从「11 字段竖排」改成 sophclaw 的 Composer 形态（大输入框 + 芯片栏 + 更多弹层），补齐 <640px 移动端适配，并落地「压缩方式（摘要/原文）」的后端链路。

**Architecture:** 后端在 `tasks` 表新增 `context_source_session_id`/`context_mode`/`context_status`/`context_raw` 四列，`createTask` 持久化 mode+status，后台压缩服务按 mode 分「摘要(LLM)」/「原文(直接存)」两条路径并写回 status。前端抽 `CreateTaskDialog.tsx`（Composer 布局），新增 `AnchorPopover`（portal+fixed 定位，手机变底部抽屉）与 `ChipSelect`（芯片下拉）两个原语。

**Tech Stack:** Express + better-sqlite3（后端）、React + TS + Vite + Tailwind（前端）、`node:test` 两端测试（`npx tsx --test`，前端组件用 `react-dom/server` `renderToStaticMarkup` 冒烟）。

**测试命令约定：**
- 后端（在 `backend/` 目录）：`npx tsx --tsconfig server/tsconfig.json --test <file>`
- 前端（在 `web/` 目录）：`npx tsx --test <file>`
- 后端 typecheck：`cd backend && npm run typecheck`；前端 typecheck：`cd web && npm run typecheck`
- 提交信息**禁止**加 `Co-Authored-By` 署名行。

---

## 文件结构

后端：
- `backend/server/modules/database/schema.ts` — `TASKS_TABLE_SCHEMA_SQL` 加 4 列
- `backend/server/modules/database/migrations.ts` — `migrateTasksTable` 末尾幂等加列
- `backend/server/modules/database/tests/tasks-context-mode-migration.test.ts` — 新建，迁移测试
- `backend/server/shared/types.ts` — `TaskRow` 加 4 字段
- `backend/server/modules/database/repositories/tasks.db.ts` — `createTask` 写列 + 新增 `writeContextResult`
- `backend/server/modules/database/tests/tasks.db.integration.test.ts` — 追加 db 测试
- `backend/server/modules/tasks/services/tasks.service.ts` — `CreateTaskInput`/校验/`setTaskContextResult`/回调签名
- `backend/server/modules/tasks/tests/tasks.service.test.ts` — 追加服务测试
- `backend/server/modules/tasks/services/task-context.service.ts` — raw/summary 分支 + status
- `backend/server/modules/tasks/tests/task-context.service.test.ts` — 追加压缩测试
- `backend/server/modules/tasks/tasks.routes.ts` — POST 透传 `contextMode`
- `backend/server/index.js` — 接线 `writeResult` + `mode`

前端：
- `web/src/types/app.ts` — `Task` 加 4 字段
- `web/src/components/tasks/AnchorPopover.tsx` — 新建，定位弹层/底部抽屉原语
- `web/src/components/tasks/ChipSelect.tsx` — 新建，芯片下拉
- `web/src/components/tasks/CreateTaskDialog.tsx` — 新建，Composer 弹窗
- `web/src/components/tasks/CreateTaskDialog.test.tsx` — 新建，冒烟 + 纯函数测试
- `web/src/components/tasks/TaskBoard.tsx` — 删内联弹窗 + 挂载新组件

---

## Task 1: tasks 表加 4 列（schema + 迁移）

**Files:**
- Modify: `backend/server/modules/database/schema.ts:162-192`
- Modify: `backend/server/modules/database/migrations.ts:427-674`（`migrateTasksTable` 末尾）
- Test: `backend/server/modules/database/tests/tasks-context-mode-migration.test.ts`

- [ ] **Step 1: 改 schema**

在 `schema.ts` 的 `TASKS_TABLE_SCHEMA_SQL` 里，把 `context_summary` 与 `source_schedule_id` 之间的两行改成：

```ts
    remark            TEXT,
    context_summary   TEXT,
    context_source_session_id TEXT,
    context_mode      TEXT NOT NULL DEFAULT 'none'
                      CHECK (context_mode IN ('none','summary','raw')),
    context_status    TEXT
                      CHECK (context_status IS NULL OR context_status IN ('pending','ready','failed')),
    context_raw       TEXT,
    source_schedule_id TEXT
);
```

（即：`context_summary` 行之后、`source_schedule_id` 行之前插入 4 行。原 `context_summary   TEXT,` 与 `source_schedule_id TEXT` 两行之间。）

- [ ] **Step 2: 改迁移**

在 `migrations.ts` 的 `migrateTasksTable` 函数**最末尾**（`archived` rebuild 门之后、函数右花括号之前）追加：

```ts
  // Context-source compression modes (spec 2026-09-16): persist the source
  // session id + mode + async status + raw product alongside context_summary.
  // Added in place via ALTER at the very end so every legacy rebuild gate above
  // (which recreates `tasks` from TASKS_TABLE_SCHEMA_SQL) can't drop these
  // columns; a fresh DB already has them via TASKS_TABLE_SCHEMA_SQL.
  const contextTaskColumns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((column) => column.name);
  addColumnToTableIfNotExists(db, 'tasks', contextTaskColumns, 'context_source_session_id', 'TEXT');
  addColumnToTableIfNotExists(db, 'tasks', contextTaskColumns, 'context_mode', "TEXT NOT NULL DEFAULT 'none' CHECK (context_mode IN ('none','summary','raw'))");
  addColumnToTableIfNotExists(db, 'tasks', contextTaskColumns, 'context_status', "TEXT CHECK (context_status IS NULL OR context_status IN ('pending','ready','failed'))");
  addColumnToTableIfNotExists(db, 'tasks', contextTaskColumns, 'context_raw', 'TEXT');
```

- [ ] **Step 3: 写迁移测试**

新建 `backend/server/modules/database/tests/tasks-context-mode-migration.test.ts`：

```ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

// 当前生产 schema，唯独缺 4 个 context 新列（context_summary 已存在）。
// 所有 rebuild 门都不触发，唯一加列机制是末尾的 addColumnToTableIfNotExists(ALTER)。
const CURRENT_SHAPE_WITHOUT_CONTEXT_MODE_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','in_review','done','archived')),
    executor_provider TEXT NOT NULL DEFAULT 'claude'
                      CHECK (executor_provider IN ('claude','codex','opencode','qoder')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary       TEXT,
    sub_status       TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked','waiting_answer','waiting_plan')),
    verdict_reason   TEXT,
    verdict_at       DATETIME,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    deadline          TEXT,
    is_operator       INTEGER DEFAULT 0,
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
    remark            TEXT,
    context_summary   TEXT,
    source_schedule_id TEXT
);
`;

function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
}

test('context_mode/status/raw + source session columns added in place via ALTER', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ctx-mode-'));
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
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.exec(CURRENT_SHAPE_WITHOUT_CONTEXT_MODE_DDL);
  legacy.prepare(`INSERT INTO tasks (task_id, project_path, title) VALUES (?, ?, ?)`).run('t1', '/tmp/example-repo', 'task');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = columnNames(db);
    for (const col of ['context_source_session_id', 'context_mode', 'context_status', 'context_raw']) {
      assert.ok(cols.includes(col), `expected ${col} column to be added in place`);
    }
    // 4 个新列由 ALTER 追加 → 全部排在 source_schedule_id 之后（rebuild 会按 schema 排到 context_summary 之后）。
    assert.ok(
      cols.indexOf('source_schedule_id') < cols.indexOf('context_source_session_id'),
      'expected context columns appended after source_schedule_id (in-place ALTER)',
    );
    const row = db.prepare('SELECT context_mode, context_status, context_source_session_id, context_raw FROM tasks WHERE task_id = ?').get('t1') as {
      context_mode: string; context_status: string | null; context_source_session_id: string | null; context_raw: string | null;
    };
    assert.equal(row.context_mode, 'none');
    assert.equal(row.context_status, null);
    assert.equal(row.context_source_session_id, null);
    assert.equal(row.context_raw, null);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: 跑测试（先失败）**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks-context-mode-migration.test.ts`
Expected: FAIL — `expected context_source_session_id column to be added in place`（列还不存在，因为 Step 1/2 尚未生效时先写测试则失败；若 Step 1/2 已改则此步 PASS，可跳到 Step 6）。

- [ ] **Step 5: 确认 Step 1/2 已改后跑测试通过**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks-context-mode-migration.test.ts`
Expected: PASS（`# pass 1`）。

- [ ] **Step 6: typecheck**

Run: `cd backend && npm run typecheck`
Expected: 与 baseline 持平（新列不影响既有类型；若新增报错则修复）。

- [ ] **Step 7: Commit**

```bash
git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts backend/server/modules/database/tests/tasks-context-mode-migration.test.ts
git commit -m "feat(tasks): add context_mode/status/raw columns for source-session compression"
```

---

## Task 2: TaskRow 类型 + tasksDb 写列 + writeContextResult

**Files:**
- Modify: `backend/server/shared/types.ts:927-983`（`TaskRow`）
- Modify: `backend/server/modules/database/repositories/tasks.db.ts:74-118`（`createTask`）、`:270-273`（新增方法）
- Test: `backend/server/modules/database/tests/tasks.db.integration.test.ts`

- [ ] **Step 1: 改 TaskRow**

在 `types.ts` 的 `TaskRow` 里，`context_summary: string | null;`（约 959 行）之后加：

```ts
  /** 上下文来源会话 id（新建任务时的参考历史，可选）。 */
  context_source_session_id: string | null;
  /** 上下文处理方式：none=无 / summary=摘要 / raw=原文。 */
  context_mode: 'none' | 'summary' | 'raw';
  /** 异步产物状态：pending / ready / failed；none 模式下为 NULL。 */
  context_status: 'pending' | 'ready' | 'failed' | null;
  /** raw 模式就绪后的原始转录文本。 */
  context_raw: string | null;
```

- [ ] **Step 2: 改 tasksDb.createTask**

在 `tasks.db.ts` 的 `createTask` input 类型（约 74-88 行）加：

```ts
    sourceScheduleId?: string | null;
    contextSourceSessionId?: string | null;
    contextMode?: 'none' | 'summary' | 'raw';
    contextStatus?: 'pending' | 'ready' | 'failed' | null;
```

把 INSERT 语句（约 96-99 行）改成：

```ts
    const row = db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, priority, deadline, is_operator, label, remark, context_source_session_id, context_mode, context_status, source_schedule_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${startedAtSet}, ${completedAtSet}, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.contextSourceSessionId ?? null,
      input.contextMode ?? 'none',
      input.contextStatus ?? null,
      input.sourceScheduleId ?? null,
    ) as TaskRow;
```

- [ ] **Step 3: 新增 tasksDb.writeContextResult**

在 `tasks.db.ts` 的 `updateTaskContextSummary`（约 270-273 行）之后加：

```ts
  /**
   * Persist the async context-compression outcome for a task: the status
   * (ready/failed) and exactly one product (summary for summary mode, raw for
   * raw mode). Overwrites both product columns each call — a task has a single
   * mode, so the other column stays null. Broadcast responsibility lives in the
   * service layer, not here.
   */
  writeContextResult(taskId: string, result: { status: 'ready' | 'failed'; summary?: string | null; raw?: string | null }): void {
    const db = getConnection();
    db.prepare(`
      UPDATE tasks
      SET context_status = ?, context_summary = ?, context_raw = ?, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(result.status, result.summary ?? null, result.raw ?? null, taskId);
  },
```

- [ ] **Step 4: 追加 db 集成测试**

在 `tasks.db.integration.test.ts` 末尾加：

```ts
test('createTask persists context columns with defaults', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const plain = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' });
    assert.equal(plain.context_source_session_id, null);
    assert.equal(plain.context_mode, 'none');
    assert.equal(plain.context_status, null);
    assert.equal(plain.context_raw, null);

    const withCtx = tasksDb.createTask({
      projectPath: '/p',
      title: 'ctx',
      executorProvider: 'claude',
      contextSourceSessionId: 's-1',
      contextMode: 'summary',
      contextStatus: 'pending',
    });
    assert.equal(withCtx.context_source_session_id, 's-1');
    assert.equal(withCtx.context_mode, 'summary');
    assert.equal(withCtx.context_status, 'pending');
    assert.equal(tasksDb.getTask(withCtx.task_id)?.context_source_session_id, 's-1');
  });
});

test('writeContextResult writes status + product and getTask round-trips', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/p');
    const summary = tasksDb.createTask({ projectPath: '/p', title: 's', executorProvider: 'claude', contextSourceSessionId: 's-1', contextMode: 'summary', contextStatus: 'pending' });
    tasksDb.writeContextResult(summary.task_id, { status: 'ready', summary: '压缩摘要' });
    const reloadedSummary = tasksDb.getTask(summary.task_id)!;
    assert.equal(reloadedSummary.context_status, 'ready');
    assert.equal(reloadedSummary.context_summary, '压缩摘要');
    assert.equal(reloadedSummary.context_raw, null);

    const raw = tasksDb.createTask({ projectPath: '/p', title: 'r', executorProvider: 'claude', contextSourceSessionId: 's-1', contextMode: 'raw', contextStatus: 'pending' });
    tasksDb.writeContextResult(raw.task_id, { status: 'failed' });
    const reloadedRaw = tasksDb.getTask(raw.task_id)!;
    assert.equal(reloadedRaw.context_status, 'failed');
    assert.equal(reloadedRaw.context_raw, null);
    assert.equal(reloadedRaw.context_summary, null);
  });
});
```

- [ ] **Step 5: 跑测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/tasks.db.integration.test.ts`
Expected: PASS（含新增 2 个用例）。

- [ ] **Step 6: Commit**

```bash
git add backend/server/shared/types.ts backend/server/modules/database/repositories/tasks.db.ts backend/server/modules/database/tests/tasks.db.integration.test.ts
git commit -m "feat(tasks): persist context source/mode/status/raw columns in tasks db"
```

---

## Task 3: tasks.service 校验 + setTaskContextResult

**Files:**
- Modify: `backend/server/modules/tasks/services/tasks.service.ts:40-77`、`:127`、`:251-333`、`:335-342`
- Test: `backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: TaskDbLike 加 writeContextResult**

在 `TaskDbLike` 的 Pick 列表（约 53-54 行 `'writeSummary'` / `'updateTaskContextSummary'`）把 `'updateTaskContextSummary'` 替换为 `'writeContextResult'`：

```ts
  | 'writeSummary'
  | 'writeContextResult'
>;
```

- [ ] **Step 2: CreateTaskInput 加 contextMode**

在 `CreateTaskInput`（约 70-76 行 `sourceSessionId` 之后）加：

```ts
  /** 上下文处理方式；缺省时按「有来源→summary，无来源→none」推导。 */
  contextMode?: 'none' | 'summary' | 'raw';
```

- [ ] **Step 3: 回调签名加 mode**

把 `onContextSourceProvided`（约 127 行）改成：

```ts
    onContextSourceProvided?: (taskId: string, sourceSessionId: string, mode: 'summary' | 'raw') => void;
```

- [ ] **Step 4: 加 isContextMode 校验函数**

在文件顶部（`CreateTaskInput` 定义附近）加：

```ts
const CONTEXT_MODES = ['none', 'summary', 'raw'] as const;
type ContextMode = (typeof CONTEXT_MODES)[number];

function isContextMode(value: unknown): value is ContextMode {
  return typeof value === 'string' && (CONTEXT_MODES as readonly string[]).includes(value);
}
```

- [ ] **Step 5: createTask 校验 + 持久化 + 回调**

把 `createTask` 里现有的 `sourceSessionId` 校验块（约 302-312 行，注释「sourceSessionId: 来源会话仅作参考历史…」起）替换为：

```ts
      // 上下文来源与处理方式：mode==='none' 忽略来源、5 个 context 列全 NULL；
      // mode!=='none' 要求来源存在且归属本项目。缺省 mode 时按「有来源→summary」推导，
      // 保持既有 sourceSessionId 调用方（ConvertToTaskDialog / 定时任务）行为不变。
      const rawContextMode = input.contextMode ?? (input.sourceSessionId != null ? 'summary' : 'none');
      if (!isContextMode(rawContextMode)) {
        throw new AppError(`invalid contextMode: ${String(input.contextMode)}`, { code: 'INVALID_CONTEXT_MODE', statusCode: 400 });
      }
      const contextMode: ContextMode = rawContextMode;
      const contextSourceSessionId = contextMode === 'none' ? null : (input.sourceSessionId ?? null);
      if (contextSourceSessionId != null) {
        const srcSession = resolveSession(contextSourceSessionId);
        if (!srcSession) {
          throw new AppError(`session not found: ${contextSourceSessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        }
        if (normalizeProjectPath(srcSession.project_path ?? '') !== normalizeProjectPath(input.projectPath)) {
          throw new AppError('session does not belong to this project', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 409 });
        }
      }
```

把 `row = resolveDb.createTask({...})`（约 313-327 行）加 3 个字段，`sourceScheduleId` 行之后加：

```ts
        sourceScheduleId: input.sourceScheduleId ?? null,
        contextSourceSessionId,
        contextMode,
        contextStatus: contextMode === 'none' ? null : 'pending',
```

把 `emit` 之后（约 329-331 行）的：

```ts
      if (input.sourceSessionId != null) {
        opts.onContextSourceProvided?.(row.task_id, input.sourceSessionId);
      }
```

替换为：

```ts
      if (contextSourceSessionId != null) {
        opts.onContextSourceProvided?.(row.task_id, contextSourceSessionId, contextMode);
      }
```

- [ ] **Step 6: setTaskContextSummary → setTaskContextResult**

把 `setTaskContextSummary`（约 335-342 行）整体替换为：

```ts
    setTaskContextResult(taskId: string, result: { status: 'ready' | 'failed'; summary?: string | null; raw?: string | null }): TaskRow | null {
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      resolveDb.writeContextResult(taskId, result);
      const updated = resolveDb.getTask(taskId) ?? row;
      emit({ kind: 'task_upserted', task: updated, actor: 'engine' });
      return decorate(updated);
    },
```

- [ ] **Step 7: 更新服务测试**

`tasks.service.test.ts` 的测试工厂是 `makeDbStub()`（返回 `{ db, … }`）、`makeProjectStub(path)`、`makeSessionsStub(list)`；`onContextSourceProvided` 作为 **opts 顶层字段**传入（不在 `deps` 里），见 835-890 行既有用例。按此调整：

把 `StoredTask` 类型（约 21-33 行）里的 `context_summary: string | null;` 之后加：

```ts
  context_source_session_id: string | null;
  context_mode: 'none' | 'summary' | 'raw';
  context_status: 'pending' | 'ready' | 'failed' | null;
  context_raw: string | null;
```

在 `tasks.set('t1', {...})`（约 22-33 行）里 `context_summary: null,` 之后加：

```ts
    context_source_session_id: null,
    context_mode: 'none',
    context_status: null,
    context_raw: null,
```

把 `makeDbStub` 里 `createTask` stub 的返回对象（约 57 行 `context_summary: null,` 附近）改成**蛇形映射**（与真实 db 一致），在 `context_summary: null,` 之后加：

```ts
      context_source_session_id: input.contextSourceSessionId ?? null,
      context_mode: input.contextMode ?? 'none',
      context_status: input.contextStatus ?? null,
      context_raw: null,
```

（`input` 是 `createTask` 入参，已 `...input` 展开——此处显式加蛇形键覆盖，保证断言用蛇形名。）

把 stub 里 `updateTaskContextSummary`（若有）替换为：

```ts
    writeContextResult: (_id: string, _result: { status: 'ready' | 'failed'; summary?: string | null; raw?: string | null }) => {},
```

然后在文件末尾追加测试（`broadcast: () => {}` 即可）：

```ts
test('createTask persists context_mode/status and fires onContextSourceProvided with mode', () => {
  const hooks: Array<[string, string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([{ id: 's-1', project_path: '/p' }]) },
    onContextSourceProvided: (taskId, sourceSessionId, mode) => hooks.push([taskId, sourceSessionId, mode]),
  });
  const row = svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 's-1', contextMode: 'raw' });
  assert.equal((row as { context_mode: string }).context_mode, 'raw');
  assert.equal((row as { context_status: string | null }).context_status, 'pending');
  assert.equal((row as { context_source_session_id: string | null }).context_source_session_id, 's-1');
  assert.deepEqual(hooks, [['t1', 's-1', 'raw']]);
});

test('createTask defaults contextMode to summary when only sourceSessionId given', () => {
  const hooks: Array<[string, string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([{ id: 's-1', project_path: '/p' }]) },
    onContextSourceProvided: (taskId, sourceSessionId, mode) => hooks.push([taskId, sourceSessionId, mode]),
  });
  const row = svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 's-1' });
  assert.equal((row as { context_mode: string }).context_mode, 'summary');
  assert.equal((row as { context_status: string | null }).context_status, 'pending');
  assert.deepEqual(hooks, [['t1', 's-1', 'summary']]);
});

test('createTask rejects invalid contextMode', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p') },
  });
  assert.throws(
    () => svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', contextMode: 'bogus' as never }),
    /invalid contextMode/,
  );
});

test('createTask with contextMode=none ignores sourceSessionId', () => {
  const hooks: Array<[string, string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([{ id: 's-1', project_path: '/p' }]) },
    onContextSourceProvided: (taskId, sourceSessionId, mode) => hooks.push([taskId, sourceSessionId, mode]),
  });
  const row = svc.createTask({ title: 't', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 's-1', contextMode: 'none' });
  assert.equal((row as { context_mode: string }).context_mode, 'none');
  assert.equal((row as { context_status: string | null }).context_status, null);
  assert.equal((row as { context_source_session_id: string | null }).context_source_session_id, null);
  assert.deepEqual(hooks, []);
});
```

- [ ] **Step 7b: 把既有 setTaskContextSummary 用例改为 setTaskContextResult**

892-909 行两个 `setTaskContextSummary` 用例改为 `setTaskContextResult`：

```ts
test('setTaskContextResult persists, broadcasts engine task_upserted and returns decorated row', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const updated = svc.setTaskContextResult('t1', { status: 'ready', summary: '## 背景\n先前决策 A' });
  assert.equal((updated as { context_summary: string | null; context_status: string | null }).context_summary, '## 背景\n先前决策 A');
  assert.equal((updated as { context_status: string | null }).context_status, 'ready');
  assert.equal((db.getTask('t1') as { context_summary: string | null }).context_summary, '## 背景\n先前决策 A');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'engine');
});

test('setTaskContextResult for a missing task returns null and does not broadcast', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub().db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.setTaskContextResult('nope', { status: 'failed' }), null);
  assert.equal(events.length, 0);
});
```

> 注意：`setTaskContextResult` 会调用 stub 的 `writeContextResult`；上面 Step 7 已在 stub 里加了该方法，测试才会通过。

- [ ] **Step 8: 跑测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: PASS（含新增用例）。

- [ ] **Step 9: Commit**

```bash
git add backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): validate contextMode and write context result in tasks service"
```

---

## Task 4: task-context 服务 raw/summary + status

**Files:**
- Modify: `backend/server/modules/tasks/services/task-context.service.ts`
- Test: `backend/server/modules/tasks/tests/task-context.service.test.ts`

- [ ] **Step 1: 改 deps 与 args**

把 `TaskContextCompressionDeps`（约 21-25 行）与 `TaskContextCompressionArgs`（约 27-33 行）改成：

```ts
export type TaskContextResult = { status: 'ready' | 'failed'; summary?: string; raw?: string };

export type TaskContextCompressionDeps = {
  fetchHistory: (sessionId: string, opts?: { limit?: number; offset?: number }) => Promise<{ messages?: unknown[] }>;
  runOneShot: (args: { prompt: string; systemPrompt: string; model?: string }) => Promise<string | null>;
  writeResult: (taskId: string, result: TaskContextResult) => void;
};

export type TaskContextCompressionArgs = {
  sourceSessionId: string;
  taskId: string;
  title: string;
  mode: 'summary' | 'raw';
  deps: TaskContextCompressionDeps;
  onError?: (error: unknown) => void;
};
```

在常量区（约 38-41 行）加：

```ts
/** Upper bound on the raw transcript stored verbatim for raw mode (~200k chars). */
const MAX_RAW_CHARS = 200_000;
```

- [ ] **Step 2: 改 runTaskContextCompression**

把 `runTaskContextCompression`（约 119-151 行）整体替换为：

```ts
export async function runTaskContextCompression(args: TaskContextCompressionArgs): Promise<void> {
  const { sourceSessionId, taskId, title, mode, deps, onError } = args;
  const fail = (e?: unknown) => {
    if (e !== undefined) reportError(onError, e);
    try {
      deps.writeResult(taskId, { status: 'failed' });
    } catch {
      // writeResult 自身抛错时吞掉，避免级联
    }
  };
  let transcript = '';
  try {
    const first = await deps.fetchHistory(sourceSessionId, { limit: MAX_MESSAGES, offset: 0 });
    const messages = Array.isArray(first?.messages) ? first.messages : [];
    transcript = compactTranscriptToText(messages);
  } catch (e) {
    fail(e); // 读不到 transcript => 置 failed，不写产物
    return;
  }

  // raw：不调 LLM，直接把精简转录截断后存 context_raw。
  if (mode === 'raw') {
    deps.writeResult(taskId, { status: 'ready', raw: transcript.slice(0, MAX_RAW_CHARS) });
    return;
  }

  // summary：截断到 token 预算内，走 LLM 压缩。
  transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  let summary: string | null = null;
  try {
    summary = await withTimeout(
      deps.runOneShot({
        prompt: buildPrompt(title, transcript),
        systemPrompt: CONTEXT_SYSTEM_PROMPT,
      }),
      RUN_TIMEOUT_MS,
    );
  } catch (e) {
    reportError(onError, e);
  }
  if (summary) {
    deps.writeResult(taskId, { status: 'ready', summary });
  } else {
    fail(); // 超时/空结果 => failed
  }
}
```

`scheduleTaskContextCompression`（约 154-161 行）无需改动（它整体透传 `args`，`mode` 已含在 args 内）。

- [ ] **Step 3: 更新压缩测试**

`task-context.service.test.ts` 里把 deps 的 `writeBack` 全部改名 `writeResult`，并按新签名传 `{ status, summary/raw }`。既有 4 个用例（19-114 行）逐一改：

1. `runTaskContextCompression reads transcript, compresses, writes back`：args 加 `mode: 'summary'`，断言 `writeResult` 被以 `{ status: 'ready', summary: 'S' }` 调用。
2. `does not write back when runOneShot returns null`：args 加 `mode: 'summary'`，断言 `writeResult` 被以 `{ status: 'failed' }` 调用。
3. `swallows transcript read errors`：args 加 `mode: 'summary'`，断言 `writeResult` 被以 `{ status: 'failed' }` 调用且 `onError` 收到错误。
4. `scheduleTaskContextCompression dedupes…`：deps 加 `mode`/`writeResult` 桩。

追加两个新用例：

```ts
test('raw mode writes transcript verbatim (no LLM) and never calls runOneShot', async () => {
  let written: { taskId: string; result: { status: string; raw?: string } } | null = null;
  let calledRunOneShot = false;
  await runTaskContextCompression({
    sourceSessionId: 's',
    taskId: 't',
    title: 'x',
    mode: 'raw',
    deps: {
      fetchHistory: async () => ({ messages: [{ role: 'user', content: 'hello raw' }] }),
      runOneShot: async () => { calledRunOneShot = true; return 'S'; },
      writeResult: (tid, result) => { written = { taskId: tid, result: result as { status: string; raw?: string } }; },
    },
  });
  assert.equal(calledRunOneShot, false);
  assert.equal(written?.taskId, 't');
  assert.equal(written?.result.status, 'ready');
  assert.ok(written?.result.raw?.includes('hello raw'));
});

test('summary mode success writes status ready + summary', async () => {
  let written: { taskId: string; result: { status: string; summary?: string } } | null = null;
  await runTaskContextCompression({
    sourceSessionId: 's',
    taskId: 't',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: [{ role: 'user', content: 'hello' }] }),
      runOneShot: async () => '压缩结果',
      writeResult: (tid, result) => { written = { taskId: tid, result: result as { status: string; summary?: string } }; },
    },
  });
  assert.equal(written?.taskId, 't');
  assert.equal(written?.result.status, 'ready');
  assert.equal(written?.result.summary, '压缩结果');
});
```

- [ ] **Step 4: 跑测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/task-context.service.test.ts`
Expected: PASS（含新增 2 用例）。

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/tasks/services/task-context.service.ts backend/server/modules/tasks/tests/task-context.service.test.ts
git commit -m "feat(tasks): support raw and summary context modes with status writeback"
```

---

## Task 5: routes 透传 + index.js 接线

**Files:**
- Modify: `backend/server/modules/tasks/tasks.routes.ts:36-51`
- Modify: `backend/server/index.js:471-484`

- [ ] **Step 1: routes 加 contextMode**

在 `tasks.routes.ts` POST 的 `createTask({...})`（约 36-51 行）里，`sourceSessionId` 行之后加：

```ts
        contextMode: body.contextMode as 'none' | 'summary' | 'raw' | undefined,
```

- [ ] **Step 2: index.js 接线**

把 `index.js` 的 `onContextSourceProvided`（约 471-484 行）改成：

```js
    onContextSourceProvided: (taskId, sourceSessionId, mode) => {
        scheduleTaskContextCompression({
            taskId,
            sourceSessionId,
            mode,
            title: tasksService.getTask(taskId)?.title ?? '',
            deps: {
                fetchHistory: sessionsService.fetchHistory.bind(sessionsService),
                runOneShot: runOneShotClaudeText,
                writeResult: (tid, result) => tasksService.setTaskContextResult(tid, result),
            },
            onError: (e) =>
                console.error('[task-context] compression failed', { taskId, sourceSessionId, mode }, e),
        });
    },
```

- [ ] **Step 3: typecheck**

Run: `cd backend && npm run typecheck`
Expected: 与 baseline 持平。若报 `setTaskContextSummary` 引用残留，逐处改为 `setTaskContextResult`。

- [ ] **Step 4: 全量后端相关测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts server/modules/tasks/tests/task-context.service.test.ts server/modules/database/tests/tasks.db.integration.test.ts server/modules/database/tests/tasks-context-mode-migration.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/tasks/tasks.routes.ts backend/server/index.js
git commit -m "feat(tasks): wire contextMode through routes and compression DI"
```

---

## Task 6: 前端 Task 类型加 4 字段

**Files:**
- Modify: `web/src/types/app.ts:101-154`（`Task` 接口）

- [ ] **Step 1: 加字段**

在 `Task` 接口里 `context_summary: string | null;`（约 127 行）之后加：

```ts
  /** 上下文来源会话 id（新建任务时选的参考历史）。 */
  context_source_session_id: string | null;
  /** 上下文处理方式：none / summary / raw。 */
  context_mode: 'none' | 'summary' | 'raw';
  /** 异步产物状态：pending / ready / failed；none 模式下为 null。 */
  context_status: 'pending' | 'ready' | 'failed' | null;
  /** raw 模式就绪后的原始转录文本。 */
  context_raw: string | null;
```

- [ ] **Step 2: typecheck**

Run: `cd web && npm run typecheck`
Expected: 与 baseline 持平（新增可选消费处不会报错）。

- [ ] **Step 3: Commit**

```bash
git add web/src/types/app.ts
git commit -m "feat(tasks): add context_mode/status/raw fields to frontend Task type"
```

---

## Task 7: AnchorPopover + ChipSelect 原语

**Files:**
- Create: `web/src/components/tasks/AnchorPopover.tsx`
- Create: `web/src/components/tasks/ChipSelect.tsx`

- [ ] **Step 1: 写 AnchorPopover**

新建 `web/src/components/tasks/AnchorPopover.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../lib/utils';

/**
 * 贴锚点定位的弹层原语。为什么必须 portal + fixed：DialogContent 带
 * -translate-1/2 变换 + 入场动画，普通 absolute 弹层会被裁剪/困在含变换的
 * 容器里（sophclaw 的 task-chip-menu 同款坑）。
 * 桌面 = 贴锚点下方的 fixed 弹层；手机(isMobile) = 底部抽屉。
 */
export function AnchorPopover({
  open,
  onOpenChange,
  anchorRef,
  align = 'left',
  isMobile,
  children,
  ariaLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  isMobile: boolean;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; right: number } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // 打开时按锚点 getBoundingClientRect 计算固定坐标。
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left, right: r.right });
  }, [open, anchorRef]);

  // 外点 / Esc / 滚动关闭（滚动发生在弹层内部时不关）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onKey as unknown as EventListener);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onKey as unknown as EventListener);
    };
  }, [open, anchorRef, onOpenChange]);

  if (!open || !pos) return null;

  return createPortal(
    isMobile ? (
      <div className="fixed inset-0 z-[60]" aria-modal="false">
        <div className="absolute inset-0 bg-black/30" onClick={() => onOpenChange(false)} aria-hidden />
        <div
          ref={popRef}
          role="dialog"
          aria-label={ariaLabel}
          className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-border bg-popover p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,0.2)]"
        >
          {children}
        </div>
      </div>
    ) : (
      <div
        ref={popRef}
        role="dialog"
        aria-label={ariaLabel}
        style={{ top: pos.top, left: align === 'left' ? pos.left : undefined, right: align === 'right' ? undefined : undefined, maxWidth: 'min(440px, calc(100vw - 24px))' }}
        className={cn('fixed z-[60] min-w-[200px] rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_8px_26px_rgba(0,0,0,0.14)]', align === 'right' && 'translate-x-[calc(-100%)]')}
      >
        {children}
      </div>,
    ),
    document.body,
  );
}
```

> 注：`align='right'` 的精确右对齐用「锚点左缘 + 弹层自身宽度」换算，实现时若上面的 `translate-x-[-100%]` 与 `left` 组合有偏差，用 `left: pos.left` + `transform: translateX(calc(-100% + (pos.right - pos.left)))` 让弹层右缘贴锚点右缘。

- [ ] **Step 2: 写 ChipSelect**

新建 `web/src/components/tasks/ChipSelect.tsx`：

```tsx
import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';
import { AnchorPopover } from './AnchorPopover';

export type ChipSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  hint?: string; // 行内右侧辅助文字（如远端主机名）
};

/**
 * 胶囊芯片 + 弹层单选。label 显示当前选中项；disabled 时整个芯片灰置。
 */
export function ChipSelect({
  label,
  options,
  value,
  onChange,
  disabled,
  isMobile,
  ariaLabel,
}: {
  label: string;
  options: ChipSelectOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  isMobile: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 items-center gap-1 rounded-full border border-border/80 bg-card px-3 text-sm text-foreground transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <span className="max-w-[190px] truncate">{current?.label ?? label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      <AnchorPopover open={open} onOpenChange={setOpen} anchorRef={anchorRef} isMobile={isMobile} ariaLabel={ariaLabel ?? label}>
        <div className="flex flex-col">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={o.disabled}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                'flex items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                'hover:bg-accent focus-visible:outline-none',
                o.disabled ? 'cursor-not-allowed opacity-50' : '',
                o.value === value ? 'bg-accent font-medium' : '',
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
            </button>
          ))}
        </div>
      </AnchorPopover>
    </>
  );
}
```

- [ ] **Step 3: typecheck**

Run: `cd web && npm run typecheck`
Expected: PASS（无新错）。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/tasks/AnchorPopover.tsx web/src/components/tasks/ChipSelect.tsx
git commit -m "feat(tasks): add AnchorPopover and ChipSelect primitives for composer"
```

---

## Task 8: CreateTaskDialog 组件（Composer）

**Files:**
- Create: `web/src/components/tasks/CreateTaskDialog.tsx`

本组件 = 把 TaskBoard.tsx 的创建表单状态/数据加载/createTask 逻辑迁入 + 新的 Composer JSX。

- [ ] **Step 1: 写组件**

新建 `web/src/components/tasks/CreateTaskDialog.tsx`：

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, RotateCcw } from 'lucide-react';

import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { cn } from '../../lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import type { Project, ProviderModelOption, Task, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';
import { api, authenticatedFetch } from '../../utils/api';
import { resolveSessionTitle } from '../../utils/sessionTitle';
import { deriveTaskName } from './taskName';
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects, taskProjectLabel } from './projectOptions';
import { useTaskEngineAvailability } from './useTaskEngineAvailability';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
import { AnchorPopover } from './AnchorPopover';
import { ChipSelect, type ChipSelectOption } from './ChipSelect';

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: { models?: { OPTIONS?: ProviderModelOption[]; DEFAULT?: string } };
};

/** 「更多…」角标：名称/上下文来源/备注 中已填的数量。 */
export function moreSetCount(name: string, sourceSessionId: string, remark: string): number {
  return [name.trim(), sourceSessionId, remark.trim()].filter((v) => v !== '').length;
}

export function CreateTaskDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 640 });

  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [engine, setEngine] = useState<TaskEngine>('claude');
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [deadline, setDeadline] = useState('');
  const [label, setLabel] = useState<TaskLabel>('other');
  const [remark, setRemark] = useState('');
  const [sourceSessionId, setSourceSessionId] = useState('');
  const [contextMode, setContextMode] = useState<'summary' | 'raw'>('summary');
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const modelsRequestRef = useRef(0);

  const isAssistant = projectPath === ASSISTANT_OPTION_VALUE || !projectPath;

  const duplicateProjectNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of taskFormProjects(projects)) {
      const n = project.displayName || projectPathOf(project);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return new Set(Array.from(counts.entries()).filter(([, c]) => c > 1).map(([n]) => n));
  }, [projects]);

  const newProjectRecord = useMemo(
    () => taskFormProjects(projects).find((p) => projectPathOf(p) === projectPath) ?? null,
    [projects, projectPath],
  );
  const sourceSessionOptions = useMemo(() => {
    if (!newProjectRecord) return [];
    return [...(newProjectRecord.sessions ?? [])]
      .sort((a, b) => {
        const at = new Date(a.updated_at || a.lastActivity || 0).getTime();
        const bt = new Date(b.updated_at || b.lastActivity || 0).getTime();
        return bt - at;
      })
      .filter((s) => s.id);
  }, [newProjectRecord]);

  const newEngineAvailability = useTaskEngineAvailability(
    newProjectRecord ? { value: projectPathOf(newProjectRecord), remoteHostId: newProjectRecord.remoteHostId ?? null } : null,
    projectPath === ASSISTANT_OPTION_VALUE,
  );

  useEffect(() => {
    if (newEngineAvailability.status !== 'ready') return;
    if (newEngineAvailability.options.length === 0) return;
    if (!newEngineAvailability.options.includes(engine)) setEngine(newEngineAvailability.options[0]);
  }, [newEngineAvailability, engine]);

  // 首次打开时加载项目列表（沿用 TaskBoard 的 /api/projects 加载逻辑）。
  useEffect(() => {
    let cancelled = false;
    api.projects()
      .then(async (res) => {
        if (!res.ok) return [];
        const data = (await res.json()) as Project[];
        return Array.isArray(data) ? data : [];
      })
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const formProjects = taskFormProjects(list);
        setProjectPath(formProjects.length > 0 ? projectPathOf(formProjects[0]) : ASSISTANT_OPTION_VALUE);
      })
      .catch((err) => console.error('load projects for task create failed', err));
    return () => { cancelled = true; };
  }, []);

  // 模型随引擎重载（沿用 TaskBoard 的 stale-response 守卫）。
  useEffect(() => {
    if (!open) return;
    const requestId = modelsRequestRef.current + 1;
    modelsRequestRef.current = requestId;
    const eng = engine;
    authenticatedFetch(`/api/providers/${eng}/models`)
      .then(async (res) => {
        if (!res.ok) return [] as ProviderModelOption[];
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .then((list) => {
        if (modelsRequestRef.current !== requestId) return;
        setModels(list);
        setModel(list.length > 0 ? list[0].value : '');
      })
      .catch((err) => {
        if (modelsRequestRef.current !== requestId) return;
        console.error('load models for task create failed', err);
        setModels([]);
        setModel('');
      });
  }, [open, engine]);

  function reset() {
    setPrompt('');
    setName('');
    setPriority('P2');
    setDeadline('');
    setLabel('other');
    setRemark('');
    setSourceSessionId('');
    setContextMode('summary');
    setError('');
  }

  async function submit() {
    const p = prompt.trim();
    if (!p) return;
    if (!isAssistant && newEngineAvailability.status === 'unavailable') {
      window.alert(newEngineAvailability.hint);
      return;
    }
    const title = name.trim() || deriveTaskName(p);
    try {
      const res = await api.tasks.create({
        projectPath: isAssistant ? '' : projectPath,
        title,
        description: p,
        executorProvider: isAssistant ? 'claude' : engine,
        executorModel: isAssistant ? null : model || null,
        status: 'todo',
        priority,
        deadline: deadline || null,
        isOperator: isAssistant,
        label,
        remark: remark.trim() || null,
        sourceSessionId: sourceSessionId || undefined,
        contextMode: sourceSessionId ? contextMode : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message ?? '创建失败');
        return;
      }
      const created = (await res.json()) as Task;
      reset();
      onCreated(created);
    } catch (err) {
      console.error('createTask failed', err);
      setError('创建失败');
    }
  }

  const projectOptions: ChipSelectOption[] = [
    { value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' },
    ...taskFormProjects(projects).map((p) => ({
      value: projectPathOf(p),
      label: taskProjectLabel(p, duplicateProjectNames),
      hint: p.remoteHostName,
    })),
  ];
  const priorityOptions: ChipSelectOption[] = PRIORITY_ORDER.map((p) => ({ value: p, label: `${PRIORITY_META[p].label}` }));
  const labelOptions: ChipSelectOption[] = LABEL_ORDER.map((l) => ({ value: l, label: LABEL_META[l].label }));
  const engineOptions: ChipSelectOption[] = newEngineAvailability.options.map((e) => ({
    value: e,
    label: e,
    disabled: newEngineAvailability.status === 'unavailable',
  }));
  const modelOptions: ChipSelectOption[] = models.length === 0
    ? [{ value: '', label: '默认模型' }]
    : models.map((m) => ({ value: m.value, label: m.label || m.value }));

  const moreCount = moreSetCount(name, sourceSessionId, remark);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
        <DialogTitle>新建任务</DialogTitle>
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">新建任务</h2>
          <p className="text-xs text-muted-foreground">说清楚要做什么就行，其余都可以之后再补</p>
        </div>

        <div className="p-5">
          <div className="rounded-2xl border border-border/80 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/50">
            <textarea
              autoFocus
              className="min-h-[180px] w-full resize-y rounded-t-2xl border-0 bg-transparent px-4 py-3 text-base leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:min-h-[240px]"
              placeholder="发给 agent 执行的内容"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2.5">
              <ChipSelect
                ariaLabel="项目"
                label="项目"
                options={projectOptions}
                value={projectPath}
                isMobile={isMobile}
                onChange={(v) => { setProjectPath(v); setSourceSessionId(''); }}
              />
              <ChipSelect
                ariaLabel="标签"
                label="标签"
                options={labelOptions}
                value={label}
                isMobile={isMobile}
                onChange={(v) => setLabel(v as TaskLabel)}
              />
              <ChipSelect
                ariaLabel="优先级"
                label="优先级"
                options={priorityOptions}
                value={priority}
                isMobile={isMobile}
                onChange={(v) => setPriority(v as TaskPriority)}
              />
              <label className="flex h-9 items-center gap-1 rounded-full border border-border/80 bg-card px-3 text-sm text-foreground">
                <span className="text-muted-foreground">截止</span>
                <input
                  type="date"
                  className="bg-transparent text-sm text-foreground focus:outline-none"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </label>
              <ChipSelect
                ariaLabel="引擎"
                label="引擎"
                options={engineOptions}
                value={isAssistant ? '' : engine}
                disabled={isAssistant}
                isMobile={isMobile}
                onChange={(v) => setEngine(v as TaskEngine)}
              />
              <ChipSelect
                ariaLabel="模型"
                label="模型"
                options={modelOptions}
                value={isAssistant ? '' : model}
                disabled={isAssistant}
                isMobile={isMobile}
                onChange={(v) => setModel(v)}
              />
              <MoreChip moreCount={moreCount} isMobile={isMobile} isAssistant={isAssistant} {...{
                name, setName, sourceSessionId, setSourceSessionId, contextMode, setContextMode, remark, setRemark,
                sourceSessionOptions,
              }} />
              <button
                type="button"
                aria-label={prompt.trim() ? '创建任务' : '提示词为空，暂不能创建'}
                title="创建任务"
                disabled={!prompt.trim()}
                onClick={() => void submit()}
                className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="h-5 w-5" />
              </button>
            </div>
          </div>

          {isAssistant && (
            <p className="mt-2 text-xs text-muted-foreground">🤖 Lovdex助手任务固定使用 Claude + 默认模型，以上引擎/模型设置将被忽略。</p>
          )}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">{isMobile ? 'Enter 创建 · 换行用换行键' : ''}</span>
            <Button size="sm" variant="ghost" onClick={reset}><RotateCcw className="mr-1 h-3.5 w-3.5" />重置</Button>
            <Button size="sm" onClick={onClose} variant="ghost">取消</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 写 MoreChip（同文件底部）**

在 `CreateTaskDialog.tsx` 同文件末尾追加（`CreateTaskDialog` 之后）：

```tsx
function MoreChip({
  moreCount, isMobile, isAssistant, name, setName, sourceSessionId, setSourceSessionId,
  contextMode, setContextMode, remark, setRemark, sourceSessionOptions,
}: {
  moreCount: number;
  isMobile: boolean;
  isAssistant: boolean;
  name: string; setName: (v: string) => void;
  sourceSessionId: string; setSourceSessionId: (v: string) => void;
  contextMode: 'summary' | 'raw'; setContextMode: (v: 'summary' | 'raw') => void;
  remark: string; setRemark: (v: string) => void;
  sourceSessionOptions: { id?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-1 rounded-full border border-border/80 bg-card px-3 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span>更多</span>
        {moreCount > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{moreCount}</span>
        )}
      </button>
      <AnchorPopover open={open} onOpenChange={setOpen} anchorRef={anchorRef} align="right" isMobile={isMobile} ariaLabel="更多设置">
        <div className="flex flex-col gap-3 p-1">
          <Field label="名称">
            <Input className="h-9 w-full" placeholder="可选，留空自动提炼" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="上下文来源">
            <select
              className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              value={sourceSessionId}
              onChange={(e) => setSourceSessionId(e.target.value)}
            >
              <option value="">（无）白纸开始</option>
              {sourceSessionOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.id ? resolveSessionTitle(s as never) || s.id.slice(0, 8) : ''}</option>
              ))}
            </select>
          </Field>
          {sourceSessionId && (
            <Field label="压缩方式">
              <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
                {(['summary', 'raw'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setContextMode(m)}
                    className={cn('flex-1 rounded-md px-3 py-1.5 text-sm transition-colors', contextMode === m ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {m === 'summary' ? '摘要' : '原文'}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="备注">
            <Input className="h-9 w-full" placeholder="需求来源等，可选" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Field>
          {isAssistant && <p className="text-xs text-muted-foreground">助手任务固定 Claude + 默认模型，名称/备注仍生效。</p>}
        </div>
      </AnchorPopover>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: typecheck**

Run: `cd web && npm run typecheck`
Expected: 若报 `resolveSessionTitle` 参数类型（`s as never`）或 `Button size` 值问题，按实际签名微调（`resolveSessionTitle` 接受 session-like 对象，直接用 `resolveSessionTitle(s)`）。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/tasks/CreateTaskDialog.tsx
git commit -m "feat(tasks): add composer-style CreateTaskDialog"
```

---

## Task 9: TaskBoard 挂载新组件、删内联弹窗

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 删内联创建状态与逻辑**

删除 TaskBoard 里迁入 CreateTaskDialog 的部分：
- 创建表单 state（约 134-153 行）：`creating` 保留，`newPrompt`…`newSourceSessionId`/`newModel`/`models`/`projects`/`modelsRequestRef` 全部删除。
- `duplicateProjectNames`（158-169）、`newProjectRecord`（181-184）、`sourceSessionOptions`（185-194）、`newEngineAvailability`（195-198）、引擎纠偏 effect（202-208）、项目加载 effect（213-234）、模型加载 effect（239-266）。
- `resetCreateForm`（271-279）改成只 `setCreating(true/false)`；`openCreateForm`（281-284）改成 `setCreating(true)`；`closeCreateForm`（286-289）改成 `setCreating(false)`。
- `createTask`（298-343）整体删除。
- 删除 `createTask` 之后不再使用的 import：`Input`、`TaskEngine`（若仅用于表单）、`TaskEngineSelect`、`authenticatedFetch`、`resolveSessionTitle`、`deriveTaskName`、`useTaskEngineAvailability`、`ProviderModelsApiResponse`、`ProviderModelOption`（若 `projectOptions` 仍用则保留 `Project`）、`useMemo`（若不再用）。`useEffect`/`useState`/`useRef` 仍被其它逻辑使用，保留。

> 注意：`projectOptions`（174-177）被看板卡片/详情页复用，**保留**；`duplicateProjectNames` 也被 `projectOptions` 依赖，**保留**（不要删）。只删「创建表单专用」的那份。

- [ ] **Step 2: 改 Dialog 挂载**

把 488-641 行的 `<Dialog>…</Dialog>` 整块替换为：

```tsx
      <CreateTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          void refresh();
          if (filterTasks([created], filter, now).length === 0) setHiddenCreated(created);
        }}
      />
```

在文件顶部 import 加：`import { CreateTaskDialog } from './CreateTaskDialog';`

- [ ] **Step 3: typecheck + lint**

Run: `cd web && npm run typecheck && npm run lint`
Expected: 与 baseline 持平。若 `hiddenCreated`/`filterTasks`/`filter`/`now` 引用仍在作用域内则无需改；若 lint 报未用 import，清理。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/tasks/TaskBoard.tsx
git commit -m "refactor(tasks): mount CreateTaskDialog and drop inline create form"
```

---

## Task 10: 前端测试（冒烟 + 纯函数）

**Files:**
- Create: `web/src/components/tasks/CreateTaskDialog.test.tsx`

- [ ] **Step 1: 写测试**

新建 `web/src/components/tasks/CreateTaskDialog.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CreateTaskDialog, moreSetCount } from './CreateTaskDialog';

// renderToStaticMarkup 不跑 effect，portal 弹层不渲染 —— 只断言静态芯片栏 / 输入框 / 提交按钮。
test('composer renders textarea, chip bar and disabled submit', () => {
  const html = renderToStaticMarkup(
    <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} />,
  );
  assert.match(html, /发给 agent 执行的内容/);
  assert.match(html, /项目/);
  assert.match(html, /优先级/);
  assert.match(html, /更多/);
  assert.match(html, /引擎/);
  assert.match(html, /模型/);
  assert.match(html, /aria-label="提示词为空，暂不能创建"/);
});

test('moreSetCount counts name / source session / remark', () => {
  assert.equal(moreSetCount('', '', ''), 0);
  assert.equal(moreSetCount('名', '', ''), 1);
  assert.equal(moreSetCount('', 's-1', ''), 1);
  assert.equal(moreSetCount('', '', '备注'), 1);
  assert.equal(moreSetCount('名', 's-1', '备注'), 3);
});
```

- [ ] **Step 2: 跑测试**

Run: `cd web && npx tsx --test src/components/tasks/CreateTaskDialog.test.tsx`
Expected: PASS。

- [ ] **Step 3: 全量前端相关测试 + typecheck**

Run: `cd web && npx tsx --test src/components/tasks/CreateTaskDialog.test.tsx && npm run typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/tasks/CreateTaskDialog.test.tsx
git commit -m "test(tasks): smoke-test CreateTaskDialog composer"
```

---

## Self-Review

**Spec 覆盖：**
- §1 组件结构 → Task 7（原语）+ Task 8（CreateTaskDialog）+ Task 9（TaskBoard 挂载）✅
- §2 字段映射（芯片栏 + 更多 + 助手锁定 + 提交）→ Task 8 ✅
- §3 移动端（wrap / 底部抽屉 / safe-area）→ Task 7（AnchorPopover 底部抽屉）+ Task 8（flex-wrap、`isMobile`）✅
- §4 数据模型（前端 4 字段 + 后端 4 列）→ Task 6 + Task 1/2 ✅
- §5 后端改动（db/service/compression/routes/DI）→ Task 1-5 ✅
- §6 错误处理 & 测试 → 各任务测试步骤 ✅
- §7 明确不做 → 未加 context 产物展示/轮询 ✅

**占位符扫描：** 无 TBD/TODO；「若…则微调」均带具体改法。

**类型一致性：**
- `writeContextResult(taskId, { status, summary?, raw? })` 在 Task 2（db）、Task 3（service `setTaskContextResult` 透传）、Task 4（`TaskContextResult`）、Task 5（index.js `writeResult`）四处签名一致 ✅
- `onContextSourceProvided(taskId, sourceSessionId, mode)` 在 Task 3 定义与 Task 5 接线一致 ✅
- `contextMode` 缺省推导「有来源→summary」在 Task 3 service 与 Task 8 前端（`sourceSessionId ? contextMode : undefined`）一致 ✅
- `moreSetCount` 在 Task 8 导出、Task 10 测试引用一致 ✅
