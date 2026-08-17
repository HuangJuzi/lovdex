# 已建任务会话名回填 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后端启动时，把「带会话且会话名空白/占位符」的任务的会话 `custom_name` 回填为任务标题。

**Architecture:** 在 `tasksService` 新增 `backfillSessionNames()`（仿现有 `reconcileFailedTasks`），遍历 `resolveDb.listTasks({})`，对满足条件（有会话、标题非空、会话 `custom_name` 为空或占位符）的任务调用 `opts.deps?.sessionsDb?.updateSessionCustomName(session_id, row.title)`。在 `server/index.js` 启动时 `reconcileFailedTasks` 之后调用。幂等，不覆盖用户手动重命名。

**Tech Stack:** TypeScript + better-sqlite3，后端测试用 `node:test` + `npx tsx --test`（`@/` 别名由 `server/tsconfig.json` 解析）。

**Spec:** `docs/superpowers/specs/2026-08-12-task-session-name-backfill-design.md`

---

### Task 1: 写失败测试 — backfillSessionNames 回填逻辑

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts`（文件末尾追加）

- [ ] **Step 1: 追加 helper + 6 个测试**

在 `tasks.service.test.ts` 文件末尾追加以下内容（注意 `TaskDbLike` 已在文件顶部 import）：

```ts
type BackfillSessionRow = { custom_name?: string | null; project_path?: string | null };

function makeBackfillSessionStub(
  rows: Record<string, BackfillSessionRow>,
  updated: { sessionId: string; customName: string }[],
) {
  return {
    getSessionById: (sid: string) =>
      rows[sid]
        ? { session_id: sid, custom_name: rows[sid].custom_name ?? null, project_path: rows[sid].project_path ?? null }
        : null,
    updateSessionCustomName: (sessionId: string, customName: string) => {
      updated.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
}

test('backfillSessionNames fills a blank session name from the task title', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: null } }, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 1);
  assert.deepEqual(updated, [{ sessionId: 's1', customName: 'x' }]);
});

test('backfillSessionNames skips a session that already has a custom name', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: '自定义' } }, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});

test('backfillSessionNames replaces a placeholder session name', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: 'Untitled Claude Session' } }, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 1);
  assert.deepEqual(updated, [{ sessionId: 's1', customName: 'x' }]);
});

test('backfillSessionNames skips a task without a linked session', () => {
  const { db } = makeDbStub(); // t1 默认 session_id 为 null
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({}, updated);
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});

test('backfillSessionNames skips a task with a blank title', () => {
  const stubDb = {
    ...makeDbStub().db,
    listTasks: () => [{ task_id: 't1', session_id: 's1', title: '   ' }],
  };
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({ s1: { custom_name: null } }, updated);
  const svc = createTasksService(stubDb as unknown as TaskDbLike, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});

test('backfillSessionNames skips a task whose session is missing', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 'ghost');
  const updated: { sessionId: string; customName: string }[] = [];
  const sessions = makeBackfillSessionStub({}, updated); // getSessionById('ghost') → null
  const svc = createTasksService(db, { broadcast: () => {}, deps: { sessionsDb: sessions } });
  assert.equal(svc.backfillSessionNames(), 0);
  assert.deepEqual(updated, []);
});
```

`makeDbStub()` 的默认任务 `t1` 标题是 `'x'`（`tasks.service.test.ts:33`），`db.linkSession('t1', 's1')` 把 t1 的 `session_id` 设为 `'s1'`。

- [ ] **Step 2: 运行测试，确认失败**

Run（在 `lovdex-backend/` 目录下）:
```bash
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: 6 个新测试全 FAIL —— `svc.backfillSessionNames is not a function`（TypeError，方法尚未实现）。现有 25 个测试仍 PASS。

---

### Task 2: 实现 backfillSessionNames + 启动接线 + 提交

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`（在返回对象里 `reconcileFailedTasks` 之后新增方法）
- Modify: `lovdex-backend/server/index.js`（启动时 `reconcileFailedTasks` 之后接线）

- [ ] **Step 1: 实现 `backfillSessionNames`**

在 `tasks.service.ts` 返回对象中，`reconcileFailedTasks(...)` 方法之后追加（保持逗号语法）：

```ts
    /**
     * 回填：把带会话且会话名空白/占位符的任务，会话 custom_name 设为任务标题。
     * 幂等——只填空白/占位符名，不覆盖用户手动重命名或 AI 已有标题。启动时调用。
     * 返回回填的会话数。
     */
    backfillSessionNames(): number {
      let changed = 0;
      for (const row of resolveDb.listTasks({})) {
        const title = row.title?.trim();
        if (!title || !row.session_id) continue;
        const session = resolveSession(row.session_id);
        if (!session) continue;
        const name = session.custom_name?.trim();
        if (name && name !== 'Untitled Claude Session' && name !== 'Untitled Codex Session') continue;
        opts.deps?.sessionsDb?.updateSessionCustomName(row.session_id, row.title);
        changed += 1;
      }
      return changed;
    },
```

`resolveSession` 和 `opts.deps?.sessionsDb` 均为 `createTasksService` 既有注入；`session.custom_name` 类型是 `string | null`。

- [ ] **Step 2: 接线启动**

在 `server/index.js` 的启动 `reconcileFailedTasks` 调用块（约 207-215 行）之后追加：

```js
// On startup, backfill task execution sessions that have no name with the
// linked task's title, so the sidebar shows which task each session belongs to.
try {
    const backfilled = tasksService.backfillSessionNames();
    if (backfilled > 0) {
        console.log(`[tasks] backfilled ${backfilled} session name(s) from task titles`);
    }
} catch (err) {
    console.error('backfillSessionNames on startup failed:', err);
}
```

- [ ] **Step 3: 运行测试，确认通过**

Run（在 `lovdex-backend/` 目录下）:
```bash
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: 31 个测试全 PASS（25 旧 + 6 新）。

- [ ] **Step 4: 回归 + typecheck**

Run:
```bash
npx tsx --test server/modules/tasks/tests/execution-linkage.test.ts server/modules/tasks/tests/tasks.service.test.ts
npm run typecheck
```
Expected: 两个测试文件全 PASS；typecheck 无错误。

- [ ] **Step 5: Commit + push**

```bash
git add server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/tasks.service.test.ts server/index.js
git commit -m "feat(tasks): backfill blank session names from task titles on startup
- add tasksService.backfillSessionNames() to fill sessions whose custom_name
  is null/blank/placeholder ('Untitled Claude Session' / 'Untitled Codex Session')
  with the linked task's title
- run it at startup after reconcileFailedTasks; idempotent, never overwrites
  a user-renamed session"
git push origin main
```
Expected: push 成功（`... main -> main`）。
