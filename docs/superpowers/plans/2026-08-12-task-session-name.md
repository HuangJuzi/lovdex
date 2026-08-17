# 任务执行会话以任务标题命名 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务「开始执行」创建执行会话时，把会话 `custom_name` 设为任务标题，侧边栏直接显示任务名。

**Architecture:** 在 `tasks.service.ts` 的 `startExecution` 中，`createSession()` 返回新会话 id 后调用 `sessionsDb.updateSessionCustomName(sessionId, row.title)`（标题非空时）。`sessionsDb` 是 `createTasksService` 已注入的 deps（`index.js` 传了 `{ projectsDb, sessionsDb }`），单测用 optional chaining 保证不传 deps 也不受影响。AI 自动标题走 `summary` 列不会覆盖 `custom_name`；用户手动重命名（写盘 custom-title）仍是最高优先级。

**Tech Stack:** TypeScript + better-sqlite3，后端测试用 `node:test` + `npx tsx --test`（`@/` 路径别名由 `server/tsconfig.json` 解析）。

**Spec:** `docs/superpowers/specs/2026-08-12-task-session-name-design.md`

---

### Task 1: 写失败测试 — startExecution 用任务标题命名新会话

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts`（在现有 `startExecution passes isOperator to createSession` 测试之后追加）

- [ ] **Step 1: 追加两个测试**

在 `tasks.service.test.ts` 文件末尾（`startExecution passes isOperator to createSession` 测试之后）追加：

```ts
test('startExecution names the new session after the task title', () => {
  const { db } = makeDbStub();
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { sessionsDb: sessions },
  });
  const result = svc.startExecution('t1', () => 's1');
  assert.deepEqual(result, { sessionId: 's1' });
  assert.deepEqual(named, [{ sessionId: 's1', customName: 'x' }]);
});

test('startExecution skips naming when the task title is empty', () => {
  const stubDb = {
    ...makeDbStub().db,
    getTask: () => ({
      task_id: 't1',
      is_operator: 0,
      executor_provider: 'claude',
      project_path: '/p',
      title: '',
    }),
  };
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(stubDb as unknown as TaskDbLike, {
    broadcast: () => {},
    deps: { sessionsDb: sessions },
  });
  svc.startExecution('t1', () => 's1');
  assert.deepEqual(named, []);
});
```

`makeDbStub()` 的默认任务标题是 `'x'`（`tasks.service.test.ts:33`），所以第一个测试断言 `customName: 'x'`。空标题测试复用现有 `startExecution passes isOperator to createSession` 的 stub 模式（`tasks.service.test.ts:477-489`）。

- [ ] **Step 2: 运行测试，确认失败**

Run（在 `lovdex-backend/` 目录下）:
```bash
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: 第一个新测试 FAIL —— 断言 `named` 为 `[]`（实现尚未调用 `updateSessionCustomName`），报 `AssertionError: expected [] to deeply equal [{ sessionId: 's1', customName: 'x' }]`。第二个新测试 PASS（空标题本来就该跳过）。现有 23 个测试仍 PASS。

---

### Task 2: 实现 — startExecution 里设置 custom_name

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts:365-376`（`startExecution` 方法）

- [ ] **Step 1: 编辑 `startExecution`**

把：

```ts
      const sessionId = createSession(row.executor_provider, row.project_path, Boolean(row.is_operator));
      resolveDb.linkSession(taskId, sessionId);
```

替换为：

```ts
      const sessionId = createSession(row.executor_provider, row.project_path, Boolean(row.is_operator));
      // 用任务标题给新执行会话命名，侧边栏一眼看出这个会话属于哪个任务。
      // 新 app 会话 custom_name 为 NULL；claude/codex 同步器会保留非占位符的 custom_name。
      if (row.title?.trim()) {
        opts.deps?.sessionsDb?.updateSessionCustomName(sessionId, row.title);
      }
      resolveDb.linkSession(taskId, sessionId);
```

`opts.deps?.sessionsDb` 生产环境已注入（`server/index.js:189` 的 `createTasksService(tasksDb, { deps: { projectsDb, sessionsDb }, … })`）；`updateSessionCustomName` 是 `sessions.db.ts:226` 既有方法。

- [ ] **Step 2: 运行测试，确认通过**

Run（在 `lovdex-backend/` 目录下）:
```bash
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
```
Expected: 25 个测试全 PASS（含 2 个新测试）。

- [ ] **Step 3: 跑关联回归测试 + typecheck**

Run:
```bash
npx tsx --test server/modules/tasks/tests/execution-linkage.test.ts server/modules/tasks/tests/tasks.service.test.ts
npm run typecheck
```
Expected: 两个测试文件全 PASS；typecheck 无错误。

- [ ] **Step 4: Commit**

```bash
git add server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): name task execution session after the task title
- startExecution sets the new session's custom_name to the task title
- empty titles are skipped so the sidebar falls back to the session summary"
```
