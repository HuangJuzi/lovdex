# Lovdex Operator Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 lovdex-backend 加一个全局 Operator Agent——可对话、能查跨项目状态/下发任务/自然语言建任务，并在任务 session 完成时自动起头跑轮次读 transcript、写 summary + verdict、按 verdict 驱动看板移列；附设置页配置自动化强度。

**Architecture:** 复用现有 `claude-sdk.js` 的 `query()` 循环，新增「operator 模式」分支注册封闭自定义工具集（无 bash/Edit/Write）。`tasks` 表加 4 列（ai_summary/verdict/verdict_reason/verdict_at），`sessions` 加 `is_operator`。完成钩子挂在 `tasksService.onSessionStatus('completed')`，起无人工头跑轮次。配置存 `app_config` key-value，前端加助手面板 + TaskCard verdict 徽章 + 设置页。

**Tech Stack:** Node + Express + better-sqlite3 + `@anthropic-ai/claude-agent-sdk` + `node:test`/`node:assert/strict`（后端）；React + react-router + i18n（前端，复用现有 chat 组件）。

**测试命令（后端）：** `npx tsx --test <file>`（后端**需要** `TSX_TSCONFIG_PATH` 全局变量解析 `@/` 别名，不要 unset；unset 坑只适用于 lovdex-cli）。测试 DB 用 `server/modules/database/tests/` 里的 `withIsolatedDatabase` helper（`mkdtemp` + `DATABASE_PATH` + `initializeDatabase()`），不要直接 `getConnection()`。前端无单测框架，靠 `npm run typecheck` + 手动验证。

**仓库注意：** `lovdex-backend` 和 `lovdex-cli` 是两个独立 git 仓。后端任务在 `lovdex-backend/` 提交，前端任务在 `lovdex-cli/` 提交。`docs/` 不在 git 里。

---

## File Structure

### 后端（lovdex-backend/server）

- **Modify** `modules/database/schema.ts` — `TASKS_TABLE_SCHEMA_SQL` 加 4 列；`SESSIONS_TABLE_SCHEMA_SQL` 加 `is_operator`。
- **Modify** `modules/database/migrations.ts` — `addColumnToTableIfNotExists` 给 tasks/sessions 加新列（存量库兼容）。
- **Modify** `shared/types.ts` — `TaskVerdict` 类型、`isTaskVerdict`、`TaskRow` 加字段、`SessionRepositoryRow` 加 `is_operator`。
- **Modify** `modules/database/repositories/tasks.db.ts` — `writeSummary` 方法、`updateTask` 支持 verdict 字段。
- **Modify** `modules/database/repositories/sessions.db.ts` — 创建/查询 session 带 `is_operator`。
- **Modify** `modules/tasks/services/tasks.service.ts` — `decorate` 带新字段、`writeSummary`、verdict 驱动移列、`onSessionStatus('completed')` 触发 auto-verdict。
- **Create** `modules/operators/operator.config.ts` — 配置读写（app_config）+ 默认 + env seed。
- **Create** `modules/operators/operator.routes.ts` — `GET/PUT /api/operator/settings`。
- **Create** `modules/operators/operator.tools.ts` — 自定义工具定义 + handler。
- **Create** `modules/operators/operator-verdict.service.ts` — 头跑 auto-verdict：起 query、并发限制、递归守卫、失败兜底。
- **Modify** `claude-sdk.js` — operator 模式分支：注册工具集、支持头跑无流式调用。
- **Modify** `modules/tasks/index.ts` / `modules/tasks/tasks.routes.ts` — 挂 operator 路由、`start_task_execution` 工具用的发消息链路。
- **Modify** `modules/websocket/services/chat-run-registry.service.ts` — `is_operator` session 不触发 auto-verdict（递归守卫已在 service 层，这里只确保状态上报正常）。

### 前端（lovdex-cli/src）

- **Create** `components/operators/AssistantPanel.tsx` — 复用 chat 视图绑 operator session。
- **Create** `components/operators/OperatorSettingsPage.tsx` — 设置表单。
- **Create** `components/tasks/VerdictBadge.tsx` — verdict 徽章。
- **Modify** `components/tasks/TaskCard.tsx` — 加 VerdictBadge + ai_summary 单行。
- **Modify** `components/tasks/TaskDetail.tsx` — 完整 ai_summary + verdict_reason。
- **Modify** `components/sidebar/view/subcomponents/SidebarContent.tsx`（或等价）— 顶层「助手」入口。
- **Modify** `components/app/AppContent.tsx` + 路由 — `/assistant` 路由。
- **Modify** `types/` 任务类型 — 加 ai_summary/verdict 字段。
- **Modify** `i18n/locales/{en,zh}` — verdict + 设置页文案。

---

## Task 1: DB schema + migration（tasks 4 列 + sessions.is_operator）

**Files:**
- Modify: `lovdex-backend/server/modules/database/schema.ts:123-145`（TASKS schema）和 `:93-117`（SESSIONS schema）
- Modify: `lovdex-backend/server/modules/database/migrations.ts`（在 `runMigrations` 内加调用）
- Test: `lovdex-backend/server/modules/database/tests/operator-columns.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/modules/database/tests/operator-columns.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { getConnection, closeConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { TASKS_TABLE_SCHEMA_SQL, SESSIONS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

test('tasks table has operator verdict columns', () => {
  const db = getConnection();
  runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  const names = cols.map(c => c.name);
  for (const c of ['ai_summary', 'verdict', 'verdict_reason', 'verdict_at']) {
    assert.ok(names.includes(c), `tasks missing ${c}`);
  }
});

test('sessions table has is_operator', () => {
  const db = getConnection();
  runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  assert.ok(cols.map(c => c.name).includes('is_operator'));
});
```

（`getConnection` 在测试里需要一个指向临时 sqlite 的初始化——参照 `modules/database/tests/` 现有写法，若现有测试用 `initDb(':memory:')` 之类，照搬。先读 `server/modules/database/tests/` 任一文件确认 setup 模式再写。）

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/database/tests/operator-columns.test.ts`
Expected: FAIL（列不存在）

- [ ] **Step 3: Add columns to schema.ts**

在 `TASKS_TABLE_SCHEMA_SQL` 的 `updated_at` 行后加：
```sql
    ai_summary       TEXT,
    verdict          TEXT CHECK (verdict IS NULL OR verdict IN ('done','only_plan','needs_review','blocked')),
    verdict_reason   TEXT,
    verdict_at       DATETIME,
```
在 `SESSIONS_TABLE_SCHEMA_SQL` 的 `updated_at` 行后加：
```sql
    is_operator      INTEGER DEFAULT 0,
```

- [ ] **Step 4: Add migration calls in migrations.ts runMigrations**

在 `runMigrations` 内（参照现有 `addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'started_at', 'DATETIME')` 的位置）加：
```ts
const taskColsForOperator = getTableInfo(db, 'tasks').map(c => c.name);
addColumnToTableIfNotExists(db, 'tasks', taskColsForOperator, 'ai_summary', 'TEXT');
addColumnToTableIfNotExists(db, 'tasks', taskColsForOperator, 'verdict', 'TEXT');
addColumnToTableIfNotExists(db, 'tasks', taskColsForOperator, 'verdict_reason', 'TEXT');
addColumnToTableIfNotExists(db, 'tasks', taskColsForOperator, 'verdict_at', 'DATETIME');
const sessionColsForOperator = getTableInfo(db, 'sessions').map(c => c.name);
addColumnToTableIfNotExists(db, 'sessions', sessionColsForOperator, 'is_operator', 'INTEGER DEFAULT 0');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/database/tests/operator-columns.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(db): add operator verdict columns to tasks + is_operator to sessions"
```

---

## Task 2: Types（TaskVerdict + TaskRow 字段 + is_operator）

**Files:**
- Modify: `lovdex-backend/server/shared/types.ts:642-680`（TaskStatus/TaskRow 附近）
- Test: `lovdex-backend/server/shared/tests/task-verdict-type.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/shared/tests/task-verdict-type.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskVerdict, TASK_VERDICTS } from '@/shared/types.js';

test('isTaskVerdict accepts the four verdicts', () => {
  for (const v of ['done', 'only_plan', 'needs_review', 'blocked']) {
    assert.equal(isTaskVerdict(v), true);
  }
  assert.equal(isTaskVerdict('in_progress'), false);
  assert.equal(isTaskVerdict(undefined), false);
});

test('TASK_VERDICTS has exactly four values', () => {
  assert.deepEqual([...TASK_VERDICTS], ['done', 'only_plan', 'needs_review', 'blocked']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/shared/tests/task-verdict-type.test.ts`
Expected: FAIL（`isTaskVerdict` 未导出）

- [ ] **Step 3: Add types to shared/types.ts**

在 `TaskStatus` / `TASK_STATUSES` 附近加：
```ts
export type TaskVerdict = 'done' | 'only_plan' | 'needs_review' | 'blocked';
export const TASK_VERDICTS: readonly TaskVerdict[] = ['done', 'only_plan', 'needs_review', 'blocked'];
export function isTaskVerdict(value: unknown): value is TaskVerdict {
  return typeof value === 'string' && (TASK_VERDICTS as readonly string[]).includes(value);
}
```
在 `TaskRow` 类型里 `completed_at` 之后、`created_at` 之前加：
```ts
  ai_summary: string | null;
  verdict: TaskVerdict | null;
  verdict_reason: string | null;
  verdict_at: string | null;
```
在 `SessionRepositoryRow`（grep 定位）加 `is_operator: number;`。

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/shared/tests/task-verdict-type.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `cd lovdex-backend && npm run typecheck`
Expected: 无新增错误（存量 TS 错误按 supervisor memory 已知存在，只确认没有因本任务引入的新错误指向改动文件）

- [ ] **Step 6: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(types): add TaskVerdict + operator fields on TaskRow/Session"
```

---

## Task 3: tasks.db — writeSummary + updateTask 支持 verdict

**Files:**
- Modify: `lovdex-backend/server/modules/database/repositories/tasks.db.ts:128-160`（updateTask 区域）
- Test: `lovdex-backend/server/modules/database/repositories/tests/tasks-db-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/modules/database/repositories/tests/tasks-db-summary.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
// 复用现有 tasks.db 测试的 DB setup（先读 server/modules/database/repositories/tests/ 现有文件照搬 in-memory db + insert 一行 task 的 helper）
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

test('writeSummary sets verdict columns and verdict_at', () => {
  // arrange: 插入一个 task（用现有 helper 或 tasksDb.createTask）
  const created = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' });
  const updated = tasksDb.writeSummary(created.task_id, {
    summary: '做了X，没做Y',
    verdict: 'only_plan',
    reason: '只生成了 plan 文件',
  });
  assert.equal(updated?.verdict, 'only_plan');
  assert.equal(updated?.ai_summary, '做了X，没做Y');
  assert.ok(updated?.verdict_at);
});

test('writeSummary rejects invalid verdict', () => {
  const created = tasksDb.createTask({ projectPath: '/p', title: 't', executorProvider: 'claude' });
  assert.throws(() => tasksDb.writeSummary(created.task_id, { summary: 's', verdict: 'bogus' as never }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/database/repositories/tests/tasks-db-summary.test.ts`
Expected: FAIL（`writeSummary` 不存在）

- [ ] **Step 3: Implement writeSummary in tasks.db.ts**

在 `tasksDb` 对象内 `updateTaskStatus` 附近加：
```ts
writeSummary(taskId: string, input: { summary: string; verdict: TaskVerdict; reason?: string | null }): TaskRow | null {
  if (!isTaskVerdict(input.verdict)) {
    throw new Error(`invalid verdict: ${String(input.verdict)}`);
  }
  const db = getConnection();
  db.prepare(`
    UPDATE tasks
    SET ai_summary = ?, verdict = ?, verdict_reason = ?, verdict_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ?
  `).run(input.summary, input.verdict, input.reason ?? null, taskId);
  return tasksDb.getTask(taskId);
},
```
并在文件顶部 import 加 `isTaskVerdict, type TaskVerdict` from `@/shared/types.js`。
`normalizeTaskRow` 无需改（新列可空，`...row` 已携带）。

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/database/repositories/tests/tasks-db-summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(tasks-db): add writeSummary for operator verdict"
```

---

## Task 4: tasks.service — decorate 带新字段 + writeSummary + verdict 移列

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts:120-130`（decorate）+ 新增 `writeSummary` + `applyVerdict`
- Test: `lovdex-backend/server/modules/tasks/tests/operator-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/modules/tasks/tests/operator-summary.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskRow } from '@/shared/types.js';
// 复用 tasks.service.test.ts 的 makeDb/makeRow helper（先读那个文件照搬）

test('writeSummary persists verdict and broadcasts upserted', () => {
  const events: unknown[] = [];
  const rows: TaskRow[] = [/* makeRow({ task_id: 't1', status: 'in_review' }) */];
  const svc = createTasksService(makeDb(rows), {
    broadcast: (e) => events.push(e),
  });
  const out = svc.writeSummary('t1', { summary: 's', verdict: 'only_plan', reason: 'r' });
  assert.equal(out?.verdict, 'only_plan');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
});

test('applyVerdict auto-moves only_plan -> todo when auto_move enabled', () => {
  // arrange: task in_review, config auto_move_enabled=true, auto_move_only_plan_to_todo=true
  // act: svc.applyVerdict('t1', 'only_plan')
  // assert: row.status === 'todo'
});

test('applyVerdict leaves done in in_review by default', () => {
  // arrange: task in_review, default config
  // act: svc.applyVerdict('t1', 'done')
  // assert: row.status === 'in_review'
});

test('applyVerdict moves done -> done when auto_move_done enabled', () => {
  // arrange: auto_move_done=true
  // assert: row.status === 'done'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/tasks/tests/operator-summary.test.ts`
Expected: FAIL（`writeSummary`/`applyVerdict` 不存在）

- [ ] **Step 3: Implement in tasks.service.ts**

`decorate` 已经是 `{ ...row, ... }`，新列自动携带，无需改。

在 service 返回对象里加（`opts` 需新增 `getOperatorConfig?: () => OperatorConfig`，类型从 Task 5；先用本地最小类型占位，Task 5 接上）：
```ts
writeSummary(taskId: string, input: { summary: string; verdict: TaskVerdict; reason?: string | null }): TaskRow | null {
  const row = resolveDb.writeSummary?.(taskId, input);
  if (row) emit({ kind: 'task_upserted', task: row, actor: 'engine' });
  return row ? decorate(row) : null;
},

applyVerdict(taskId: string, verdict: TaskVerdict): TaskRow | null {
  const cfg = opts.getOperatorConfig?.() ?? DEFAULT_OPERATOR_CONFIG;
  const row = resolveDb.getTask(taskId);
  if (!row) return null;
  if (cfg.auto_move_enabled) {
    if (verdict === 'only_plan' && cfg.auto_move_only_plan_to_todo && row.status === 'in_review') {
      applyStatusChange(taskId, 'todo', 'engine');
    } else if (verdict === 'done' && cfg.auto_move_done && row.status === 'in_review') {
      applyStatusChange(taskId, 'done', 'engine');
    }
    // needs_review / blocked: 留在 in_review（已在）
  }
  return decorate(resolveDb.getTask(taskId) ?? row);
},
```
`TaskDbLike` 的 Pick 列表加 `'writeSummary'`。import `TaskVerdict`。

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/tasks/tests/operator-summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(tasks-service): writeSummary + applyVerdict auto-move"
```

---

## Task 5: operator.config（app_config 读写 + 默认 + env seed）

**Files:**
- Create: `lovdex-backend/server/modules/operators/operator.config.ts`
- Test: `lovdex-backend/server/modules/operators/tests/operator-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/modules/operators/tests/operator-config.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { getOperatorConfig, setOperatorConfig, DEFAULT_OPERATOR_CONFIG } from '@/modules/operators/operator.config.js';

test('default config has safe automation defaults', () => {
  const c = DEFAULT_OPERATOR_CONFIG;
  assert.equal(c.enabled, true);
  assert.equal(c.auto_verdict_enabled, true);
  assert.equal(c.auto_move_enabled, true);
  assert.equal(c.auto_move_done, false);        // 人 gate 完成
  assert.equal(c.auto_move_only_plan_to_todo, true);
  assert.equal(c.interactive_chat_enabled, true);
  assert.equal(c.max_concurrent, 2);
});

test('getOperatorConfig returns defaults when nothing stored', () => {
  // stub appConfigDb.get -> null
  const c = getOperatorConfig();
  assert.deepEqual(c, DEFAULT_OPERATOR_CONFIG);
});

test('setOperatorConfig persists and getOperatorConfig reads back', () => {
  setOperatorConfig({ auto_move_done: true });
  const c = getOperatorConfig();
  assert.equal(c.auto_move_done, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-config.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement operator.config.ts**

```ts
// server/modules/operators/operator.config.ts
import { appConfigDb } from '@/modules/database/repositories/app-config.js';

export type OperatorConfig = {
  enabled: boolean;
  auto_verdict_enabled: boolean;
  auto_move_enabled: boolean;
  auto_move_done: boolean;
  auto_move_only_plan_to_todo: boolean;
  model: string;
  workspace: string;
  max_concurrent: number;
  verdict_prompt_override: string | null;
  interactive_chat_enabled: boolean;
};

export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  enabled: true,
  auto_verdict_enabled: true,
  auto_move_enabled: true,
  auto_move_done: false,
  auto_move_only_plan_to_todo: true,
  model: process.env.LOVDEX_OPERATOR_MODEL ?? '',
  workspace: process.env.LOVDEX_OPERATOR_WORKSPACE ?? `${os.homedir()}/.lovdex/operator-workspace`,
  max_concurrent: parseInt(process.env.LOVDEX_OPERATOR_MAX_CONCURRENT ?? '2', 10),
  verdict_prompt_override: null,
  interactive_chat_enabled: true,
};

const KEY = 'operator_config';

export function getOperatorConfig(): OperatorConfig {
  const raw = appConfigDb.get(KEY);
  if (!raw) return DEFAULT_OPERATOR_CONFIG;
  try {
    return { ...DEFAULT_OPERATOR_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_OPERATOR_CONFIG;
  }
}

export function setOperatorConfig(partial: Partial<OperatorConfig>): void {
  const merged = { ...getOperatorConfig(), ...partial };
  appConfigDb.set(KEY, JSON.stringify(merged));
}
```
（`import os from 'node:os';` 加顶部。）

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(operator): config repo over app_config with safe defaults"
```

---

## Task 6: operator.routes — GET/PUT /api/operator/settings

**Files:**
- Create: `lovdex-backend/server/modules/operators/operator.routes.ts`
- Modify: `lovdex-backend/server/modules/tasks/index.ts`（或 app 挂路由处，grep `app.use('/api/tasks'` 定位挂载点）
- Test: `lovdex-backend/server/modules/operators/tests/operator-routes.test.ts`

- [ ] **Step 1: Write the failing test**（用 Express supertest 风格或直接调 router——先 grep 现有 routes 测试模式照搬；若无 supertest 依赖则直接调 handler）

```ts
// server/modules/operators/tests/operator-routes.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { buildOperatorRouter } from '@/modules/operators/operator.routes.js';

test('GET /api/operator/settings returns default config', async () => {
  const app = express();
  app.use('/api/operator/settings', buildOperatorRouter());
  const res = await fetch(`http://localhost:${port}/api/operator/settings`); // 或用 app.inject 等价
  const body = await res.json();
  assert.equal(body.auto_move_done, false);
});

test('PUT /api/operator/settings updates config', async () => {
  // PUT { auto_move_done: true } -> 200
  // GET -> auto_move_done === true
});
```
（先读 `server/routes/tests/` 或 `server/modules/providers/tests/` 现有路由测试确认 fetch/inject 模式再写。）

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement operator.routes.ts**

```ts
// server/modules/operators/operator.routes.ts
import express from 'express';
import { asyncHandler } from '@/shared/utils.js';
import { getOperatorConfig, setOperatorConfig, type OperatorConfig } from './operator.config.js';

export function buildOperatorRouter() {
  const router = express.Router();
  router.get('/', asyncHandler(async (_req, res) => {
    res.json(getOperatorConfig());
  }));
  router.put('/', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Partial<OperatorConfig>;
    setOperatorConfig(body);
    res.json(getOperatorConfig());
  }));
  return router;
}
```
在 app 挂载处加 `app.use('/api/operator/settings', buildOperatorRouter());`（需 `express.json()` 中间件已全局挂——grep 确认）。

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(operator): GET/PUT /api/operator/settings"
```

---

## Task 7: operator.tools — 自定义工具定义 + handler

**Files:**
- Create: `lovdex-backend/server/modules/operators/operator.tools.ts`
- Test: `lovdex-backend/server/modules/operators/tests/operator-tools.test.ts`

工具 handler 直接包现有 service/db。`get_session_transcript` 包 `session-conversations-search.service`（或 `sessionsService` 读 jsonl）——先 grep 该 service 的「读单个 session 消息」方法名，用现成的；没有就调 `sessionsService` 暴露的读取。

- [ ] **Step 1: Write the failing test**（针对纯逻辑 handler：create_task 默认 todo、write_task_summary 调 service）

```ts
// server/modules/operators/tests/operator-tools.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperatorTools } from '@/modules/operators/operator.tools.js';

test('create_task handler defaults status to todo', async () => {
  const fakeTasks = { createTask: (i: unknown) => ({ task_id: 't1', status: (i as { status?: string }).status ?? 'todo' }) };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  const out = await tools.create_task.handler({ projectPath: '/p', title: 'x' });
  assert.equal(out.status, 'todo');
});

test('write_task_summary handler delegates to service', async () => {
  let called = false;
  const fakeTasks = { writeSummary: () => { called = true; return { verdict: 'done' }; } };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await tools.write_task_summary.handler({ taskId: 't1', summary: 's', verdict: 'done' });
  assert.equal(called, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement operator.tools.ts**

定义 SDK 自定义工具形状（name + inputSchema + handler）。handler 注入 service 依赖，避免直接 import 全局单例，便于测。

```ts
// server/modules/operators/operator.tools.ts
import { tasksService } from '@/modules/tasks/services/tasks.service.js';
import { projectsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { isTaskVerdict, type TaskVerdict } from '@/shared/types.js';

export type OperatorToolDeps = {
  tasks: Pick<typeof tasksService, 'createTask' | 'listTasks' | 'getTask' | 'writeSummary' | 'startExecution' | 'updateTask' | 'moveTask'>;
  projects: typeof projectsDb;
  sessions: Pick<typeof sessionsService, 'getSessionMessages' | 'getSessionById'>; // 方法名按实际 grep 结果调整
  contextProjectPath?: string | null; // 前端传的当前选中项目，供 create_task 推断
};

export function buildOperatorTools(deps: OperatorToolDeps) {
  return {
    list_projects: {
      description: 'List all projects',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => deps.projects.listProjects(),
    },
    list_tasks: {
      description: 'List tasks, optional projectPath/status filter',
      inputSchema: { type: 'object', properties: { projectPath: { type: 'string' }, status: { type: 'string' } } },
      handler: async (i: { projectPath?: string; status?: string }) => deps.tasks.listTasks({ projectPath: i.projectPath, status: i.status as never }),
    },
    get_task: {
      description: 'Get a single task by id',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      handler: async (i: { taskId: string }) => deps.tasks.getTask(i.taskId),
    },
    get_session_transcript: {
      description: 'Read a session transcript (assistant turns + tool calls + results) to judge task completion',
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
      handler: async (i: { sessionId: string }) => deps.sessions.getSessionMessages(i.sessionId),
    },
    create_task: {
      description: 'Create a task (defaults to todo/代办). Use contextProjectPath if projectPath omitted.',
      inputSchema: { type: 'object', properties: { projectPath: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string' } }, required: ['title'] },
      handler: async (i: { projectPath?: string; title: string; description?: string; status?: string }) => deps.tasks.createTask({
        projectPath: i.projectPath ?? deps.contextProjectPath ?? '',
        title: i.title,
        description: i.description ?? null,
        status: (i.status ?? 'todo') as never,
      }),
    },
    start_task_execution: {
      description: 'Dispatch a task: create its session, send the task description as first message, start run',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      handler: async (i: { taskId: string }) => deps.tasks.startExecution(i.taskId, /* createSession fn 注入 */ undefined as never),
    },
    update_task: {
      description: 'Update task fields',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      handler: async (i: { taskId: string }) => deps.tasks.updateTask(i.taskId, i as never),
    },
    move_task: {
      description: 'Move a task to a status',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string' } }, required: ['taskId', 'status'] },
      handler: async (i: { taskId: string; status: string }) => deps.tasks.moveTask(i.taskId, i.status as never, null, null),
    },
    write_task_summary: {
      description: 'Write AI summary + verdict onto a task. verdict ∈ done | only_plan | needs_review | blocked',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, summary: { type: 'string' }, verdict: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId', 'summary', 'verdict'] },
      handler: async (i: { taskId: string; summary: string; verdict: string; reason?: string }) => {
        if (!isTaskVerdict(i.verdict)) throw new Error(`invalid verdict: ${i.verdict}`);
        return deps.tasks.writeSummary(i.taskId, { summary: i.summary, verdict: i.verdict as TaskVerdict, reason: i.reason });
      },
    },
  };
}
```

**注意：** `start_task_execution` 的 `createSession` 参数和「发首条消息起跑」链路需在 Task 8 接 `claude-sdk.js` 时补齐——`tasksService.startExecution(taskId, createSession)` 的 `createSession` 由 chat 模块提供（grep `startExecution` 现有调用点照搬）。本任务先让 handler 调到 service 层，真正起跑在 Task 8。

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(operator): custom tool set + handlers"
```

---

## Task 8: claude-sdk.js operator 模式分支 + 头跑函数

**Files:**
- Modify: `lovdex-backend/server/claude-sdk.js`（grep `query(` 调用处，加 mode 分支；导出 `runOperatorHeadless`）
- Test: `lovdex-backend/server/modules/operators/tests/operator-headless.test.ts`（mock query）

- [ ] **Step 1: Write the failing test**（mock `query`，断言头跑用固定 prompt + 工具集 + 无流式）

```ts
// server/modules/operators/tests/operator-headless.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
// 用 mock 注入 query：断言被调用时 prompt 含 taskId/sessionId、tools 含 write_task_summary、stdio 无 ws
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-headless.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement in claude-sdk.js**

在现有 `query()` 调用的 options 构造处加分支：当 `mode === 'operator'` 时，把 `buildOperatorTools(...)` 转成 SDK `tools` 数组（`{ name, description, input_schema, execute: handler }`）并入 options，且**不**注入默认的 bash/Edit/Write（按现有 options 里 tools 的给法，operator 模式覆盖为封闭集）。

新增导出：
```js
export async function runOperatorHeadless({ sessionId, taskId, title, promptOverride }) {
  const cfg = getOperatorConfig();
  if (!cfg.enabled || !cfg.auto_verdict_enabled) return;
  const prompt = promptOverride ?? cfg.verdict_prompt_override ?? `你是 Lovdex Operator。读 session ${sessionId}（任务 ${taskId}: ${title}）的 transcript，判断实际完成度，调 write_task_summary 写入：summary（中文≤3句）、verdict（done|only_plan|needs_review|blocked）、reason（一句）。`;
  // 调 query() with mode='operator', headless=true, 无 ws sink，工具集 = operator tools
  // 结果由 write_task_summary handler 副作用落库；返回值忽略
  // 失败 try/catch 记日志，不抛
}
```
鉴权：复用现有 `providerAuthService` 拿 Claude 凭证（grep 现有 query 调用怎么拿 token，照搬）。

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-headless.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(operator): claude-sdk operator mode + headless run"
```

---

## Task 9: auto-verdict 触发（completed 钩子 + 并发 + 递归守卫）

**Files:**
- Create: `lovdex-backend/server/modules/operators/operator-verdict.service.ts`
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts:293-332`（`onSessionStatus` 的 `completed` 分支）
- Test: `lovdex-backend/server/modules/operators/tests/operator-verdict-trigger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/modules/operators/tests/operator-verdict-trigger.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
// mock runOperatorHeadless，断言：
// 1. onSessionStatus('completed') 对非 operator session -> 调一次 runOperatorHeadless
// 2. is_operator session -> 不调（递归守卫）
// 3. 并发超 max_concurrent -> 排队（第 3 个不立即调）
// 4. auto_verdict_enabled=false -> 不调
// 5. runOperatorHeadless 抛错 -> 不影响任务 in_review（失败兜底）
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-verdict-trigger.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement operator-verdict.service.ts + 挂钩**

```ts
// server/modules/operators/operator-verdict.service.ts
import { getOperatorConfig } from './operator.config.js';
import { runOperatorHeadless } from '@/claude-sdk.js';

let active = 0;
const queue: Array<() => Promise<void>> = [];

async function pump() {
  const cfg = getOperatorConfig();
  while (queue.length && active < cfg.max_concurrent) {
    const job = queue.shift()!;
    active++;
    job().finally(() => { active--; pump(); });
  }
}

export async function scheduleAutoVerdict(sessionId: string, taskId: string, title: string, isOperator: boolean) {
  const cfg = getOperatorConfig();
  if (!cfg.enabled || !cfg.auto_verdict_enabled) return;
  if (isOperator) return; // 递归守卫
  queue.push(async () => {
    try { await runOperatorHeadless({ sessionId, taskId, title }); }
    catch (e) { console.error('[operator-verdict] failed', e); }
  });
  pump();
}
```

在 `tasks.service.ts` 的 `onSessionStatus` `completed` 分支里，`applyStatusChange(..., 'in_review', 'engine')` 之后加：
```ts
opts.onTaskCompleted?.(row.task_id, row.title, row.session_id);
```
`opts` 新增 `onTaskCompleted?: (taskId: string, title: string, sessionId: string | null) => void`。在 app 组装处把 `onTaskCompleted` 接成 `(taskId, title, sid) => sid && scheduleAutoVerdict(sid, taskId, title, isOperatorSession(sid))`（`isOperatorSession` 查 sessions.db 的 `is_operator`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test server/modules/operators/tests/operator-verdict-trigger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(operator): auto-verdict on task completed + concurrency + recursion guard"
```

---

## Task 10: operator session 创建（is_operator 标记 + 路由）

**Files:**
- Modify: `lovdex-backend/server/modules/database/repositories/sessions.db.ts`（createSession 支持 `isOperator`）
- Modify: `lovdex-backend/server/routes/sessions.js`（或 sessions 路由）— `POST` 支持 `isOperator` + 列表能过滤 operator session
- Test: `lovdex-backend/server/modules/providers/tests/operator-session.test.ts`

- [ ] **Step 1: Write the failing test**（创建 operator session 后 is_operator=1，列表按 is_operator 过滤）

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement** — `sessions.db.createSession` 加 `isOperator?: boolean` 参数，INSERT 写 `is_operator`；列表查询 SELECT 带出 `is_operator`；路由 POST 接受 `isOperator` body 字段。

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add -A && git commit -m "feat(sessions): is_operator flag on create + list filter"
```

---

## Task 11: 前端 — VerdictBadge 组件 + TaskCard/TaskDetail 展示

**Files:**
- Create: `lovdex-cli/src/components/tasks/VerdictBadge.tsx`
- Modify: `lovdex-cli/src/components/tasks/TaskCard.tsx`（先 Read 全文）
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`（先 Read 全文）
- Modify: `lovdex-cli/src/types/`（任务类型加 ai_summary/verdict/verdict_reason/verdict_at）
- Modify: `lovdex-cli/src/i18n/locales/{en,zh}`

- [ ] **Step 1: Read existing files**

Read: `TaskCard.tsx`, `TaskDetail.tsx`, 任务类型定义文件（grep `TaskRow\|status.*backlog` in `src/types`），`src/i18n/locales/en/*.json` 和 `zh`。

- [ ] **Step 2: Add verdict fields to frontend task type**

在任务类型里加 `ai_summary: string | null; verdict: 'done'|'only_plan'|'needs_review'|'blocked'|null; verdict_reason: string | null; verdict_at: string | null;`

- [ ] **Step 3: Create VerdictBadge.tsx**

```tsx
// src/components/tasks/VerdictBadge.tsx
import { useTranslation } from 'react-i18next';
type Verdict = 'done' | 'only_plan' | 'needs_review' | 'blocked';
const STYLES: Record<Verdict, string> = {
  done: 'bg-green-100 text-green-700',
  only_plan: 'bg-blue-100 text-blue-700',
  needs_review: 'bg-yellow-100 text-yellow-700',
  blocked: 'bg-red-100 text-red-700',
};
export function VerdictBadge({ verdict }: { verdict: Verdict | null }) {
  const { t } = useTranslation('common');
  if (!verdict) return null;
  return <span className={`px-2 py-0.5 rounded text-xs ${STYLES[verdict]}`}>{t(`task.verdict.${verdict}`)}</span>;
}
```

- [ ] **Step 4: Wire into TaskCard + TaskDetail**

TaskCard：在标题行加 `<VerdictBadge verdict={task.verdict} />`；卡片底部加 `task.ai_summary` 单行截断（`truncate`）。TaskDetail：展示完整 `ai_summary` + `verdict_reason` + `verdict_at`。

- [ ] **Step 5: Add i18n keys**

zh: `task.verdict.done=已完成`、`only_plan=仅计划`、`needs_review=待判断`、`blocked=已卡住`；en 对应。

- [ ] **Step 6: typecheck + 手动验证**

Run: `cd lovdex-cli && npm run typecheck`（或 `npx tsc --noEmit`，按现有脚本）
手动：起前端，看一个有 verdict 的任务卡显示徽章。

- [ ] **Step 7: Commit**

```bash
cd lovdex-cli && git add -A && git commit -m "feat(tasks): verdict badge + ai_summary on card/detail"
```

---

## Task 12: 前端 — 助手面板（/assistant 路由 + 侧边栏入口）

**Files:**
- Create: `lovdex-cli/src/components/operators/AssistantPanel.tsx`
- Modify: `lovdex-cli/src/components/app/AppContent.tsx`（先 Read）
- Modify: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarContent.tsx`（先 Read）
- Modify: 路由定义处（grep `createBrowserRouter\|<Route` 定位）

- [ ] **Step 1: Read existing files** — `AppContent.tsx`, `SidebarContent.tsx`, 路由文件, 现有 chat 视图入口（`src/components/chat`）看怎么把 chat 绑到 session。

- [ ] **Step 2: Add /assistant route + sidebar entry**

侧边栏顶层加「助手」项（icon + label，i18n），点击 navigate `/assistant`。路由加 `/assistant` → `<AssistantPanel />`。

- [ ] **Step 3: Create AssistantPanel.tsx**

复用现有 chat 视图组件，绑 operator session：挂载时若 `interactive_chat_enabled` 关则显示「未启用」；否则调 `POST /api/sessions`（带 `isOperator: true`）新建或拉取 operator session 列表作历史。把「当前选中项目」作为 session metadata 传后端（供 create_task 推断）。

- [ ] **Step 4: typecheck + 手动验证**

Run: `cd lovdex-cli && npm run typecheck`
手动：点助手入口，能聊天，能说「新建一个 XXX 任务」看到看板代办列多卡。

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli && git add -A && git commit -m "feat(operator): assistant panel + /assistant route + sidebar entry"
```

---

## Task 13: 前端 — Operator 设置页

**Files:**
- Create: `lovdex-cli/src/components/operators/OperatorSettingsPage.tsx`
- Modify: 设置区路由/入口（grep 现有设置页位置）

- [ ] **Step 1: Read existing settings page** — grep `Settings` in `src/components`，照搬表单 + API 调用模式。

- [ ] **Step 2: Create OperatorSettingsPage.tsx**

表单字段对应 `OperatorConfig`：开关（enabled / auto_verdict_enabled / auto_move_enabled / auto_move_done / auto_move_only_plan_to_todo / interactive_chat_enabled）、model 下拉（拉 `provider-models`）、workspace 文本、max_concurrent 数字、verdict_prompt_override textarea。`GET /api/operator/settings` 填充，改动 `PUT`，失败回滚提示。

- [ ] **Step 3: Wire into settings nav**

- [ ] **Step 4: typecheck + 手动验证**

Run: `cd lovdex-cli && npm run typecheck`
手动：改 `auto_move_done=true` 保存，刷新仍是 true。

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli && git add -A && git commit -m "feat(operator): settings page"
```

---

## Task 14: 端到端手动验证 + 收尾

- [ ] **Step 1: 起后端**（`systemctl --user restart lovdex` 或 `npm run dev`），确认 migration 跑过、新列存在。

- [ ] **Step 2: 交互式助手** — 打开助手面板，说「新建一个测试任务」，确认看板代办列出现该任务。

- [ ] **Step 3: auto-verdict** — 跑一个任务到 session completed（比如只生成 plan 的场景），确认任务上自动出现 `ai_summary` + `verdict=only_plan` + 自动退回 todo（默认配置）。

- [ ] **Step 4: 设置页** — 关 `auto_verdict_enabled`，再跑一个任务完成，确认不再自动判定。

- [ ] **Step 5: 递归守卫** — 确认 operator session 完成不会触发自己的 auto-verdict（看日志无递归）。

- [ ] **Step 6: typecheck 全量**

Run: `cd lovdex-backend && npm run typecheck` 和 `cd lovdex-cli && npm run typecheck`

- [ ] **Step 7: 合并推送** — 按用户偏好：后端 feat 分支 fast-forward merge 到 main + push；前端同样。（参考 memory `lovdex-repo-layout`）

---

## Self-Review

**Spec coverage:**
- §2 operator 模式（不绑任务、封闭工具、交互+头跑）→ Task 7/8/10/12 ✓
- §3 工具集表 → Task 7 ✓
- §4 自然语言建任务（推断 projectPath、缺信息反问）→ Task 7 create_task + Task 12 传 contextProjectPath ✓（ask_user 走现有 AskUserQuestion 渲染，Task 8 复用）
- §5 auto-verdict 触发点 + prompt + 移列表 + 约束 → Task 8/9 + Task 4 applyVerdict ✓
- §6 数据模型 4 列 + is_operator → Task 1/2 ✓
- §7 设置页配置项 + app_config + 路由 → Task 5/6/13 ✓
- §8 前端助手面板 + TaskCard/Detail 展示 → Task 11/12 ✓
- §9 边界安全（无 bash/edit、递归守卫、失败兜底）→ Task 7/9 ✓
- §10 测试 → 每任务带单测 + Task 14 端到端 ✓
- §11 实施顺序 → 任务顺序对齐 ✓

**Placeholder scan:** 前端 Task 11-13 含「先 Read 全文」「照搬现有模式」——这是合法的读文件指令，不是占位符；具体新代码（VerdictBadge、AssistantPanel 骨架、设置表单字段）已给出。`start_task_execution` 的 createSession 注入在 Task 7 标注 Task 8 补齐，跨任务依赖已显式说明。

**Type consistency:** `TaskVerdict` 四值全文一致；`writeSummary` 签名（`{ summary, verdict, reason? }`）Task 3/4/7 一致；`OperatorConfig` 字段名 Task 5/6/13 一致；`scheduleAutoVerdict(sessionId, taskId, title, isOperator)` Task 9 内一致。

**已知跨任务依赖：** Task 4 的 `getOperatorConfig` 依赖 Task 5（先用 `DEFAULT_OPERATOR_CONFIG` 占位，Task 5 接上）；Task 7 的 `start_task_execution` 起跑依赖 Task 8；Task 9 的 `onTaskCompleted` 接线在 app 组装处（Task 8/9 之间）。执行时按 ID 顺序即可。
