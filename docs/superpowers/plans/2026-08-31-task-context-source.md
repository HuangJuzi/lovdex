# 新建任务可选携带来源会话上下文（自动压缩注入）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建任务表单可选一个历史会话作为上下文来源，后台把该会话 transcript 压缩成固定模板摘要落盘到任务 `context_summary`，新任务首次执行时把摘要拼进首条消息。

**Architecture:** 后端起一条后台链路 `POST /api/tasks`（带 `sourceSessionId`）→ `tasksService.createTask` 校验来源会话归属项目并调度压缩 → `task-context.service` 读 transcript、headless Claude 一次生成摘要、写回任务 `context_summary`；前端「新建任务」表单加可选下拉 + `buildTaskChatSend` 注入摘要（只要有非空摘要即注入，首轮与 retry 均如此）。摘要为纯文本，走现成 `chat.send` 链路，四 provider 通用；不选来源时行为与现在完全一致。

**Tech Stack:** 后端 Express + better-sqlite3 + @anthropic-ai/claude-agent-sdk（headless `query`）+ node:test；前端 React + `npx tsx --test`。

**关联 spec:** `docs/superpowers/specs/2026-08-31-task-context-source-design.md`

---

## 文件结构

**后端**
- Modify `backend/server/modules/database/schema.ts` — `TASKS_TABLE_SCHEMA_SQL` 加列
- Modify `backend/server/modules/database/migrations.ts` — `migrateTasksTable` 加 `context_summary`
- Modify `backend/server/modules/database/repositories/tasks.db.ts` — TaskRow 透传 + `updateTaskContextSummary`
- Modify `backend/server/shared/types.ts` — `TaskRow.context_summary`
- Modify `backend/server/modules/tasks/services/tasks.service.ts` — `CreateTaskInput.sourceSessionId` 校验 + `setTaskContextSummary` + `onContextSourceProvided` 钩子
- Modify `backend/server/modules/tasks/tasks.routes.ts` — POST 透传 `sourceSessionId`
- Create `backend/server/modules/tasks/services/task-context.service.ts` — 压缩排程器（读 transcript → compact → headless 文本 → 写回；in-flight 防重；失败吞错）
- Modify `backend/server/claude-sdk.js` — 新增 `runOneShotClaudeText`（headless 一次 prompt → 文本）
- Modify `backend/server/index.js` — 接线排程器

**前端**
- Modify `web/src/types/app.ts` — `Task.context_summary`
- Modify `web/src/components/tasks/taskExecution.ts` — `buildTaskChatSend` 摘要注入（有摘要即注入）
- Modify `web/src/components/tasks/TaskBoard.tsx` — 新建表单加「上下文来源」下拉 + body 带 `sourceSessionId`

**测试**
- Modify `backend/server/modules/database/tests/tasks-status-migration.test.ts`（或新迁移测试）— 列存在
- Modify `backend/server/modules/tasks/tests/tasks.service.test.ts` — sourceSessionId 校验 + 钩子
- Modify `backend/server/modules/tasks/tests/tasks.routes.test.ts` — 透传
- Create `backend/server/modules/tasks/tests/task-context.service.test.ts` — 排程/合并/失败/防重
- Create `backend/server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts` — headless 文本提取
- Modify `web/src/components/tasks/taskExecution.test.ts` — 注入/不注入

---

### Task 1: 数据库迁移 + 类型 + 写回方法

**Files:**
- Modify: `backend/server/modules/database/schema.ts:162-190`
- Modify: `backend/server/modules/database/migrations.ts:435-470`
- Modify: `backend/server/shared/types.ts:927-998`
- Modify: `backend/server/modules/database/repositories/tasks.db.ts:52-240`
- Test: `backend/server/modules/database/tests/tasks-status-migration.test.ts`（新文件同目录新增一个迁移测试）

- [ ] **Step 1: 写失败测试 — 新安装 schema 含 `context_summary` 列，且旧表迁移后该列存在**

在 `backend/server/modules/database/tests/tasks-context-summary-migration.test.ts` 新建：

```ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';

const LEGACY_TASKS_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo',
    executor_provider TEXT NOT NULL DEFAULT 'claude',
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

function columnNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name),
  );
}

test('context_summary column exists after runMigrations on a legacy tasks table', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'ctx-summary-'));
  const dbPath = path.join(tempDir, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  try {
    const db = getConnection();
    db.exec('CREATE TABLE projects (project_path TEXT PRIMARY KEY NOT NULL);');
    db.exec(LEGACY_TASKS_DDL);
    runMigrations(db);
    assert.ok(columnNames(db).has('context_summary'), 'expected context_summary column to be added');
  } finally {
    closeConnection();
    delete process.env.DATABASE_PATH;
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（backend 目录内）:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/database/tests/tasks-context-summary-migration.test.ts
```
Expected: FAIL — `assert.ok(columnNames(db).has('context_summary'))` 断言失败（列不存在）。

- [ ] **Step 3: 加列到 schema + migration**

`backend/server/modules/database/schema.ts` — `TASKS_TABLE_SCHEMA_SQL` 在 `remark` 行后加：
```ts
    remark            TEXT,
    context_summary   TEXT
```

`backend/server/modules/database/migrations.ts` — 在 `migrateTasksTable` 的 `addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'remark', 'TEXT');` 之后加：
```ts
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'context_summary', 'TEXT');
```

- [ ] **Step 4: 类型透传 + 写回方法 + service 方法**

`backend/server/shared/types.ts` — `TaskRow` 在 `remark: string | null;` 之后加：
```ts
  /** 新建任务时从来源会话压缩出的上下文摘要（可选，后台异步生成）。 */
  context_summary: string | null;
```

`backend/server/modules/database/repositories/tasks.db.ts`：
- 在 `moveTask(taskId, ...)` 后面（对象还有一个逗号结构内的新方法）加：
```ts
  updateTaskContextSummary(taskId: string, summary: string): void {
    const db = getConnection();
    db.prepare('UPDATE tasks SET context_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(summary, taskId);
  },
```
- `normalizeTaskRow` 的 `return { ...row, ... }` 已靠 spread 透传 `context_summary`，无需显式加（SELECT * 已包含该列）。

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/database/tests/tasks-context-summary-migration.test.ts
```
Expected: PASS。

- [ ] **Step 6: 跑既有迁移测试回归**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/database/tests/tasks-status-migration.test.ts
```
Expected: PASS（既有 2 个迁移测试不受影响）。

- [ ] **Step 7: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts backend/server/shared/types.ts backend/server/modules/database/repositories/tasks.db.ts backend/server/modules/database/tests/tasks-context-summary-migration.test.ts && git commit -m "feat(task-context): add tasks.context_summary column + migration"
```

---

### Task 2: tasks.service 支持 sourceSessionId + 调度钩子 + setTaskContextSummary

**Files:**
- Modify: `backend/server/modules/tasks/services/tasks.service.ts:56-270`
- Test: `backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/server/modules/tasks/tests/tasks.service.test.ts` 末尾加三个测试：

```ts
function makeSessionsStub(sessions: Array<{ id: string; project_path: string }>) {
  return {
    getSessionById: (id: string) => sessions.find((s) => s.id === id) ?? null,
  };
}

test('createTask with sourceSessionId validates session exists + project match and fires onContextSourceProvided', () => {
  const events: unknown[] = [];
  const hooks: Array<[string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: (e) => events.push(e),
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionsStub([{ id: 'src1', project_path: '/p' }]),
    },
    onContextSourceProvided: (taskId, sourceSessionId) => hooks.push([taskId, sourceSessionId]),
  });
  const task = svc.createTask({
    title: 'x',
    projectPath: '/p',
    executorProvider: 'claude',
    sourceSessionId: 'src1',
  });
  assert.equal((task as { context_summary: string | null }).context_summary, null);
  assert.deepEqual(hooks, [['t1', 'src1']]);
});

test('createTask with sourceSessionId rejects a session from another project', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionsStub([{ id: 'src1', project_path: '/other' }]),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 'src1' }),
    /session does not belong/,
  );
});

test('createTask with unknown sourceSessionId rejects', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: makeSessionsStub([]) },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sourceSessionId: 'nope' }),
    /session not found/,
  );
});

test('createTask without sourceSessionId never fires onContextSourceProvided', () => {
  const hooks: Array<[string, string]> = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p') },
    onContextSourceProvided: (taskId, sourceSessionId) => hooks.push([taskId, sourceSessionId]),
  });
  svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' });
  assert.deepEqual(hooks, []);
});
```

（`makeProjectStub` 已是 helper 可复用；新增 `makeSessionsStub`。）

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: FAIL — 类型/逻辑均未实现（`sourceSessionId` 不在 input 类型 / 钩子未触发）。

- [ ] **Step 3: 实现**

`backend/server/modules/tasks/services/tasks.service.ts`：

a) `TaskDbLike` union（约 40-58 行）加 `'updateTaskContextSummary'`：
```ts
  | 'updateTaskContextSummary'
```

b) `CreateTaskInput` 加字段：
```ts
  /**
   * 可选：新建任务时引用一个历史会话，后台把该会话压缩成 context_summary
   * 注入首次执行。语义与 sessionId（任务执行的会话链接）不同——来源会话仅
   * 作为参考历史，不会挂到任务上，允许已被其它任务关联。
   */
  sourceSessionId?: string | null;
```

c) `createTasksService` opts 增加钩子（在 `onTaskCompleted` 附近加文档块 + 类型 + 解构）。类型放在 opts 接口：
```ts
    /**
     * Fired right after a task is created with a `sourceSessionId`. Hook in
     * the background context-compression job here (task-context.service).
     * Optional so unit tests and callers without the compression wire are
     * unaffected. Fire-and-forget inside the hook — createTask itself is
     * synchronous and never awaits it.
     */
    onContextSourceProvided?: (taskId: string, sourceSessionId: string) => void;
```

d) `createTask` 内，在现有 `if (input.sessionId != null) { ... }` 校验块之后加 sourceSessionId 校验：
```ts
      // sourceSessionId: 来源会话仅作参考历史。三件事——存在、归属项目一致、
      // 不要求未被其他任务关联（它可能就是前序任务的会话）。
      if (input.sourceSessionId != null) {
        const srcSession = resolveSession(input.sourceSessionId);
        if (!srcSession) {
          throw new AppError(`session not found: ${input.sourceSessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        }
        if (normalizeProjectPath(srcSession.project_path ?? '') !== normalizeProjectPath(input.projectPath)) {
          throw new AppError('session does not belong to this project', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 409 });
        }
      }
```

e) `createTask` 尾部，`emit({ kind: 'task_upserted', task: row, actor: 'user' });` 之后加：
```ts
      if (input.sourceSessionId != null) {
        opts.onContextSourceProvided?.(row.task_id, input.sourceSessionId);
      }
```

f) 新增 service 方法（返回对象内、`createTask` 之后）：
```ts
    setTaskContextSummary(taskId: string, summary: string): TaskRow | null {
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      resolveDb.updateTaskContextSummary(taskId, summary);
      const updated = resolveDb.getTask(taskId) ?? row;
      emit({ kind: 'task_upserted', task: updated, actor: 'engine' });
      return decorate(updated);
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: PASS（新增 4 个 + 既有全部）。注意 `makeDbStub` 的 `db` 是 `TaskDbLike` cast，新增方法会让既有 stub 缺方法——若 TS 报错，在 `makeDbStub` 的 stub 对象里补 `updateTaskContextSummary: () => {}`。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/tasks.service.test.ts && git commit -m "feat(task-context): tasks.service sourceSessionId validation + schedule hook + setTaskContextSummary"
```

---

### Task 3: routes 透传 sourceSessionId

**Files:**
- Modify: `backend/server/modules/tasks/tasks.routes.ts:36-50`
- Test: `backend/server/modules/tasks/tests/tasks.routes.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/tasks/tests/tasks.routes.test.ts` 顶部 `buildTestApp` 的 fake service 加 `createTask` 捕获。在该文件末尾加：

```ts
test('POST /api/tasks forwards sourceSessionId to createTask', async (t) => {
  const created: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  const fakeService = {
    createTask: (input: Record<string, unknown>) => {
      created.push(input);
      return { task_id: 't1', project_path: String(input.projectPath), title: String(input.title), context_summary: null };
    },
  } as unknown as TasksService;
  app.use('/api/tasks', buildTasksRouter(fakeService, { createSession: () => 's1' }));
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: '/p', title: 'x', sourceSessionId: 'src1' }),
  });
  assert.equal(res.status, 201);
  assert.equal(created.length, 1);
  assert.equal(created[0].sourceSessionId, 'src1');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/tasks.routes.test.ts
```
Expected: FAIL — `created[0].sourceSessionId` 为 undefined。

- [ ] **Step 3: 实现**

`backend/server/modules/tasks/tasks.routes.ts` 的 POST handler `createTask` 参数里加：
```ts
        sourceScheduleId: typeof body.sourceScheduleId === 'string' ? body.sourceScheduleId : null,
        sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : null,
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/tasks.routes.test.ts
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/tasks/tasks.routes.ts backend/server/modules/tasks/tests/tasks.routes.test.ts && git commit -m "feat(task-context): tasks route accepts sourceSessionId"
```

---

### Task 4: claude-sdk.js 新增 headless 一次 prompt → 文本

**Files:**
- Modify: `backend/server/claude-sdk.js`（`query` import 已存在；`getOperatorConfig` 已 import；`applyClaudeThinkingDisable` 内部函数；`resolveClaudeCodeExecutablePath` / `getClaudeFallbackModels` 已 import）
- Test: `backend/server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts`：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { runOneShotClaudeText } from '@/claude-sdk.js';

const FAKE_RESULT = [
  { type: 'assistant', message: { content: [{ type: 'text', text: '摘要内容' }] } },
  { type: 'result', result: '' },
];

test('runOneShotClaudeText returns concat assistant text', async () => {
  const queryFn = async function* () {
    yield* FAKE_RESULT;
  };
  const text = await runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn });
  assert.equal(text, '摘要内容');
});

test('runOneShotClaudeText ignores non-assistant messages', async () => {
  const queryFn = async function* () {
    yield { type: 'result', result: '' };
  };
  const text = await runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn });
  assert.equal(text, null);
});

test('runOneShotClaudeText joins multiple text blocks', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } };
  };
  const text = await runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn });
  assert.equal(text, 'a\nb');
});
```

路径对齐：测试文件用 `@/claude-sdk.js` 别名导入（与 `operator-headless.test.ts` 一致，`tsx --tsconfig server/tsconfig.json` 解析 `@/` → `server/`）。

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts
```
Expected: FAIL — `runOneShotClaudeText` 未导出。

- [ ] **Step 3: 实现**

在 `backend/server/claude-sdk.js` 中 `runOperatorHeadless` 定义之后、导出区前加：

```js
/**
 * One-shot headless Claude text run: NOT a live session, NO websocket, NO
 * tools. Runs the SDK `query` with all built-in tools disabled and
 * bypassPermissions, then collects the assistant text blocks and returns the
 * joined output (or null). Used by the task-context compression job to turn a
 * compacted transcript into a fixed-template context summary. `queryFn` is the
 * test seam (defaults to the SDK `query`).
 */
export async function runOneShotClaudeText({ prompt, systemPrompt, model, queryFn } = {}) {
  const cfg = getOperatorConfig();
  const sdkOptions = {
    env: { ...process.env },
    pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
    cwd: cfg.workspace,
    model: model || cfg.model || getClaudeFallbackModels().DEFAULT,
    // Closed tool set: no Bash/Edit/Write/AskUserQuestion — pure text in/out.
    tools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt,
    settingSources: ['project', 'user', 'local'],
  };
  // Third-party reasoning models must skip extended thinking (same rule as the
  // interactive path — see shouldDisableClaudeThinking).
  applyClaudeThinkingDisable(sdkOptions);

  const queryInstance = (queryFn ?? query)({ prompt, options: sdkOptions });
  const parts = [];
  for await (const message of queryInstance) {
    if (message?.type !== 'assistant') continue;
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  const text = parts.join('\n').trim();
  return text || null;
}
```

同时把它加入文件底部的 `export { ... }` 导出块（`queryClaudeSDK` 等所在处）。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/claude-sdk.js backend/server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts && git commit -m "feat(task-context): headless one-shot Claude text run helper"
```

---

### Task 5: task-context 压缩排程器

**Files:**
- Create: `backend/server/modules/tasks/services/task-context.service.ts`
- Test: `backend/server/modules/tasks/tests/task-context.service.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `backend/server/modules/tasks/tests/task-context.service.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { runTaskContextCompression, compactTranscriptToText, scheduleTaskContextCompression } from '../services/task-context.service.js';

const MESSAGES = [
  { role: 'user', content: '修登录页 500' },
  { role: 'assistant', content: '根因是 Nginx 代理超时，已改 upstream。' },
  { role: 'tool', toolName: 'Write', toolResult: 'ok\n'.repeat(400) },
];

test('compactTranscriptToText keeps user/assistant text and truncates tool results', () => {
  const text = compactTranscriptToText(MESSAGES);
  assert.match(text, /修登录页 500/);
  assert.match(text, /根因是 Nginx 代理超时/);
  // tool 行截断到 300 字符，不能出现第 300 个字符后的内容
  assert.ok(text.split('\n').some((line) => line.startsWith('[tool Write]') && line.length <= 320));
});

test('runTaskContextCompression reads transcript, compresses, writes back', async () => {
  const calls: Array<[string, string]> = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: '修登录',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async ({ prompt }) => (prompt.includes('修登录页 500') ? '## 背景\n暂无' : null),
      writeBack: (taskId, summary) => calls.push([taskId, summary]),
    },
  });
  assert.deepEqual(calls, [['t1', '## 背景\n暂无']]);
});

test('runTaskContextCompression does not write back when runOneShot returns null', async () => {
  const calls: Array<[string, string]> = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => null,
      writeBack: (taskId, summary) => calls.push([taskId, summary]),
    },
  });
  assert.deepEqual(calls, []);
});

test('scheduleTaskContextCompression dedupes per in-flight task and swallows errors', async () => {
  let runs = 0;
  const errors: unknown[] = [];
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => {
        runs += 1;
        throw new Error('boom');
      },
      writeBack: () => {},
    },
    onError: (e) => errors.push(e),
  });
  // 第一发立即调度，第二发在 in-flight 期间应被去重
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => {
        runs += 1;
        throw new Error('boom');
      },
      writeBack: () => {},
    },
    onError: (e) => errors.push(e),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, 1);
  assert.equal(errors.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/task-context.service.test.ts
```
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

新建 `backend/server/modules/tasks/services/task-context.service.ts`：

```ts
/**
 * Task-context compression: turn a source session's transcript into a compact
 * fixed-template context summary, persisted on the task as `context_summary`.
 *
 * Flow (spec 2026-08-31-task-context-source-design):
 *   POST /api/tasks { sourceSessionId } → createTask 校验 + onContextSourceProvided
 *   → scheduleTaskContextCompression (fire-and-forget, in-flight dedupe)
 *   → fetchHistory(sourceSession) → compactTranscriptToText → runOneShot (headless
 *   Claude) → writeBack(task_id, summary).
 *
 * All failures are swallowed + logged (via onError) — compression must never
 * block the created task or crash the caller. The task itself is created
 * normally with context_summary NULL; the summary arrives later asynchronously.
 *
 * `runOneShot` defaults to the real headless helper in claude-sdk.js (lazy
 * import so unit tests never pull the SDK); `writeBack` defaults to a
 * tasks-service hook passed by the caller (avoids a hard service dependency).
 */

export type TaskContextCompressionDeps = {
  fetchHistory: (sessionId: string, opts?: { limit?: number; offset?: number }) => Promise<{ messages?: unknown[] }>;
  runOneShot: (args: { prompt: string; systemPrompt: string; model?: string }) => Promise<string | null>;
  writeBack: (taskId: string, summary: string) => void;
};

export type TaskContextCompressionArgs = {
  sourceSessionId: string;
  taskId: string;
  title: string;
  deps: TaskContextCompressionDeps;
  onError?: (error: unknown) => void;
};

/** Max messages pulled from the source transcript (oldest-first paging). */
const MAX_MESSAGES = 200;

/**
 * Compact normalized session messages to plain text so the compression prompt
 * does not blow the token budget with raw provider payloads. Mirrors the
 * operator get_session_transcript compaction (same field shapes, same caps):
 * tool results truncated to 300 chars, user/assistant text to 1200.
 */
export function compactTranscriptToText(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as {
      role?: string;
      kind?: string;
      content?: string;
      commandName?: string;
      toolName?: string;
      toolResult?: string;
      isLocalCommand?: boolean;
    };
    const role = m.role ?? m.kind ?? 'message';
    if (m.isLocalCommand && m.commandName) {
      lines.push(`[${role}] /${m.commandName}`);
      continue;
    }
    if (role === 'tool' || m.kind === 'tool') {
      const res = typeof m.toolResult === 'string' ? m.toolResult : '';
      lines.push(`[tool ${m.toolName ?? ''}] ${res.slice(0, 300)}`);
      continue;
    }
    const text = (m.content ?? '').trim();
    if (text) {
      lines.push(`[${role}] ${text.slice(0, 1200)}`);
    }
  }
  return lines.join('\n\n') || '(empty transcript)';
}

const CONTEXT_SYSTEM_PROMPT =
  '你是 Lovdex 的会话上下文压缩助手。你只负责把给定的会话转录压缩为' +
  '固定模板的中文上下文摘要，供新任务开始执行前注入使用。' +
  '只输出摘要正文，不要任何解释、前后缀、代码块包裹标记。若某个板块无信息，写"（无）"。';

function buildPrompt(title: string, transcript: string): string {
  return [
    `任务：${title || ''}`,
    '',
    '以下是来源会话转录（已精简，可能截断）：',
    '',
    transcript,
    '',
    '请按以下固定模板输出任务的新开始上下文：',
    '## 项目背景 / 决策',
    '## 前序任务交接',
    '## 环境详情',
    '## 注意事项 / 约束',
  ].join('\n');
}

export async function runTaskContextCompression(args: TaskContextCompressionArgs): Promise<void> {
  const { sourceSessionId, taskId, title, deps, onError } = args;
  try {
    let transcript = '';
    try {
      const first = await deps.fetchHistory(sourceSessionId, { limit: MAX_MESSAGES, offset: 0 });
      const messages = Array.isArray(first?.messages) ? first.messages : [];
      transcript = compactTranscriptToText(messages);
    } catch (e) {
      onError?.(e);
      return; // 读不到 transcript => 不压缩，保持 NULL
    }
    const summary = await deps.runOneShot({
      prompt: buildPrompt(title, transcript),
      systemPrompt: CONTEXT_SYSTEM_PROMPT,
    });
    if (summary) {
      deps.writeBack(taskId, summary);
    }
  } catch (e) {
    onError?.(e);
  }
}

/** fire-and-forget + in-flight per-task dedupe。 */
export function scheduleTaskContextCompression(args: TaskContextCompressionArgs): void {
  const { taskId } = args;
  if (inFlight.has(taskId)) return;
  inFlight.add(taskId);
  void runTaskContextCompression(args)
    .catch((e) => args.onError?.(e))
    .finally(() => inFlight.delete(taskId));
}

const inFlight = new Set<string>();
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/task-context.service.test.ts
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/tasks/services/task-context.service.ts backend/server/modules/tasks/tests/task-context.service.test.ts && git commit -m "feat(task-context): transcript compaction + async compression scheduler"
```

---

### Task 6: index.js 接线

**Files:**
- Modify: `backend/server/index.js:449-568`

- [ ] **Step 1: 实现（无独立单测——属接线，靠冒烟验证）**

`backend/server/index.js` 顶部 import 区（`initOperatorHeadless` 的 import 附近）加：
```js
import { runOneShotClaudeText } from './claude-sdk.js';
import { scheduleTaskContextCompression } from './modules/tasks/services/task-context.service.js';
```

然后在 `createTasksService(tasksDb, { ... })` 的 opts 里、`onTaskCompleted` 之后加钩子（`tasksService` 在闭包运行期已就绪，因为该钩子只在 createTask 时被调用）：

```js
    // Task-context compression (spec 2026-08-31-task-context-source-design):
    // createTask 带 sourceSessionId 时后台把来源会话压缩成 context_summary。
    onContextSourceProvided: (taskId, sourceSessionId) => {
      scheduleTaskContextCompression({
        taskId,
        sourceSessionId,
        title: tasksService.getTask(taskId)?.title ?? '',
        deps: {
          fetchHistory: sessionsService.fetchHistory.bind(sessionsService),
          runOneShot: runOneShotClaudeText,
          writeBack: (tid, summary) => tasksService.setTaskContextSummary(tid, summary),
        },
        onError: (e) =>
          console.error('[task-context] compression failed', { taskId, sourceSessionId }, e),
      });
    },
```

注意：`sessionsService` 与 `runOneShotClaudeText` 均在模块顶层 import 可用；`tasksService` 在该闭包内引用的是 `const tasksService` 绑定——`createTasksService` 调用在钩子被触发（后续某次 createTask）时早已返回，无 TDZ/未初始化问题。

- [ ] **Step 2: 冒烟——typecheck**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json
```
Expected: 不超过基线已有错误（参考枚 memory：baseline 已漂到 11 个 tsc 错误，验收标准"零新增"——记录修改前错误数做 diff）。

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/index.js && git commit -m "feat(task-context): wire compression scheduler at startup"
```

---

### Task 7: 前端类型 + buildTaskChatSend 首轮注入

**Files:**
- Modify: `web/src/types/app.ts:99-155`
- Modify: `web/src/components/tasks/taskExecution.ts:95-110`
- Test: `web/src/components/tasks/taskExecution.test.ts`

- [ ] **Step 1: 写失败测试**

`web/src/components/tasks/taskExecution.test.ts` 末尾加：

```ts
test('buildTaskChatSend prepends context_summary on first-run default content', () => {
  const withCtx = { ...task, context_summary: '## 项目背景\n先前决策 A' } as Task;
  const frame = buildTaskChatSend('s1', withCtx);
  assert.match(frame.content, /^## 项目背景\n先前决策 A/);
  assert.ok(frame.content.includes('把登录页 500 报错修好'));
});

test('buildTaskChatSend injects context_summary even on explicit content (retry picks it up)', () => {
  const withCtx = { ...task, context_summary: '## 项目背景\n先前决策 A' } as Task;
  const frame = buildTaskChatSend('s1', withCtx, TASK_RETRY_MESSAGE);
  assert.match(frame.content, /^【任务历史上下文·从来源会话压缩】\n## 项目背景\n先前决策 A/);
  assert.ok(frame.content.includes('上次执行中断/出错了，请重试继续完成'));
});

test('buildTaskChatSend leaves content unchanged when context_summary absent', () => {
  const noCtx = { ...task, context_summary: null } as Task;
  const frame = buildTaskChatSend('s1', noCtx);
  assert.equal(frame.content, '把登录页 500 报错修好');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/taskExecution.test.ts
```
Expected: FAIL — `context_summary` 不在 Task 类型/未注入。

- [ ] **Step 3: 实现**

`web/src/types/app.ts` — `Task` 接口在 `remark: string | null;` 之后加：
```ts
  /** 新建任务时从来源会话压缩出的上下文摘要（可选，后台异步生成）。 */
  context_summary: string | null;
```

`web/src/components/tasks/taskExecution.ts` — `buildTaskChatSend` 改为：

```ts
export function buildTaskChatSend(sessionId: string, task: Task, content?: string): TaskChatSend {
  const toolsSettings = readToolsSettings(task.executor_provider);
  // 摘要注入：只要任务带非空 context_summary，就把它作为历史上下文前缀注入
  // 首条消息（首轮或 retry 均可）——解决新任务零历史执行缺背景信息的问题，
  // 并让压缩晚于首轮启动时，后续 retry 仍能补带摘要。无摘要时原样返回。
  const summary = task.context_summary?.trim();
  const base = content ?? taskPromptOf(task);
  const finalContent = summary ? `【任务历史上下文·从来源会话压缩】\n${summary}\n\n${base}` : base;
  return {
    type: 'chat.send',
    sessionId,
    content: finalContent,
    ...
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/taskExecution.test.ts
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/types/app.ts web/src/components/tasks/taskExecution.ts web/src/components/tasks/taskExecution.test.ts && git commit -m "feat(task-context): inject context_summary on first-run message"
```

---

### Task 8: 前端新建任务表单「上下文来源」下拉

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx:135-320, 464-560`
- Test: `web/src/components/tasks/taskExecution.test.ts`（无新增——下拉逻辑在组件内，走手工/浏览器验证；模板提炼可复测）

- [ ] **Step 1: 实现**

`web/src/components/tasks/TaskBoard.tsx`：

a) state（在 `newRemark` 附近）：
```ts
  // 新建任务可选「上下文来源」会话：选中后后台把该会话压缩进任务 context_summary，
  // 首次执行时注入。空串 = 不选（白纸开始，与旧行为一致）。
  const [newSourceSessionId, setNewSourceSessionId] = useState('');
```

b) `resetCreateForm()` 加 `setNewSourceSessionId('');`

c) `createTask()` body 加（在 `remark` 之后）：
```ts
        sourceSessionId: newSourceSessionId || undefined,
```

d) 计算当前选中项目的会话列表（`newProjectRecord` 定义之后加 memo）：
```ts
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
```

e) JSX 表单里，放在「项目」下拉之后、「执行引擎」之前加：
```tsx
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">上下文来源（可选）</label>
                <select
                  className="h-10 w-full rounded-xl border-2 border-border bg-card px-3 py-1.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  value={newSourceSessionId}
                  onChange={(e) => setNewSourceSessionId(e.target.value)}
                >
                  <option value="">（无）白纸开始</option>
                  {sourceSessionOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {resolveSessionTitle(s) || s.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </div>
```

`resolveSessionTitle` 从 `web/src/utils/sessionTitle.ts` 导入——TaskBoard 位于 `web/src/components/tasks/`，相对路径为 `../../utils/sessionTitle`。在文件顶部 import 区加：
```ts
import { resolveSessionTitle } from '../../utils/sessionTitle';
```

对「🤖 Lovdex 助手」选项（`newProjectPath === ASSISTANT_OPTION_VALUE`）`newProjectRecord` 为 null → `sourceSessionOptions` 为空数组 → 下拉只剩「（无）」项，语义正确（助手任务无项目会话可借）。

- [ ] **Step 2: typecheck**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json
```
Expected: 无新增错误（记录修改前基线 diff）。

- [ ] **Step 3: 已有前端测试回归**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/taskExecution.test.ts src/components/tasks/taskName.test.ts
```
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/tasks/TaskBoard.tsx && git commit -m "feat(task-context): optional source-session dropdown in new-task form"
```

---

### Task 9: 全量验证 + 手工冒烟

**Files:** 无代码改动

- [ ] **Step 1: 后端全量单测（tasks + operator + providers 相关子集）**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/tasks/tests/ server/modules/database/tests/tasks-context-summary-migration.test.ts server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 2: 前端单测回归**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/taskExecution.test.ts
```
Expected: PASS。

- [ ] **Step 3: 手工冒烟（浏览器，连接 :5187 live dev server）**
- 打开「新建任务」表单 → 确认出现「上下文来源（可选）」下拉，默认「（无）白纸开始」。
- 选一个历史会话 → 创建任务 → 稍后（几秒~几十秒）GET `/api/tasks` 返回该任务时 `context_summary` 有值（固定模板）。
- 对该任务「开始执行」→ 打开会话查看首条消息应带「【任务历史上下文·从来源会话压缩】」前缀。
- 不选来源创建任务 → 行为与改动前完全一致（`context_summary` null、首条消息无前缀）。
- 建任务后立刻启动（摘要未就绪）→ 任务正常启动，首条无前缀；等摘要就绪后重试 → retry 带前缀（补带摘要，闭环缺上下文场景）。

- [ ] **Step 4: 汇总变更集 + 确认零新增基线错误**

```bash
cd /mnt/b/workdir/github/lovdex && git status && git log --oneline -8
```
预期看到 8 个任务各一个 feat commit（Task 9 无提交）。

---

## 验收清单（对 spec）

- [ ] `context_summary` 列、类型、写回方法 — Task 1 ✅
- [ ] 新建任务可选来源会话：task.create + sourceSessionId 校验 + 钩子 — Task 2/3 ✅
- [ ] 不预览不打断、后台异步压缩 — Task 5（schedule fire-and-forget）✅
- [ ] 摘要固定模板（背景/决策/交接/环境/注意事项）— Task 5 `buildPrompt` ✅
- [ ] 全部 four provider 通用 — 注入走 `chat.send`、摘要为纯文本 Task 7 ✅
- [ ] 有非空摘要即注入（首轮 + retry，重复注入可接受）— Task 7 ✅
- [ ] 摘要未就绪就启动 → 本次不带、后续 retry 补带 — Task 7 语义 + Task 9 手工冒烟 ✅
- [ ] 不选来源零变化；会话转任务入口不动 — Task 8 默认空 + 未改 ConvertToTaskDialog ✅