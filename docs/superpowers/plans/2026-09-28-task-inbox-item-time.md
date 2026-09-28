# 收件箱条目显示产生时间 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务页「需要你处理」每行末尾的 task_id 换成该条提醒「进入当前状态的时刻」（相对时间 + 悬停精确时间）。

**Architecture:** 后端 `decorate()` 统一派生 `attention_since`：审批等待（`waiting_approval`）取 chat-run-registry 内存里记录的「首个待批请求到达时刻」，其余信号取 `tasks.updated_at`（该列的写入点与状态转移同一条 UPDATE，本就等于进入该状态的时刻）。前端只读这一个字段，不重复推导。无 schema 变更、无新端点。

**Tech Stack:** Node.js + TypeScript（backend，`npx tsx --test` 跑 node:test）；React + Vite（web，node:test + `renderToStaticMarkup` 静态渲染测试，无 DOM）。

**Spec:** `docs/superpowers/specs/2026-09-28-task-inbox-item-time-design.md`

**仓库约定：**
- commit message 英文、**不加** Co-Authored-By 署名行。
- 工作区有并发会话的未提交改动（4 个 quick-replies 文件）—— `git add` **只加本计划明确列出的文件**，绝不 `git add -A`；`git commit` 用显式路径形式 `git commit -m "…" -- <路径…>`。
- 后端命令一律 `cd /mnt/b/workdir/github/lovdex/backend`，测试带 `--tsconfig server/tsconfig.json`；前端 `cd /mnt/b/workdir/github/lovdex/web`，测试带 `env -u TSX_TSCONFIG_PATH`（该变量在开发机 shell 里全局导出、指向 backend 的 tsconfig，会劫持 web 的 tsx；仓库内没有任何文件设置它）。

**基线（改动前实测，用于判断「零新增」）：**

| 检查 | 基线 |
|---|---|
| `chat-run-registry.test.ts` | 3 tests / 3 pass / 0 fail |
| `execution-linkage.test.ts` | 30 tests / 30 pass / 0 fail |
| `TaskInboxPanel.test.tsx` | 18 tests / 18 pass / 0 fail |
| `taskInbox.test.ts` | 8 tests / 8 pass / 0 fail |
| backend `npx tsc --noEmit -p server/tsconfig.json` | **14 个既有错误**（全在 `config/tests`、`operators/tests`、`tasks/tests/tasks.service.status.test.ts:284`、`tasks.create-dedup.integration.test.ts`，与本次改动文件无关） |
| web `npx tsc --noEmit -p tsconfig.json` | 0 错误 |

---

### Task 1: registry 记住「这批等待从什么时候开始」

**Files:**
- Modify: `backend/server/modules/websocket/services/chat-run-registry.service.ts:187-215`（模块级 Map + 清理函数）、`:243-251`（`permission_request` 写入点）、`:450-476`（`takeApprovalRequestSession`、新增 getter）、`:564-571`（`clearAll`）
- Test: `backend/server/modules/websocket/tests/chat-run-registry.test.ts`（追加到文件末尾）

- [ ] **Step 1: 写失败测试**

在 `chat-run-registry.test.ts` 末尾追加（文件顶部已有 `import assert from 'node:assert/strict'` / `import test from 'node:test'` / `makeConnection` / `chatRunRegistry`）：

```ts
// ---------------------------------------------------------------------------
// 「等你批准」条目的产生时刻：任务页收件箱要显示「什么时候开始等的」。
// 持久化信号能从 tasks.updated_at 拿到时刻，唯独纯实时的审批态没有 ——
// 记在 registry 内存里，随请求生命周期增删。
// ---------------------------------------------------------------------------

function startApprovalRun(appSessionId: string) {
  return chatRunRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: makeConnection(),
    userId: null,
  });
}

test('records the wait start on the first pending request', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-1');
  assert.ok(run);
  assert.equal(chatRunRegistry.getApprovalRequestedAt('app-ap-1'), null, '等待前没有时刻');

  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-1' });
  const startedAt = chatRunRegistry.getApprovalRequestedAt('app-ap-1');
  assert.ok(startedAt, '首个待批请求应记下时刻');
  assert.ok(!Number.isNaN(new Date(startedAt).getTime()), '时刻应是可解析的时间串');
});

test('a second pending request does not move the wait start', async (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-2');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-2' });
  const startedAt = chatRunRegistry.getApprovalRequestedAt('app-ap-2');

  // 等过一个毫秒刻度，否则覆盖与否在 ISO 串上看不出差别（同毫秒值相等）。
  await new Promise((resolve) => setTimeout(resolve, 5));
  run.writer.send({ kind: 'permission_request', requestId: 'req-b', provider: 'claude', sessionId: 'app-ap-2' });

  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-2'),
    startedAt,
    '第二个请求到达时仍在等待中，等待起点不该被顶动',
  );
});

test('a new wait segment after the queue empties gets a fresh start', async (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-3');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-3' });
  const firstStart = chatRunRegistry.getApprovalRequestedAt('app-ap-3');

  assert.equal(chatRunRegistry.takeApprovalRequestSession('req-a'), 'app-ap-3');
  assert.equal(chatRunRegistry.getApprovalRequestedAt('app-ap-3'), null, '唯一待批被批准后不再是等待态');

  await new Promise((resolve) => setTimeout(resolve, 5));
  run.writer.send({ kind: 'permission_request', requestId: 'req-b', provider: 'claude', sessionId: 'app-ap-3' });
  const secondStart = chatRunRegistry.getApprovalRequestedAt('app-ap-3');
  assert.ok(secondStart);
  assert.notEqual(secondStart, firstStart, '中间已离开等待，是新的等待段');
});

test('deciding one of several pending requests keeps the wait start', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-4');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-4' });
  const startedAt = chatRunRegistry.getApprovalRequestedAt('app-ap-4');
  run.writer.send({ kind: 'permission_request', requestId: 'req-b', provider: 'claude', sessionId: 'app-ap-4' });

  assert.equal(chatRunRegistry.takeApprovalRequestSession('req-a'), 'app-ap-4');
  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-4'),
    startedAt,
    '还有第二个待批请求，等待没有结束',
  );
});

test('terminal complete drops the wait start', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-5');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-5' });
  assert.ok(chatRunRegistry.getApprovalRequestedAt('app-ap-5'));

  chatRunRegistry.completeRun('app-ap-5', { exitCode: 0, aborted: true });
  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-5'),
    null,
    '运行结束后待批请求永不可能被答复，等待态必须清掉',
  );
});

test('getApprovalRequestedAt is null for an unknown session and after clearAll', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  assert.equal(chatRunRegistry.getApprovalRequestedAt('nobody'), null);
  const run = startApprovalRun('app-ap-6');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-6' });
  chatRunRegistry.clearAll();
  assert.equal(chatRunRegistry.getApprovalRequestedAt('app-ap-6'), null);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/chat-run-registry.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: 报 `chatRunRegistry.getApprovalRequestedAt is not a function`，新增 6 条全 `not ok`，原 3 条仍绿。

- [ ] **Step 3: 实现**

**(a)** 在 `approvalRequestToTool` 声明之后（`:200` 之后、`clearApprovalRequestsForSession` 之前）加入：

```ts
/**
 * 「这批等待从什么时候开始」：appSessionId → ISO 时间串，首个待批请求到达时写入。
 * 任务页收件箱的「等你批准」条目要显示产生时刻，而审批态是纯实时的（不落库），
 * 只有内存这一处能记。语义是「等待段的起点」而非「最后一个请求的时刻」：同一段
 * 等待里追加的请求不覆盖它；请求数归零后条目删除，下次再等到请求即新的一段。
 */
const approvalRequestedAt = new Map<string, string>();

/**
 * 该会话是否还有待批请求。以 approvalRequestToSession 为准 —— 不能用
 * `approvalRequestedAt.has()` 判断，否则「批准 A → 又来 B」的连续等待会被
 * 误判成新等待段（B 到达时本表条目尚未删除）。
 */
function hasPendingApprovalRequest(appSessionId: string): boolean {
  for (const ownerSessionId of approvalRequestToSession.values()) {
    if (ownerSessionId === appSessionId) return true;
  }
  return false;
}

/** 待批请求数归零时忘掉等待起点（等待已结束）。 */
function forgetApprovalStartIfIdle(appSessionId: string): void {
  if (!hasPendingApprovalRequest(appSessionId)) {
    approvalRequestedAt.delete(appSessionId);
  }
}
```

**(b)** `clearApprovalRequestsForSession` 改为（原来的 for 循环之后补最后一行）：

```ts
function clearApprovalRequestsForSession(appSessionId: string): void {
  for (const [requestId, ownerSessionId] of approvalRequestToSession) {
    if (ownerSessionId === appSessionId) {
      approvalRequestToSession.delete(requestId);
      approvalRequestToTool.delete(requestId);
    }
  }
  // 运行已结束：等待态不存在了，起点一并忘掉（否则崩溃 / abort 后残留，
  // 下次同会话再等到审批时会拿到一个过期时刻）。
  approvalRequestedAt.delete(appSessionId);
}
```

**(c)** `permission_request` 分支（`:243-251`）改为：

```ts
  if (message.kind === 'permission_request') {
    if (typeof message.requestId === 'string' && message.requestId) {
      // 先判后写：此刻本表里还没有这条 requestId，hasPendingApprovalRequest 问的是
      // 「在它之前是否已有待批」——正是「这段等待是不是刚开始」。
      const isNewWaitSegment = !hasPendingApprovalRequest(run.appSessionId);
      approvalRequestToSession.set(message.requestId, run.appSessionId);
      if (typeof message.toolName === 'string' && message.toolName) {
        approvalRequestToTool.set(message.requestId, message.toolName);
      }
      if (isNewWaitSegment) {
        approvalRequestedAt.set(run.appSessionId, new Date().toISOString());
      }
    }
    taskLinkage?.onSessionApproval(run.appSessionId, true);
  }
```

**(d)** `takeApprovalRequestSession` 的 `return appSessionId;` 之前补一行：

```ts
    if (appSessionId !== null) {
      approvalRequestToSession.delete(requestId);
      approvalRequestToTool.delete(requestId);
      // 最后一个待批被决定 → 等待结束；若还有别的待批则保留起点（同一段等待）。
      forgetApprovalStartIfIdle(appSessionId);
    }
```

**(e)** `clearAll`（`:564-571`）加一行：

```ts
  clearAll(): void {
    runs.clear();
    approvalRequestToSession.clear();
    approvalRequestToTool.clear();
    approvalRequestedAt.clear();
  },
```

**(f)** 在 `listPendingApprovalSessions` 之后（`:459` 之后）新增导出方法：

```ts
  /**
   * 「等你批准」这条提醒从什么时候开始。任务服务把它派生成任务行的
   * `attention_since`，收件箱据此显示产生时刻。返回 ISO 串；该会话当前不在
   * 等待中（或请求早于本进程启动）时返回 null —— 调用方据此不显示时间，
   * 而不是编一个。
   */
  getApprovalRequestedAt(appSessionId: string): string | null {
    return approvalRequestedAt.get(appSessionId) ?? null;
  },
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/chat-run-registry.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 9 / # pass 9 / # fail 0`（原 3 + 新 6）

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/websocket/services/chat-run-registry.service.ts backend/server/modules/websocket/tests/chat-run-registry.test.ts
git commit -m "feat(websocket): record when a session starts waiting on an approval" -- backend/server/modules/websocket/services/chat-run-registry.service.ts backend/server/modules/websocket/tests/chat-run-registry.test.ts
```

---

### Task 2: 后端 decorate 派生 `attention_since`

**Files:**
- Modify: `backend/server/shared/types.ts:998-1006`（`TaskRow` 加字段）
- Modify: `backend/server/modules/tasks/services/tasks.service.ts:185-191`（注入声明）、`:228`（缺省值）、`:260-288`（`decorate`）
- Test: `backend/server/modules/tasks/tests/execution-linkage.test.ts`（追加在 `approval_pending defaults to false…` 测试之后，约 241 行）

- [ ] **Step 1: 写失败测试**

在 `execution-linkage.test.ts` 的 `test('approval_pending defaults to false when no pending-sessions source is wired', …)` 之后追加：

```ts
// ---------------------------------------------------------------------------
// 收件箱条目要显示「这条提醒什么时候产生的」：decorate 统一派生 attention_since。
// 审批等待是纯实时的，取 registry 记的等待起点；其余信号取 updated_at —— 每次
// 状态转移都与它同一条 UPDATE 写入，本就等于进入该状态的时刻。
// ---------------------------------------------------------------------------

test('attention_since uses the registry wait start while an approval is pending', () => {
  const rows = [makeRow({ task_id: 't1', status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'Bash']]),
    getApprovalRequestedAt: (sessionId) => (sessionId === 's1' ? '2026-02-02T03:04:05.000Z' : null),
  });
  assert.equal(svc.getTask('t1')?.attention_since, '2026-02-02T03:04:05.000Z');
});

test('attention_since falls back to updated_at for non-approval signals', () => {
  const rows = [
    makeRow({ task_id: 't1', status: 'in_progress', sub_status: 'failed', updated_at: '2026-03-03T03:03:03.000Z' }),
  ];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map(),
    getApprovalRequestedAt: () => null,
  });
  const list = svc.listTasks();
  assert.equal(list[0].attention_since, '2026-03-03T03:03:03.000Z');
});

test('attention_since is null when the approval start is unknown, not a fabricated time', () => {
  const rows = [makeRow({ task_id: 't1', status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
    // 请求早于本进程启动等情况下 registry 没有记录。
    getApprovalRequestedAt: () => null,
  });
  assert.equal(svc.getTask('t1')?.attention_since, null);
});

test('attention_since is null when the approval start source is not wired at all', () => {
  const rows = [makeRow({ task_id: 't1', status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'Bash']]),
  });
  assert.equal(svc.getTask('t1')?.attention_since, null);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/execution-linkage.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: 4 条新测试全 `not ok`（`attention_since` 为 `undefined`，`assert.equal` 走 `node:assert/strict` 的严格比较，`undefined !== null` 也判失败）；原 30 条仍绿。

- [ ] **Step 3: 加类型字段**

`backend/server/shared/types.ts` 的 `pending_tool` 之后、`session_deleted` 之前插入：

```ts
  /**
   * Realtime-only (never persisted): when the attention signal on this row
   * started, as a canonical ISO string — what the task inbox renders as
   * "12 分钟前". An approval wait takes it from the chat run registry (the
   * moment the first pending request arrived); every other signal takes
   * `updated_at`, which each state transition writes in the same UPDATE the
   * tag change rides on. Null when the moment is genuinely unknown (a pending
   * approval whose request predates this process) — consumers must render
   * nothing rather than invent a time.
   */
  attention_since?: string | null;
```

- [ ] **Step 4: 加注入声明与缺省值**

`tasks.service.ts` 的 `getPendingApprovalSessions?` 声明之后（`:191` 之后）加：

```ts
    /**
     * 「等你批准」这条提醒从什么时候开始等（ISO 串）。由 chat run registry 提供，
     * 用来给审批等待态的任务行派生 `attention_since`。返回 null 表示该会话不在
     * 等待中、或时刻不可知（例如请求早于本进程启动）——此时不显示时间。
     * 与 getPendingApprovalSessions 一样可选，缺省不接线时审批行不带时刻。
     */
    getApprovalRequestedAt?: (sessionId: string) => string | null;
```

`:228` 的 `pendingApprovalSessions` 之后加：

```ts
  const approvalRequestedAt = opts.getApprovalRequestedAt ?? (() => null);
```

- [ ] **Step 5: 在 decorate 里派生**

`decorate()` 里 `const sessionDeleted = …` 之后加：

```ts
    // 「这条提醒什么时候产生的」。审批等待是纯实时的（不落库），只有 registry
    // 记着这段等待的起点；其余信号的 updated_at 就是进入该状态的时刻 —— 每次
    // 转移（verdict 写入 / in_review / waiting_* 持久化）都与它同一条 UPDATE 写入。
    const attentionSince = approvalPending && row.session_id
      ? approvalRequestedAt(row.session_id as string)
      : row.updated_at;
```

并把 `return { ...row, … }` 改为：

```ts
    return {
      ...row,
      approval_pending: approvalPending,
      pending_tool: pendingTool,
      sub_status: subStatus,
      session_deleted: sessionDeleted,
      attention_since: attentionSince,
    };
```

（`row.updated_at` 在 `TaskRow` 上是必填 string，非审批路径不会是 undefined；审批路径取不到时刻时为 null。）

- [ ] **Step 6: 跑测试确认绿**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/execution-linkage.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 34 / # pass 34 / # fail 0`（原 30 + 新 4）

- [ ] **Step 7: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/shared/types.ts backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/execution-linkage.test.ts
git commit -m "feat(tasks): derive attention_since when decorating task rows" -- backend/server/shared/types.ts backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/execution-linkage.test.ts
```

---

### Task 3: 接线（registry → tasks service）

**Files:**
- Modify: `backend/server/index.js:546-548`

- [ ] **Step 1: 接线**

`backend/server/index.js` 里现有的：

```js
    // Reconstruct the board's "等你批准" overlay on load/reconnect by reading
    // which sessions currently have pending tool approvals from the run registry.
    getPendingApprovalSessions: () => chatRunRegistry.listPendingApprovalSessions(),
```

之下补一行：

```js
    // 收件箱「等你批准」条目显示的产生时刻：registry 记的等待起点。漏了这行不会
    // 报错（可选注入），只是审批条目永远不显示时间 —— 验收时必须实测这一条。
    getApprovalRequestedAt: (sessionId) => chatRunRegistry.getApprovalRequestedAt(sessionId),
```

- [ ] **Step 2: 确认接线在位**

Run: `cd /mnt/b/workdir/github/lovdex/backend && grep -n "getApprovalRequestedAt" server/index.js`
Expected: 恰好 1 行，形如 `548:    getApprovalRequestedAt: (sessionId) => chatRunRegistry.getApprovalRequestedAt(sessionId),`

- [ ] **Step 3: 跑后端全量任务/会话套件确认没砸到别的**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/*.test.ts server/modules/websocket/tests/*.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: `# fail 0`，无 `not ok`

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/index.js
git commit -m "feat(server): wire the approval wait start into the tasks service" -- backend/server/index.js
```

---

### Task 4: 前端类型 + `AttentionItem.since`

**Files:**
- Modify: `web/src/types/app.ts:148-155`（`pending_tool` 附近）
- Modify: `web/src/components/tasks/taskInbox.ts:10-16`（类型）、`:47-63`（两条 push）
- Test: `web/src/components/tasks/taskInbox.test.ts`（追加到文件末尾）

- [ ] **Step 1: 写失败测试**

在 `taskInbox.test.ts` 末尾追加：

```ts
// —— 条目产生时刻：由后端 decorate 派生，前端只透传（映射规则不在此重复推导） ——

test('carries attention_since through to the attention item', () => {
  const [item] = attentionItems(
    [mkTask({ task_id: 'x', status: 'in_progress', sub_status: 'failed', attention_since: '2026-09-16T11:48:00.000Z' })],
    NOW,
  );
  assert.equal(item.since, '2026-09-16T11:48:00.000Z');
});

test('since is null when the backend could not derive a moment', () => {
  // 审批行取不到等待起点时后端给 null；前端不得回退到别的字段编时间。
  const [item] = attentionItems(
    [mkTask({ task_id: 'x', status: 'in_progress', sub_status: 'waiting_approval', session_id: 's1' })],
    NOW,
  );
  assert.equal(item.since, null);
  const [older] = attentionItems(
    [mkTask({ task_id: 'y', status: 'in_progress', sub_status: 'failed' })],
    NOW,
  );
  assert.equal(older.since, null);
});

test('overdue items carry no since — a deadline date has no moment', () => {
  const [item] = attentionItems(
    [mkTask({ task_id: 'o1', status: 'todo', deadline: '2026-09-15', attention_since: '2026-09-16T11:48:00.000Z' })],
    NOW,
  );
  assert.equal(item.signal, 'overdue');
  assert.equal(item.since, null, '逾期用「已逾期 N 天」表达，不做成时刻');
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskInbox.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: 三条新测试 `not ok`（`item.since` 为 `undefined`）；原 8 条仍绿。

- [ ] **Step 3: 加 web 类型字段**

`web/src/types/app.ts` 的 `pending_tool?` 声明之后、`session_deleted?` 之前插入：

```ts
  /**
   * Realtime-only (server-decorated, never persisted): when the attention
   * signal on this row started, as a canonical ISO string — the task inbox
   * renders it as "12 分钟前" with the exact time on hover. Backend-derived
   * only: an approval wait takes it from the run registry, every other signal
   * takes `updated_at`. Null means the moment is genuinely unknown — render
   * nothing, never substitute another field.
   */
  attention_since?: string | null;
```

- [ ] **Step 4: `taskInbox.ts` 透传**

`AttentionItem` 类型加一行（`action` 之后）：

```ts
  /**
   * 该条提醒「进入当前状态」的时刻（ISO 串）。后端 decorate 派生的
   * `attention_since` 直接透传 —— 信号到时间戳的映射只在后端一处，前端不重复
   * 推导（两处判据迟早漂移）。纯逾期条目恒为 null：deadline 是日期不是时刻。
   */
  since: string | null;
```

`sub_status` 分支的 push 改为：

```ts
      items.push({
        task,
        signal: sub,
        label: SUB_STATUS_META[sub].label,
        tone,
        action: actionFor(sub, task),
        since: task.attention_since ?? null,
      });
```

逾期分支的 push 加一行：

```ts
        items.push({
          task,
          signal: 'overdue',
          label: info.label,
          tone: 'late',
          action: task.status === 'todo' ? 'start' : canOpenSession(task) ? 'openSession' : 'openTask',
          since: null,
        });
```

- [ ] **Step 5: 跑测试确认绿**

Run: `cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskInbox.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 11 / # pass 11 / # fail 0`（原 8 + 新 3）

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/types/app.ts web/src/components/tasks/taskInbox.ts web/src/components/tasks/taskInbox.test.ts
git commit -m "feat(tasks): carry the attention start moment into inbox items" -- web/src/types/app.ts web/src/components/tasks/taskInbox.ts web/src/components/tasks/taskInbox.test.ts
```

---

### Task 5: 面板把 task_id 换成产生时间

**Files:**
- Modify: `web/src/components/tasks/TaskInboxPanel.tsx:1`（import）、`:103-105`（渲染）
- Test: `web/src/components/tasks/TaskInboxPanel.test.tsx`（追加到文件末尾）

- [ ] **Step 1: 写失败测试**

在 `TaskInboxPanel.test.tsx` 末尾追加。注意用带 `Z` 的 `now` 构造，让相对时间与运行机器的时区无关：

```ts
// —— 行末显示产生时间，不再显示 task_id ——
// now 用带 Z 的 ISO 串构造、updated_at 也带 Z：相对时间差与运行机器的时区无关
// （文件顶部的 NOW 是裸串，JS 按本地时间解析，跨时区会漂）。
const NOW_Z = new Date('2026-09-16T12:00:00.000Z');

test('renders the moment an item appeared instead of its task id', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [
        mkTask({
          // 36 字符的 id 而不是 'f1'：断言「界面上找不到它」时要保证这个子串
          // 不会顺带出现在别处（如 className / 时间文案）。
          task_id: 'f1000000-aaaa-4bbb-8ccc-dddddddddddd',
          title: '失败的任务',
          status: 'in_progress',
          sub_status: 'failed',
          updated_at: '2026-09-16T11:48:00.000Z',
          attention_since: '2026-09-16T11:48:00.000Z',
        }),
      ],
      now: NOW_Z,
      onRetry: () => {},
    }),
  );
  assert.match(html, /12 分钟前/);
  assert.doesNotMatch(html, /f1000000-aaaa-4bbb-8ccc-dddddddddddd/, 'task_id 不再上屏');
});

test('hovers the exact time on the relative one', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [
        mkTask({
          task_id: 'f2',
          status: 'in_progress',
          sub_status: 'failed',
          updated_at: '2026-09-16T11:48:00.000Z',
          attention_since: '2026-09-16T11:48:00.000Z',
        }),
      ],
      now: NOW_Z,
      onRetry: () => {},
    }),
  );
  assert.match(html, /title="[^"]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}"/);
});

test('omits the time when the moment is unknown', () => {
  // 审批行取不到等待起点 → since 为 null → 不渲染时间，也不退回 task_id。
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [
        mkTask({
          task_id: 'w1000000-aaaa-4bbb-8ccc-dddddddddddd',
          title: '等待批准的任务',
          status: 'in_progress',
          sub_status: 'waiting_approval',
          session_id: 's1',
          attention_since: null,
        }),
      ],
      now: NOW_Z,
      onOpenSession: () => {},
    }),
  );
  assert.match(html, /等待批准的任务/);
  assert.doesNotMatch(html, /w1000000-aaaa-4bbb-8ccc-dddddddddddd/);
  assert.doesNotMatch(html, /分钟前|刚刚|\d{4}-\d{2}-\d{2}/, '时刻不可知时不显示任何时间');
});

test('overdue items keep their 已逾期 label and render no time', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'o1', status: 'todo', deadline: '2026-09-15' })],
      now: NOW_Z,
      onStart: () => {},
    }),
  );
  assert.match(html, /已逾期 1 天/);
  assert.doesNotMatch(html, /分钟前|小时前/);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: 「renders the moment…」`not ok`（找不到 `12 分钟前`，且 `f1` 仍在上屏）；原 18 条仍绿。

- [ ] **Step 3: 改 import**

`TaskInboxPanel.tsx:1-7` 的 import 区，在 `import { attentionItems, … } from './taskInbox';` 之后加：

```ts
import { formatAbsoluteTime, formatRelativeTime } from './taskTimestamp';
```

- [ ] **Step 4: 换渲染**

把 `TaskInboxPanel.tsx:103-105`：

```tsx
              <span className="hidden shrink-0 text-2xs text-muted-foreground sm:inline">
                {item.task.task_id}
              </span>
```

替换为：

```tsx
              {/* 这条提醒「什么时候产生的」。`since` 为 null 表示时刻不可知
                  （例如审批请求早于后端进程启动）——此时整颗元素不渲染，
                  不退回 task_id、也不编一个时间。窄屏同样显示：手机上
                  「不知道什么时候产生」一样成立，且时间文案比 36 字符的
                  UUID 短得多。相对时间由父级 TaskBoard 每分钟重算（now prop）。 */}
              {item.since && (
                <span
                  className="shrink-0 text-2xs text-muted-foreground"
                  title={formatAbsoluteTime(item.since)}
                >
                  {formatRelativeTime(item.since, now)}
                </span>
              )}
```

三处关键差别：去掉 `hidden … sm:inline`（窄屏也显示）、内容从 `item.task.task_id` 换成相对时间、外层加 `item.since &&` 门（时刻不可知时不留空壳）。

- [ ] **Step 5: 跑测试确认绿**

Run: `cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 22 / # pass 22 / # fail 0`（原 18 + 新 4）

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskInboxPanel.tsx web/src/components/tasks/TaskInboxPanel.test.tsx
git commit -m "feat(tasks): show when an inbox item appeared instead of its task id" -- web/src/components/tasks/TaskInboxPanel.tsx web/src/components/tasks/TaskInboxPanel.test.tsx
```

---

### Task 6: 全量回归 + 实测

**Files:** 无改动（只跑检查）

- [ ] **Step 1: 四个目标套件一起跑**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/chat-run-registry.test.ts server/modules/tasks/tests/execution-linkage.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx src/components/tasks/taskInbox.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"
```
Expected: `# fail 0`；计数依次为 9 / 34 与 22 / 11。

- [ ] **Step 2: 更广的回归（任务 + 会话 + 收件箱相关）**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/*.test.ts server/modules/websocket/tests/*.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/*.test.ts src/components/tasks/*.test.tsx src/components/inbox/*.test.ts src/components/inbox/*.test.tsx 2>&1 | grep -E "^# (tests|pass|fail)|not ok"
```
Expected: 两侧 `# fail 0`。若出现失败，先判断是不是改动前就红（对照上面的基线），**不要**顺手修无关的既有失败。

- [ ] **Step 3: typecheck 与 lint（零新增）**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
cd /mnt/b/workdir/github/lovdex/web && npx eslint src/components/tasks/TaskInboxPanel.tsx src/components/tasks/taskInbox.ts src/types/app.ts 2>&1 | tail -5
```
Expected: backend 仍是 **14**（既有基线，未新增）；web 是 **0**；eslint 无输出。

- [ ] **Step 4: 实测（需要用户许可才能重启后端）**

改到了后端进程内的文件，必须重启后端与前端 dev server 才看得到效果。**先问用户**，得到许可后再动（重启后端不是长期授权，每次都要问）。

1. 重启后端（让 supervisor 拉起）与 frontend（vite 在 `:5188`，代理到后端 `:3188`）。
2. 浏览器打开任务页，确认「需要你处理」每行末尾是相对时间（如「12 分钟前」），悬停出精确时间（如「2026-09-28 14:20」）。
3. **审批条目专测**（Task 3 的接线漏了不报错，只能实测）：在某个关联会话里触发一次需要批准的 tool（如 Bash 写操作），任务页该条应从「刚刚」起算；等 1 分钟后重看，应变成「1 分钟前」（证明它取的是等待起点，不是页面加载时刻）。
4. 点「批准 / 拒绝」后该条消失（既有行为）；再触发一次待批，时间应重新从「刚刚」起算（新的等待段）。
5. 逾期条目仍显示「已逾期 N 天」、该位置留空。
6. 375px 窄屏：一行不被时间挤坏，动作按钮仍可点。

- [ ] **Step 5: 把实测结果记入 spec 或计划（可选但推荐）**

若实测发现与设计不符（例如窄屏挤坏），在 spec 的「已知取舍」里补一条记录实际结论，并提交：

```bash
cd /mnt/b/workdir/github/lovdex
git add docs/superpowers/specs/2026-09-28-task-inbox-item-time-design.md
git commit -m "docs(tasks): record the inbox item time verification" -- docs/superpowers/specs/2026-09-28-task-inbox-item-time-design.md
```

---

## 完成标准

- 四个目标套件计数：registry 9、execution-linkage 34、TaskInboxPanel 22、taskInbox 11，全绿。
- backend tsc 仍为 14 个既有错误（零新增）、web tsc 0。
- 任务页「需要你处理」每行末尾显示相对时间、悬停显示精确时间、不再出现 task_id；审批条目实测显示的是等待起点；逾期条目不显示时间。
- 五个 commit 各自只含本计划列出的文件，未夹带工作区里 quick-replies 的未提交改动。
