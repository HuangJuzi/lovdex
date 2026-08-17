# 任务/会话名称双向同步 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务标题与关联会话名在重命名时双向一致：改任务标题 → 更新关联会话名；改会话名 → 更新关联任务标题。

**Architecture:** 同步逻辑收口在 `tasksService`：`updateTask` 内做「任务→会话」（写 `sessionsDb.updateSessionCustomName`，与 `startExecution` 同款）；新增 `syncTaskTitleFromSession` 做「会话→任务」（反查任务、更新标题并广播 `task_upserted`）。`sessionsService` 加一个注入式 rename hook（仿 `chat-run-registry` 的 `setTaskLinkage`），`index.js` 在启动时把它接到 `tasksService.syncTaskTitleFromSession`。

**Tech Stack:** Node.js + TypeScript。测试 `node:test` + `node:assert/strict`，命令：`cd backend && npx tsx --tsconfig server/tsconfig.json --test <file>`。

**执行环境（重要）：** `feat/project-list-explicit-realpath` 是热分支（有并发提交，勿动）。本计划应在一个**从 `main` 新建的分支**（如 `feat/task-session-name-sync`）上执行，spec 已在 `main`（`05bbb70`）。

---

### Task 1: `updateTask` 任务改名同步会话名

**Files:**
- Modify: `backend/server/modules/tasks/services/tasks.service.ts`（`updateTask` 尾部，约 343 行）
- Test: `backend/server/modules/tasks/tests/tasks.service.test.ts`（文件末尾追加）

- [ ] **Step 1: 写失败测试**

在 `tasks.service.test.ts` 末尾追加：

```ts
test('updateTask: renaming the title syncs the linked session custom name', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: sessions },
  });
  const row = await svc.updateTask('t1', { title: 'renamed' });
  assert.equal(row?.title, 'renamed');
  assert.deepEqual(named, [{ sessionId: 's1', customName: 'renamed' }]);
});

test('updateTask: no session name sync without a linked session', async () => {
  const { db } = makeDbStub(); // t1 默认 session_id 为 null
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: sessions },
  });
  await svc.updateTask('t1', { title: 'renamed' });
  assert.deepEqual(named, []);
});

test('updateTask: skips session name sync for a blank or unchanged title', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const named: { sessionId: string; customName: string }[] = [];
  const sessions = {
    updateSessionCustomName: (sessionId: string, customName: string) => {
      named.push({ sessionId, customName });
    },
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub('/p'), sessionsDb: sessions },
  });
  await svc.updateTask('t1', { title: '   ' }); // 空白 → 跳过
  await svc.updateTask('t1', { title: 'x' });    // 未变化 → 跳过
  assert.deepEqual(named, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: FAIL，`renaming the title syncs...` 断言 `deepEqual(named, [...])` 失败（`named` 为空数组）。

- [ ] **Step 3: 实现同步**

在 `tasks.service.ts` 的 `updateTask` 中，把：

```ts
      const row = resolveDb.updateTask(taskId, effective);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row ? decorate(row) : null;
```

替换为：

```ts
      const row = resolveDb.updateTask(taskId, effective);
      if (row) {
        // 任务改名 → 关联会话名同步：标题变化且非空、有 session_id 时，把会话
        // custom_name 同步为新标题（与 startExecution 的命名方向一致）。
        const trimmedTitle = typeof rest.title === 'string' ? rest.title.trim() : '';
        if (trimmedTitle && trimmedTitle !== current.title && row.session_id) {
          opts.deps?.sessionsDb?.updateSessionCustomName(row.session_id, trimmedTitle);
        }
        emit({ kind: 'task_upserted', task: row, actor: 'user' });
      }
      return row ? decorate(row) : null;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: PASS（全部通过，含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): sync linked session name when task title is renamed

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `syncTaskTitleFromSession` 方法（会话→任务）

**Files:**
- Modify: `backend/server/modules/tasks/services/tasks.service.ts`（`startExecution` 之后、`onSessionStatus` 之前）
- Test: `backend/server/modules/tasks/tests/tasks.service.test.ts`（文件末尾追加）

- [ ] **Step 1: 写失败测试**

在 `tasks.service.test.ts` 末尾追加：

```ts
test('syncTaskTitleFromSession updates the linked task title and broadcasts', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const events: unknown[] = [];
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const row = svc.syncTaskTitleFromSession('s1', 'new name');
  assert.equal(row?.title, 'new name');
  assert.equal((db.getTask('t1') as StoredTask).title, 'new name');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
  assert.equal((events[0] as { task: { title: string } }).task.title, 'new name');
});

test('syncTaskTitleFromSession is a no-op when no task links the session', () => {
  const { db } = makeDbStub();
  const events: unknown[] = [];
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.syncTaskTitleFromSession('nope', 'x'), null);
  assert.equal(events.length, 0);
});

test('syncTaskTitleFromSession skips blank or unchanged titles', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1'); // t1 默认标题为 'x'
  const events: unknown[] = [];
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.syncTaskTitleFromSession('s1', '   '), null);
  assert.equal(svc.syncTaskTitleFromSession('s1', 'x'), null);
  assert.equal(events.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: FAIL，`svc.syncTaskTitleFromSession` is not a function（方法尚不存在）。

- [ ] **Step 3: 实现方法**

在 `tasks.service.ts` 中，紧接 `startExecution` 方法结束（`return { sessionId };\n    },`）之后、`onSessionStatus` 方法之前插入：

```ts
    /**
     * 会话改名 → 关联任务标题同步：把关联会话的新名字写到任务标题并广播
     * task_upserted，让看板实时刷新。无关联任务 / 名字空白 / 未变化时为 no-op。
     */
    syncTaskTitleFromSession(sessionId: string, title: string): TaskRow | null {
      const row = resolveDb.getTaskBySessionId(sessionId);
      if (!row) return null;
      const trimmed = title.trim();
      if (!trimmed || trimmed === row.title) return null;
      resolveDb.updateTask(row.task_id, { title: trimmed });
      const updated = resolveDb.getTask(row.task_id) ?? row;
      emit({ kind: 'task_upserted', task: updated, actor: 'user' });
      return decorate(updated);
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): add syncTaskTitleFromSession for session-rename sync

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `sessionsService` 加 rename hook

**Files:**
- Modify: `backend/server/modules/providers/services/sessions.service.ts`（`export const sessionsService` 之前 + `renameSessionById` 内）
- Test: `backend/server/modules/providers/tests/rename-writeback.test.ts`

- [ ] **Step 1: 写失败测试**

在 `rename-writeback.test.ts` 顶部把 import 改为：

```ts
import { sessionsService, setSessionRenameHook } from '@/modules/providers/services/sessions.service.js';
```

在文件末尾追加：

```ts
test('renameSessionById fires the rename hook with the session id and new name', async () => {
  await withIsolatedDb(async () => {
    const calls: { sessionId: string; name: string }[] = [];
    setSessionRenameHook((sessionId, name) => calls.push({ sessionId, name }));
    try {
      sessionsDb.createSession('p3', 'claude', '/p', undefined, undefined, undefined, undefined, undefined);
      await sessionsService.renameSessionById('p3', 'New Name');
      assert.deepEqual(calls, [{ sessionId: 'p3', name: 'New Name' }]);
    } finally {
      setSessionRenameHook(null);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/rename-writeback.test.ts`
Expected: FAIL，`setSessionRenameHook` is not a function（未导出）。

- [ ] **Step 3: 实现 hook**

在 `sessions.service.ts` 中，紧接 `export const sessionsService = {` 之前的注释块前插入：

```ts
/**
 * Hook fired after a session is renamed (custom_name + disk write persisted).
 * Wired at server startup to tasksService.syncTaskTitleFromSession so a task
 * linked to the renamed session keeps its title in sync. Mirrors
 * chat-run-registry's setTaskLinkage pattern (injected, not imported).
 */
type SessionRenameHook = (sessionId: string, name: string) => void;

let sessionRenameHook: SessionRenameHook | null = null;

/** Wire/unwire the post-rename hook (set once at server startup). */
export function setSessionRenameHook(hook: SessionRenameHook | null): void {
  sessionRenameHook = hook;
}
```

然后在 `renameSessionById` 中，把：

```ts
    await writeCustomNameToDisk({
      provider: session.provider,
      provider_session_id: session.provider_session_id,
      jsonl_path: session.jsonl_path,
      custom_name: summary,
    });
    return { sessionId, summary };
```

替换为：

```ts
    await writeCustomNameToDisk({
      provider: session.provider,
      provider_session_id: session.provider_session_id,
      jsonl_path: session.jsonl_path,
      custom_name: summary,
    });
    sessionRenameHook?.(sessionId, summary);
    return { sessionId, summary };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/rename-writeback.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/providers/services/sessions.service.ts backend/server/modules/providers/tests/rename-writeback.test.ts
git commit -m "feat(sessions): add setSessionRenameHook fired after renameSessionById

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `index.js` 接线 + 全量校验

**Files:**
- Modify: `backend/server/index.js`

- [ ] **Step 1: 改 import**

把第 61 行：

```js
import { sessionsService } from './modules/providers/services/sessions.service.js';
```

改为：

```js
import { sessionsService, setSessionRenameHook } from './modules/providers/services/sessions.service.js';
```

- [ ] **Step 2: 在启动处接线**

在 `setTaskLinkage(tasksService);`（约 261 行）之后新增：

```js
// Session rename → linked task title sync (bidirectional name consistency).
setSessionRenameHook((sessionId, name) => tasksService.syncTaskTitleFromSession(sessionId, name));
```

- [ ] **Step 3: 类型检查 + 全量后端测试**

Run:
```bash
cd backend && npm run typecheck
cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.test.ts server/modules/tasks/tests/tasks.service.status.test.ts server/modules/tasks/tests/execution-linkage.test.ts server/modules/providers/tests/rename-writeback.test.ts
```
Expected: typecheck 无错误；测试全 PASS。

- [ ] **Step 4: 提交**

```bash
git add backend/server/index.js
git commit -m "feat(server): wire session rename to task title sync

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验证清单（完成全部 Task 后）

- 手动：任务详情页改标题 → 侧边栏该会话名随之更新（刷新后）。
- 手动：侧边栏改会话名 → 任务看板/详情页该任务标题随之更新（`task_upserted` 实时）。
- 手动：改项目路径（会删会话）时不触发会话名同步；清空任务标题不清空会话名。
