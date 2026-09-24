# 收件箱「忽略」动作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收件箱失败条目获得非破坏性退出口——「忽略」= 归档（提醒消失、历史保留）。

**Architecture:** 前端 `TaskInboxPanel` 失败条目（`signal==='failed'`）渲染次级按钮「🗄 忽略」，点击走既有 `PATCH /api/tasks/:id {status:'archived'}` → 后端 `applyStatusChange`。唯一领域改动：归档进入守卫从「仅 done」放宽为「done 或已结算失败运行（in_progress + 持久化 sub_status='failed'）」。归档后 `filterTasks`（默认 `showArchived=false`）自动把任务滤出收件箱/看板；运行记录（`runsOf` 不筛状态）保留该行。无 schema 变更、无新端点。

**Tech Stack:** Node.js + TypeScript（backend，tsx 跑 node:test）；React + Vite（web，node:test + renderToStaticMarkup 静态渲染测试，无 DOM）。

**Spec:** `docs/superpowers/specs/2026-09-24-inbox-ignore-action-design.md`

**仓库约定：** commit message 英文、**不加** Co-Authored-By。工作区有并发会话的未提交改动——`git add` 只加本计划明确列出的文件，绝不 `git add -A`。

---

### Task 1: 后端——放宽归档进入守卫（TDD）

**Files:**
- Modify: `backend/server/modules/tasks/services/tasks.service.ts`（`applyStatusChange` 内 archived 守卫，约 358-366 行）
- Test: `backend/server/modules/tasks/tests/tasks.service.test.ts`（stub 系列，追加在 `startExecution on an archived task is rejected` 测试之后，约 463 行）

- [ ] **Step 1: 写失败测试**

在 `tasks.service.test.ts` 的 `test('startExecution on an archived task is rejected', ...)` 之后追加：

```ts
test('applyStatusChange archives a settled failed run and hides its linked session', () => {
  // 收件箱「忽略」= 归档：失败运行（in_progress + 持久化 failed）必须能进 archived，
  // 且沿 done 归档同一条副作用路径隐藏关联会话。
  const { db } = makeDbStub();
  const archivedCalls: Array<[string, boolean]> = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      sessionsDb: {
        updateSessionIsArchived: (sessionId: string, isArchived: boolean) => {
          archivedCalls.push([sessionId, isArchived]);
        },
      },
    } as unknown as Parameters<typeof createTasksService>[1]['deps'],
  });
  db.updateTaskStatus('t1', 'in_progress');
  db.updateTaskSubStatus('t1', 'failed');
  db.linkSession('t1', 's1');
  svc.applyStatusChange('t1', 'archived', 'user');
  assert.equal(db.getTask('t1')?.status, 'archived');
  assert.equal(db.getTask('t1')?.sub_status, null, '归档清掉失败标签');
  assert.deepEqual(archivedCalls, [['s1', true]], '失败归档与 done 归档走同一条会话隐藏路径');
});

test('applyStatusChange still rejects archiving a genuinely running task', () => {
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: () => {} });
  db.updateTaskStatus('t1', 'in_progress'); // sub_status 持久化值为 null → 真在跑
  assert.throws(() => svc.applyStatusChange('t1', 'archived', 'user'), /only completed tasks can be archived/);
  assert.equal(db.getTask('t1')?.status, 'in_progress');
});

test('applyStatusChange still rejects archiving a blocked task', () => {
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: () => {} });
  db.updateTaskStatus('t1', 'in_progress');
  db.updateTaskSubStatus('t1', 'blocked');
  assert.throws(() => svc.applyStatusChange('t1', 'archived', 'user'), /only completed tasks can be archived/);
});

test('applyStatusChange rejects un-archiving into anything but done', () => {
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: () => {} });
  db.updateTaskStatus('t1', 'done');
  svc.applyStatusChange('t1', 'archived', 'user');
  assert.throws(() => svc.applyStatusChange('t1', 'in_progress', 'user'), /can only return to done/);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/tasks.service.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: `not ok` 出现在「archives a settled failed run」（守卫仍拒绝失败归档），其余三条绿（它们钉的是不变行为）。原有用例数 67 + 4 = 71。

- [ ] **Step 3: 放宽守卫**

`tasks.service.ts` 中把：

```ts
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
```

替换为：

```ts
    // archived 是纯用户动作：done 能进，「已结算的失败运行」也能进 —— 收件箱失败
    // 条目的「忽略」= 归档（提醒消失、历史保留，见 spec 2026-09-24-inbox-ignore-action）。
    // 其余状态照旧拒绝；archived 只能出（回 done），引擎永不写入 archived（double guard）。
    // 取消归档回 done 而非 failed：失败标签已在归档转变时清掉，不复活（认账语义）。
    if (status === 'archived') {
      if (actor !== 'user') {
        throw new AppError('only a user can archive a task', { code: 'INVALID_STATUS', statusCode: 400 });
      }
      const failedSettled = row.status === 'in_progress' && row.sub_status === 'failed';
      if (row.status !== 'done' && !failedSettled) {
        throw new AppError(`only completed tasks can be archived (current: ${row.status})`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
    } else if (row.status === 'archived') {
```

注意 `row` 是裸 DB 行，`sub_status` 是持久化子集——等待审批的会话持久化值为 null，天然被拒，无需额外判断。

- [ ] **Step 4: 跑测试确认绿**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/tasks.service.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 71 / # pass 71 / # fail 0`

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/backend
git add server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): allow settled failed runs to be archived"
```

---

### Task 2: 后端——真库集成回归（failed 运行归档全链路）

**Files:**
- Test: `backend/server/modules/tasks/tests/tasks.service.status.test.ts`（追加在 `moveTask to a different column clears sub_status` 测试之后，约 171 行）

- [ ] **Step 1: 写集成测试**

在 `test('moveTask to a different column clears sub_status', ...)` 之后追加：

```ts
test('archived failed run keeps the row, clears the persisted failed tag', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed'); // 两层状态：in_progress + 持久化 failed
    assert.equal(tasksDb.getTask(id)?.sub_status, 'failed');
    svc.applyStatusChange(id, 'archived', 'user');
    assert.equal(tasksDb.getTask(id)?.status, 'archived');
    assert.equal(tasksDb.getTask(id)?.sub_status, null);
    // 关联会话 's1' 在测试库不存在（悬空外键）——归档副作用必须容忍并跳过，不阻断。
    assert.equal(svc.getTask(id)?.status, 'archived');
  });
});
```

- [ ] **Step 2: 跑测试确认绿**（Task 1 已实现，此测试是真库回归锁）

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/tasks.service.status.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: 23 → 24 个测试全绿。

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/backend
git add server/modules/tasks/tests/tasks.service.status.test.ts
git commit -m "test(tasks): cover archiving a failed run against the real db"
```

---

### Task 3: 前端——收件箱「忽略」按钮（TDD）

**Files:**
- Modify: `web/src/components/tasks/taskInbox.ts:7`（`AttentionAction` 联合类型加 `'ignore'`）
- Modify: `web/src/components/tasks/TaskInboxPanel.tsx`（props / ACTION_META / handlers / 渲染）
- Test: `web/src/components/tasks/TaskInboxPanel.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `TaskInboxPanel.test.tsx` 的 `test('omits the action button when the matching handler is not provided', ...)` 之后追加：

```ts
test('failed item with onIgnore offers 忽略 next to 重试', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'f1', status: 'in_progress', sub_status: 'failed' })],
      now: NOW,
      onRetry: () => {},
      onIgnore: () => {},
    }),
  );
  assert.match(html, /↻ 重试/);
  assert.match(html, /🗄 忽略/);
});

test('failed item without onIgnore does not render 忽略', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'f1', status: 'in_progress', sub_status: 'failed' })],
      now: NOW,
      onRetry: () => {},
    }),
  );
  assert.match(html, /↻ 重试/);
  assert.doesNotMatch(html, /忽略/);
});

test('blocked item does not render 忽略 even with onIgnore provided', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'b1', status: 'in_progress', sub_status: 'blocked' })],
      now: NOW,
      onIgnore: () => {},
    }),
  );
  assert.doesNotMatch(html, /忽略/);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /mnt/b/workdir/github/lovdex/web && TSX_TSCONFIG_PATH=tsconfig.json npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx 2>&1 | grep -E "^# (tests|pass|fail)|not ok"`
Expected: 第一个测试 `not ok`（onIgnore 不是合法 prop / 按钮不存在），后两个绿。

- [ ] **Step 3: 实现**

`web/src/components/tasks/taskInbox.ts` 第 7 行：

```ts
export type AttentionAction = 'retry' | 'start' | 'accept' | 'ignore' | 'openSession' | 'openTask';
```

（`attentionItems` 不产出 `'ignore'` 作为主动作——它永远是次级动作，按 `signal==='failed'` 条件渲染。）

`TaskInboxPanel.tsx` 四处：

① props 类型（`TaskInboxPanelProps`，`onAccept` 之后）：

```ts
  onAccept?: (task: Task) => void;
  onIgnore?: (task: Task) => void;
```

② `ACTION_META`（`accept` 行之后）：

```ts
  ignore:      { label: '🗄 忽略', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
```

③ 函数签名解构 + handlers 映射：

```ts
export function TaskInboxPanel({
  tasks, now, projectOptions = [], onRetry, onStart, onAccept, onIgnore, onOpenSession, onOpenTask,
}: TaskInboxPanelProps) {
```

```ts
  const handlers: Record<AttentionAction, ((task: Task) => void) | undefined> = {
    retry: onRetry,
    start: onStart,
    accept: onAccept,
    ignore: onIgnore,
    openSession: onOpenSession,
    openTask: onOpenTask,
  };
```

④ 渲染：在 `const showOpenSession = ...` 之后加一行，按钮插在「打开会话」按钮**之前**：

```ts
          const showIgnore = item.signal === 'failed' && item.action !== 'ignore' && !!onIgnore;
```

```tsx
                  {showIgnore && onIgnore && (
                    <button
                      type="button"
                      onClick={() => onIgnore(item.task)}
                      className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold transition-colors ${ACTION_META.ignore.className}`}
                    >
                      {ACTION_META.ignore.label}
                    </button>
                  )}
```

（`item.action !== 'ignore'` 的哨兵照抄 `showOpenSession` 的写法，防未来把 ignore 变成主动作后出现双按钮。）

- [ ] **Step 4: 跑测试确认绿**

Run: `cd /mnt/b/workdir/github/lovdex/web && TSX_TSCONFIG_PATH=tsconfig.json npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx src/components/tasks/taskInbox.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 全绿（TaskInboxPanel 现有 10+3、taskInbox 既有数量不变）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/web
git add src/components/tasks/taskInbox.ts src/components/tasks/TaskInboxPanel.tsx src/components/tasks/TaskInboxPanel.test.tsx
git commit -m "feat(web): offer an ignore (archive) action on failed inbox items"
```

---

### Task 4: 前端——TaskBoard 接线

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`（`TaskInboxPanel` 调用处，约 457-466 行）

- [ ] **Step 1: 传 onIgnore**

`TaskBoard.tsx` 的 `<TaskInboxPanel ...>` 里，`onAccept={(task) => updateStatus(task, 'done')}` 之后加一行（与相邻行同款写法，不额外加 void）：

```tsx
            onAccept={(task) => updateStatus(task, 'done')}
            onIgnore={(task) => updateStatus(task, 'archived')}
```

（`updateStatus` → `api.tasks.update` → PATCH → `applyStatusChange`，链路已在后端放开。）

- [ ] **Step 2: 验证**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | head -5`
Expected: 无输出（typecheck 干净）。

Run: `cd /mnt/b/workdir/github/lovdex/web && TSX_TSCONFIG_PATH=tsconfig.json npx tsx --test src/components/tasks/*.test.ts src/components/tasks/*.test.tsx 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 全绿（362 + 新增 3）。

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/web
git add src/components/tasks/TaskBoard.tsx
git commit -m "feat(web): wire the inbox ignore action to task archiving"
```

---

### Task 5: 全量验收

- [ ] **Step 1: 后端 tasks 模块 + operator-delete 全量**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/*.test.ts server/modules/operators/tests/operator-delete.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 全绿。

- [ ] **Step 2: 双端 typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"` → 记下数字 N1，与改动前基线一致（本工作区当前 14，其中 tasks 相关仅 status.test.ts 一条**既有**错误）。
Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json` → 无输出。

- [ ] **Step 3: lint 只看本计划触碰的文件**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx eslint src/components/tasks/taskInbox.ts src/components/tasks/TaskInboxPanel.tsx src/components/tasks/TaskBoard.tsx 2>&1 | tail -3`
Expected: 0 errors（warning 允许，须为既有 warning）。

- [ ] **Step 4: 汇报生效条件**

后端改动需重启后端才生效（用户手动重启，避开 :19/:49 定时派发窗口）；前端 vite 热更新即时生效。汇报时写明。

---

## Self-Review 记录

- **Spec 覆盖**：交互（忽略按钮/无确认框/signal 条件）→ Task 3+4；后端守卫放宽 → Task 1；连带效果自查（spec 表格 6 项）→ Task 1 实现 + Task 2 回归锁；测试计划 6 条 → Task 1（1-4 的规则表）、Task 2（真库）、Task 3（5-6）；spec 影响面「taskInbox.ts AttentionAction 加 ignore」→ Task 3 Step 3 ①。无缺口。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；无「参照 Task N」。
- **类型一致性**：`onIgnore?: (task: Task) => void` 在 Task 3 定义、Task 4 消费，签名一致；`ACTION_META.ignore` 键与 `'ignore'` 联合成员一致；stub 测试的 `updateSessionIsArchived(sessionId, isArchived)` 签名与 `sessionsDb` 仓库方法一致。
