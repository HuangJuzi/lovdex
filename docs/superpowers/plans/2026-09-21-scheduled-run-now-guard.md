# 定时任务「立即触发」运行中守卫 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时任务的上一轮还没结束时，拒绝再次触发（后端 409 权威守卫 + 前端禁用态），防止误触派出第二个 agent。

**Architecture:** 后端在 `scheduler.service.runNow` 里加两道守卫 —— ①读上一轮任务行（`getTask` 的 decorate 后行）判断 `in_progress && sub_status !== 'failed'`，再叠一道 `isSessionRunning` 覆盖「人工把在跑的任务标成 done」；②一个进程内的在途集合挡住连点/跨标签页（`last_task_id` 要到 dispatch 末尾才落库）。前端把同一判据做成纯函数算禁用态，并加在途闸门与内联错误条。**守卫只加在 `runNow`，不动 `dispatch`** —— 自动到点补跑的行为不变。

**Tech Stack:** TypeScript（后端 ESM + tsx，前端 React 18 + vite）、`node:test` + `node:assert/strict`（前后端同一套测试运行器，无 DOM）、Express、`renderToStaticMarkup` 做静态标记断言。

**Spec:** `docs/superpowers/specs/2026-09-21-scheduled-run-now-guard-design.md`

---

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `backend/server/modules/scheduler/services/scheduler.service.ts` | 改 | `isRunActive` 纯函数、`blockingRunOf`、`runNow` 两道守卫、deps 扩两项 |
| `backend/server/modules/scheduler/tests/scheduler.service.test.ts` | 改 | fake 补 `getTask`/`isSessionRunning`；守卫与闸门的测试 |
| `backend/server/modules/scheduler/tests/scheduler.routes.test.ts` | 改 | 补错误中间件 + 409 透出断言 |
| `backend/server/index.js` | 改 | 给 `createSchedulerService` 注入 `isSessionRunning` |
| `web/src/components/tasks/scheduleRunNow.ts` | 新建 | 三个纯函数：`blockingRunsBySchedule` / `runNowBlockedReason` / `runNowErrorMessage` |
| `web/src/components/tasks/scheduleRunNow.test.ts` | 新建 | 上面三个的逐分支单测 |
| `web/src/components/tasks/ScheduledTasksView.tsx` | 改 | 禁用态（两套布局）+ 错误条 + `ActionButton` 支持 `disabled` |
| `web/src/components/tasks/ScheduledTasksView.test.tsx` | 改 | 禁用态与错误条的静态标记断言 |
| `web/src/components/tasks/ScheduledTasksPanel.tsx` | 改 | 算 `blockedRuns`、在途闸门（ref+state）、`runNow` 接线 |

**为什么纯函数要单独成文件**（`scheduleRunNow.ts`）：放进 `ScheduledTasksView.tsx` 会触发 `react-refresh/only-export-components`（该文件目前只导出组件与类型，是干净的）；web 测试无 DOM、不跑 effect、不触发事件，所以逻辑必须离开组件才测得到。与 `runHistoryDelete.ts` / `projectLabel.ts` 同一惯例。

**命令约定**（本仓库无 `npm test` 脚本，测试一律显式给文件；`TSX_TSCONFIG_PATH` 在环境里可能残留，先 unset）：

```bash
# 后端（在 backend/ 下跑）
cd /mnt/b/workdir/github/lovdex/backend
unset TSX_TSCONFIG_PATH
npx tsx --test --tsconfig server/tsconfig.json server/modules/scheduler/tests/scheduler.service.test.ts

# 前端（在 web/ 下跑）
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/scheduleRunNow.test.ts
```

**基线（改动前实测）**：`scheduler.service.test.ts` 29 条全绿、`scheduler.routes.test.ts` 5 条全绿、`ScheduledTasksView.test.tsx` 12 条全绿。

---

## Task 1: 后端 `isRunActive` 纯函数

**Files:**
- Modify: `backend/server/modules/scheduler/services/scheduler.service.ts`
- Test: `backend/server/modules/scheduler/tests/scheduler.service.test.ts`

- [ ] **Step 1: 写失败测试**

改 `scheduler.service.test.ts:4` 的 import，加上 `isRunActive`：

```ts
import { computeNext, createSchedulerService, isRunActive, type SchedulerDeps } from '@/modules/scheduler/services/scheduler.service.js';
```

在 `computeNext` 那条测试（`:45` 结束）之后追加：

```ts
test('isRunActive: 只把「进行中且没跑挂」当作上一轮没结束', () => {
  // 跑着 / 等你回答 / 等你确认计划 / 等你批准 / 以及各种还没走完的持久标签 —— 都挡
  for (const sub of ['running', 'waiting_answer', 'waiting_plan', 'waiting_approval', 'blocked', 'only_plan', 'needs_review'] as const) {
    assert.equal(isRunActive({ status: 'in_progress', sub_status: sub }), true, `in_progress + ${sub} 必须挡`);
  }
  // decorate() 对「在跑但没标签」的行给的就是 null
  assert.equal(isRunActive({ status: 'in_progress', sub_status: null }), true, 'in_progress + null 必须挡');
  // failed 是唯一明确的「上一轮已经终止、可以重来」
  assert.equal(isRunActive({ status: 'in_progress', sub_status: 'failed' }), false, '跑挂的必须放行');
  // 不在进行中列的一律不挡
  for (const status of ['todo', 'in_review', 'done', 'archived'] as const) {
    assert.equal(isRunActive({ status, sub_status: null }), false, `${status} 不该挡`);
  }
  assert.equal(isRunActive(null), false, '查不到上一轮任务时不挡');
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --test --tsconfig server/tsconfig.json server/modules/scheduler/tests/scheduler.service.test.ts
```

Expected: FAIL —— `SyntaxError: The requested module '.../scheduler.service.js' does not provide an export named 'isRunActive'`。

- [ ] **Step 3: 实现**

`scheduler.service.ts:7` 的 import 补 `TaskRow`：

```ts
import type { ScheduledTaskRow, TaskEngine, TaskRow } from '@/shared/types.js';
```

在 `initialNextRun`（`:67` 结束）之后、`createSchedulerService`（`:69`）之前插入：

```ts
/**
 * 「上一轮还没结束」：任务停在 in_progress 列、且没有 failed 标签。
 *
 * 入参必须是 decorate() 之后的行 —— sub_status 那时才是计算后的有效值：跑着的是
 * running、等你回答/计划是 waiting_*、跑挂的仍停在 in_progress 槽位但标 failed。
 * 所以「运行中 + 等人工都挡、跑挂的放行」就是 `!== 'failed'` 这一条，不用枚举标签。
 *
 * 注意这条判据只看任务行，看不见「会话是否真的还在流式输出」—— 人工把在跑的任务
 * 标成 done 时 status 会骗人，那一段由调用方的 isSessionRunning 兜（见 blockingRunOf）。
 */
export function isRunActive(task: Pick<TaskRow, 'status' | 'sub_status'> | null): boolean {
  return task !== null && task.status === 'in_progress' && task.sub_status !== 'failed';
}
```

- [ ] **Step 4: 跑测试，确认通过**

同上命令。Expected: PASS，`# tests 30` / `# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/scheduler/services/scheduler.service.ts backend/server/modules/scheduler/tests/scheduler.service.test.ts
git commit -m "feat(scheduled-tasks): add isRunActive predicate for the run-now guard"
```

---

## Task 2: `runNow` 的运行中守卫

**Files:**
- Modify: `backend/server/modules/scheduler/services/scheduler.service.ts`（`SchedulerDeps:10`、`runNow:358`）
- Modify: `backend/server/index.js:637-646`
- Test: `backend/server/modules/scheduler/tests/scheduler.service.test.ts`

- [ ] **Step 1: 扩 deps 类型并更新测试 fake（此时现有测试仍全绿）**

`scheduler.service.ts:10` 的 `SchedulerDeps`：

```ts
export type SchedulerDeps = {
  scheduledTasksDb: ScheduledTaskDbLike;
  tasksService: Pick<TasksService, 'createTask' | 'startExecution' | 'getTask'>;
  createSession: (provider: TaskEngine, projectPath: string, isOperator?: boolean) => string;
  startTaskRun: (taskId: string, sessionId: string) => boolean;
  broadcast: (event: { kind: string; [k: string]: unknown }) => void;
  /**
   * 会话是否仍在流式输出。必填而非可选：漏注入会让「上一轮还在跑」的守卫静默
   * 失效，而拦住第二个 agent 正是本次要做的全部事情 —— 宁可在类型层面卡住。
   */
  isSessionRunning: (sessionId: string) => boolean;
  now?: () => Date;
  /** 模板标题留空时用 LLM 从描述取名；与 tasksService 同一个契约。 */
  generateTitle?: (input: { description: string | null }) => Promise<string | null>;
  /** 单测注入口；生产走 TITLE_BLOCKING_TIMEOUT_MS（3s）。 */
  titleBlockingMs?: number;
};
```

测试文件 `:7` 的 import 补 `TaskRow`：

```ts
import type { ScheduledTaskRow, TaskRow } from '@/shared/types.js';
```

在 `mkRow`（`:22` 结束）之后加一个任务行工厂：

```ts
function mkTaskRow(over: Partial<TaskRow>): TaskRow {
  return {
    task_id: 'task-1', project_path: '/proj', title: '跑', description: null,
    status: 'todo', sub_status: null, executor_provider: 'claude', executor_model: null,
    position: 0, session_id: null, source_schedule_id: 's1', auto_approve: 0,
    started_at: null, completed_at: null,
    created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ai_summary: null, verdict_reason: null, verdict_at: null,
    priority: 'P2', deadline: null, is_operator: 0, label: 'other', remark: null,
    context_summary: null, context_source_session_id: null, context_mode: 'none',
    context_status: null, context_raw: null,
    ...over,
  };
}
```

`makeService`（`:47`）里：函数体开头加两个可注入的集合，fake 的 `tasksService` 补 `getTask`，`createSchedulerService` 调用处补 `isSessionRunning`，返回值带上这两个集合：

```ts
function makeService(nowIso: string, extra: Partial<SchedulerDeps> = {}) {
  const rows = new Map<string, ScheduledTaskRow>();
  const taskRows = new Map<string, TaskRow>();
  const runningSessions = new Set<string>();
  const createdTasks: unknown[] = [];
  const launches: Array<{ taskId: string; sessionId: string }> = [];
  const broadcasts: unknown[] = [];
```

（……`db` 定义保持不变……）

```ts
  const svc = createSchedulerService({
    scheduledTasksDb: db,
    tasksService: {
      createTask: (input: CreateTaskInput) => {
        createdTasks.push(input);
        return { task_id: 'task-1' } as unknown as ReturnType<TasksService['createTask']>;
      },
      startExecution: () => ({ sessionId: 'sess-1' }),
      // 上一轮任务的查表口：守卫读的就是它（真实实现返回 decorate() 之后的行）。
      getTask: (taskId: string) => taskRows.get(taskId) ?? null,
    },
    createSession: () => 'sess-1',
    startTaskRun: (taskId: string, sessionId: string) => { launches.push({ taskId, sessionId }); return true; },
    broadcast: (e: unknown) => broadcasts.push(e),
    now: () => new Date(nowIso),
    isSessionRunning: (sessionId: string) => runningSessions.has(sessionId),
    ...extra,
  });
  return { svc, rows, taskRows, runningSessions, createdTasks, launches, broadcasts };
}
```

跑一遍确认现有 30 条仍全绿：

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --test --tsconfig server/tsconfig.json server/modules/scheduler/tests/scheduler.service.test.ts
```

Expected: PASS，`# tests 30` / `# fail 0`（守卫还没加，行为没变）。

- [ ] **Step 2: 写失败测试**

追加到测试文件末尾：

```ts
test('runNow 拒绝在上一轮还没结束时再触发', async () => {
  const { svc, rows, taskRows, createdTasks } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('s1', mkRow({ schedule_id: 's1', last_task_id: 'task-1' }));
  taskRows.set('task-1', mkTaskRow({ task_id: 'task-1', status: 'in_progress', sub_status: 'running' }));

  await assert.rejects(
    () => svc.runNow('s1'),
    (err: unknown) => (err as { code?: string }).code === 'SCHEDULE_RUNNING',
  );
  assert.equal(createdTasks.length, 0, '被守卫挡下时不许建任务');
  assert.equal(rows.get('s1')?.last_task_id, 'task-1', '被挡下时不许动 last_task_id');
});

test('runNow 放行：上一轮跑挂 / 已结束 / 没跑过 / 任务已被删', async () => {
  // 跑挂的：仍停在 in_progress 槽位但标 failed
  const a = makeService('2026-08-13T12:00:00.000Z');
  a.rows.set('s1', mkRow({ schedule_id: 's1', last_task_id: 'task-1' }));
  a.taskRows.set('task-1', mkTaskRow({ task_id: 'task-1', status: 'in_progress', sub_status: 'failed' }));
  await a.svc.runNow('s1');
  assert.equal(a.createdTasks.length, 1, '跑挂的必须能重来');

  // 上一轮跑完进了 in_review
  const b = makeService('2026-08-13T12:00:00.000Z');
  b.rows.set('s1', mkRow({ schedule_id: 's1', last_task_id: 'task-1' }));
  b.taskRows.set('task-1', mkTaskRow({ task_id: 'task-1', status: 'in_review', sub_status: 'pending_acceptance' }));
  await b.svc.runNow('s1');
  assert.equal(b.createdTasks.length, 1);

  // 没跑过
  const c = makeService('2026-08-13T12:00:00.000Z');
  c.rows.set('s1', mkRow({ schedule_id: 's1', last_task_id: null }));
  await c.svc.runNow('s1');
  assert.equal(c.createdTasks.length, 1);

  // 上一轮的任务已被删（运行记录清理）—— 查不到就不挡
  const d = makeService('2026-08-13T12:00:00.000Z');
  d.rows.set('s1', mkRow({ schedule_id: 's1', last_task_id: 'gone' }));
  await d.svc.runNow('s1');
  assert.equal(d.createdTasks.length, 1);
});

test('runNow 挡住「人工把在跑的任务标成 done」：status 骗人，会话还在跑', async () => {
  const { svc, rows, taskRows, runningSessions, createdTasks } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('s1', mkRow({ schedule_id: 's1', last_task_id: 'task-1' }));
  taskRows.set('task-1', mkTaskRow({ task_id: 'task-1', status: 'done', sub_status: null, session_id: 'sess-live' }));
  runningSessions.add('sess-live');

  await assert.rejects(
    () => svc.runNow('s1'),
    (err: unknown) => (err as { code?: string }).code === 'SCHEDULE_RUNNING',
  );
  assert.equal(createdTasks.length, 0);
});

test('runNow 对不存在的调度返回 null（路由据此 404）', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  assert.equal(await svc.runNow('nope'), null);
});
```

- [ ] **Step 3: 跑测试，确认它失败**

同上命令。Expected: FAIL —— 前三条以 `Missing expected rejection` / `1 !== 0` 失败（`runNow` 现在无条件派发），最后一条已通过。

- [ ] **Step 4: 实现守卫**

在 `createSchedulerService` 内部、`dispatch` 定义（`:102`）之前插入：

```ts
  /**
   * 这条调度「上一轮还没结束」的那个任务；null = 可以再触发。
   *
   * 两段判据缺一不可：
   * - 任务行：in_progress 且没标 failed（见 isRunActive）。用 getTask 而非裸 DB 行，
   *   因为 decorate() 才会把 sub_status 算成 running / waiting_*。
   * - 会话：status 会骗人 —— 任务页的「标记完成」在进行中也渲染，人工把正在跑的任务
   *   标成 done 之后 status 就不是 in_progress 了，但 agent 还在同一个项目里写文件。
   *   这一段与 deleteTask / session-transfer / operator-delete 是同一个判据。
   *
   * 上一轮的任务已被删（运行记录清理）时放行：查不到就不挡。
   */
  function blockingRunOf(schedule: ScheduledTaskRow): TaskRow | null {
    const lastId = schedule.last_task_id;
    if (!lastId) return null;
    const task = deps.tasksService.getTask(lastId);
    if (!task) return null;
    if (isRunActive(task)) return task;
    if (task.session_id && deps.isSessionRunning(task.session_id)) return task;
    return null;
  }
```

把 `runNow`（`:358`）改成：

```ts
    async runNow(scheduleId: string): Promise<unknown> {
      const schedule = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!schedule) return null;
      // 上一轮还在跑就拒绝：dispatch 每次都会新建任务并起一个 agent，同一个提示词
      // 会在同一个项目里跑起第二个 agent。
      if (blockingRunOf(schedule)) {
        throw new AppError(
          `schedule ${scheduleId} still has an unfinished run; settle or interrupt it first`,
          { code: 'SCHEDULE_RUNNING', statusCode: 409 },
        );
      }
      // Awaited: createTask may block on title generation, and a dispatch failure
      // must surface to the route instead of becoming an unhandled rejection.
      await dispatch(schedule);
      return { ok: true };
    },
```

（`AppError` 已在 `:5` import，无需新增。）

- [ ] **Step 5: 跑测试，确认通过**

同上命令。Expected: PASS，`# tests 34` / `# fail 0`。

- [ ] **Step 6: 生产接线**

`backend/server/index.js:637` 的 `createSchedulerService({...})` 里，`generateTitle,` 之后补一行（与 `:540` / `:657` / `:678` 同一写法）：

```js
const schedulerService = createSchedulerService({
    scheduledTasksDb: {
        ...scheduledTasksDb,
        operatorWorkspacePath: getOperatorConfig().workspace,
    },
    tasksService,
    createSession: createAppSession,
    startTaskRun,
    broadcast: broadcastTask,
    generateTitle,
    // 「立即触发」的运行中守卫：上一轮还在流式输出时不许再派一轮。
    isSessionRunning: (sessionId) => chatRunRegistry.listRunningRuns().some((run) => run.sessionId === sessionId),
});
```

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/scheduler/services/scheduler.service.ts backend/server/modules/scheduler/tests/scheduler.service.test.ts backend/server/index.js
git commit -m "feat(scheduled-tasks): refuse run-now while the previous run is unfinished"
```

---

## Task 3: 在途闸门（连点 / 跨标签页）

**Files:**
- Modify: `backend/server/modules/scheduler/services/scheduler.service.ts`
- Test: `backend/server/modules/scheduler/tests/scheduler.service.test.ts`

- [ ] **Step 1: 写失败测试**

追加到测试文件末尾：

```ts
test('runNow 在派发途中拒绝第二次触发，结束后释放闸门', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { svc, rows, createdTasks } = makeService('2026-08-13T12:00:00.000Z', {
    tasksService: {
      createTask: async (input: CreateTaskInput) => {
        createdTasks.push(input);
        await gate; // 卡住 dispatch，模拟「第一次触发还在派发中」
        return { task_id: 'task-1' } as unknown as ReturnType<TasksService['createTask']>;
      },
      startExecution: () => ({ sessionId: 'sess-1' }),
      getTask: () => null,
    },
  });
  rows.set('s1', mkRow({ schedule_id: 's1' }));

  const first = svc.runNow('s1');
  // 第一次的 dispatch 还挂在 createTask 上：last_task_id 尚未落库，靠状态判据挡不住，
  // 只有在途闸门能挡 —— 这正是「连点两次」的真实形态。
  await assert.rejects(
    () => svc.runNow('s1'),
    (err: unknown) => (err as { code?: string }).code === 'SCHEDULE_RUNNING',
  );
  assert.equal(createdTasks.length, 1, '第二次触发不许建任务');

  release();
  await first;
  assert.equal(rows.get('s1')?.last_task_id, 'task-1', '第一次正常派发完成');

  // 闸门已释放：下一次触发照常
  await svc.runNow('s1');
  assert.equal(createdTasks.length, 2);
});
```

- [ ] **Step 2: 跑测试，确认它失败**

同上命令。Expected: FAIL —— `Missing expected rejection`（现在两次都会派发，`createdTasks.length` 变成 2）。

- [ ] **Step 3: 实现**

在 `createSchedulerService` 里 `let ticking = false;`（`:72`）之后加：

```ts
  /**
   * 派发途中的 schedule_id。
   *
   * 状态判据读的是**落库的** last_task_id，而它要到 dispatch 的最后一步才写
   * （见 dispatch 里的 updates）。两次挨得很近的触发会都读到旧值、双双放行 ——
   * 前端那道 ref 闸门只管得住同一个组件实例，跨标签页管不到。调度器是单进程，
   * 一个进程内集合就够，且覆盖整个 dispatch（含 last_task_id 的写入）。
   */
  const inFlight = new Set<string>();
```

`runNow` 在查完 schedule 之后、状态守卫之前插入在途检查，并用 try/finally 包住 dispatch：

```ts
    async runNow(scheduleId: string): Promise<unknown> {
      const schedule = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!schedule) return null;
      // 同一 tick 里的第二次点击 / 另一个标签页的并发请求 —— 状态判据这时还没看到
      // 第一次的 last_task_id，只有这道闸门能挡。
      if (inFlight.has(scheduleId)) {
        throw new AppError(
          `schedule ${scheduleId} is still dispatching; wait for it to settle`,
          { code: 'SCHEDULE_RUNNING', statusCode: 409 },
        );
      }
      if (blockingRunOf(schedule)) {
        throw new AppError(
          `schedule ${scheduleId} still has an unfinished run; settle or interrupt it first`,
          { code: 'SCHEDULE_RUNNING', statusCode: 409 },
        );
      }
      inFlight.add(scheduleId);
      try {
        // Awaited: createTask may block on title generation, and a dispatch failure
        // must surface to the route instead of becoming an unhandled rejection.
        await dispatch(schedule);
      } finally {
        inFlight.delete(scheduleId);
      }
      return { ok: true };
    },
```

- [ ] **Step 4: 跑测试，确认通过**

同上命令。Expected: PASS，`# tests 35` / `# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/scheduler/services/scheduler.service.ts backend/server/modules/scheduler/tests/scheduler.service.test.ts
git commit -m "feat(scheduled-tasks): gate concurrent run-now dispatches per schedule"
```

---

## Task 4: 路由把 409 与 code 透出

**Files:**
- Test: `backend/server/modules/scheduler/tests/scheduler.routes.test.ts`

背景（不写进代码，理解用）：现有 `POST / rejects invalid scheduleType` 那条断言能过，是因为 Express 默认错误处理（finalhandler）会读 `err.statusCode` —— 但响应体是 HTML，不是 JSON。要断言 `error.code` 就得把生产那份错误中间件（`index.js:1994`）在测试 app 里也挂上。

- [ ] **Step 1: 写失败测试**

改 `scheduler.routes.test.ts` 的 import 与 `startServer`：

```ts
import type { NextFunction, Request, Response } from 'express';

import { buildSchedulerRouter } from '@/modules/scheduler/scheduler.routes.js';
import { AppError } from '@/shared/utils.js';

async function startServer(svc: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled-tasks', buildSchedulerRouter(svc as never));
  // 镜像 index.js:1994 的生产错误处理：AppError → statusCode + { error: { code, message } }。
  // 没有它时 Express 默认处理器只认 err.statusCode、响应体是 HTML，断言不到 code。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    res.status(e.statusCode ?? 500).json({ success: false, error: { code: e.code, message: e.message } });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(r)) };
}
```

追加到文件末尾：

```ts
test('POST /:id/run-now surfaces the running guard as 409 + code', async () => {
  const svc = {
    ...makeSvc(),
    runNow: () => {
      throw new AppError('schedule s1 still has an unfinished run; settle or interrupt it first', {
        code: 'SCHEDULE_RUNNING',
        statusCode: 409,
      });
    },
  };
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1/run-now`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = await res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'SCHEDULE_RUNNING', '前端靠这个 code 说人话');
  } finally { await close(); }
});

test('POST /:id/run-now returns 404 for an unknown schedule', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/nope/run-now`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally { await close(); }
});
```

- [ ] **Step 2: 跑测试，确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --test --tsconfig server/tsconfig.json server/modules/scheduler/tests/scheduler.routes.test.ts
```

Expected: PASS，`# tests 7` / `# fail 0`。

（这两条**不需要**改生产代码：路由早就把 `AppError` 交给 `asyncHandler` → `next(err)`，是测试 app 缺了错误中间件。它们钉住的是「409 + code 真的能到客户端」这条契约，防止有人日后在路由里把错误吞掉。）

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/scheduler/tests/scheduler.routes.test.ts
git commit -m "test(scheduled-tasks): pin the run-now 409 contract at the route layer"
```

---

## Task 5: 前端纯函数模块 `scheduleRunNow.ts`

**Files:**
- Create: `web/src/components/tasks/scheduleRunNow.ts`
- Test: `web/src/components/tasks/scheduleRunNow.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `web/src/components/tasks/scheduleRunNow.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ScheduledTask, Task } from '../../types/app';
import { blockingRunsBySchedule, runNowBlockedReason, runNowErrorMessage } from './scheduleRunNow';

const schedule = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  schedule_id: 's1', title: '每日站会', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, auto_approve: 0, schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', project_path: '/proj', title: '跑', description: null,
  status: 'in_progress', sub_status: null, executor_provider: 'claude', executor_model: null,
  position: 0, session_id: 'sess-1', started_at: null, completed_at: null,
  ai_summary: null, verdict_reason: null, verdict_at: null,
  priority: 'P2', deadline: null, is_operator: 0, label: 'other', remark: null,
  auto_approve: 0, context_summary: null, context_source_session_id: null,
  context_mode: 'none', context_status: null, context_raw: null,
  source_schedule_id: 's1', created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
  ...over,
});

test('blockingRunsBySchedule: 进行中且没跑挂的上一轮才算挡住', () => {
  const s = schedule({ last_task_id: 't1' });

  // decorate() 对「在跑但没标签」的行给的就是 null
  assert.ok(blockingRunsBySchedule([s], [task({ sub_status: null })]).has('s1'), 'in_progress + null 必须挡');
  assert.ok(blockingRunsBySchedule([s], [task({ sub_status: 'running' })]).has('s1'));
  assert.ok(blockingRunsBySchedule([s], [task({ sub_status: 'waiting_answer' })]).has('s1'), '等你回答也要挡');

  // failed 是唯一明确的「上一轮已经终止、可以重来」
  assert.equal(blockingRunsBySchedule([s], [task({ sub_status: 'failed' })]).has('s1'), false, '跑挂的必须放行');

  // 不在进行中列的一律放行
  for (const status of ['todo', 'in_review', 'done', 'archived'] as const) {
    assert.equal(blockingRunsBySchedule([s], [task({ status, sub_status: null })]).has('s1'), false, `${status} 不该挡`);
  }
});

test('blockingRunsBySchedule: 查不到上一轮时不挡', () => {
  assert.equal(blockingRunsBySchedule([schedule({ last_task_id: null })], [task()]).size, 0, '没跑过');
  assert.equal(blockingRunsBySchedule([schedule({ last_task_id: 'gone' })], [task()]).size, 0, '任务已被删');
  assert.equal(blockingRunsBySchedule([], [task()]).size, 0, '没有调度');
});

test('blockingRunsBySchedule: 多条调度各归各的键', () => {
  const a = schedule({ schedule_id: 'sa', last_task_id: 'ta' });
  const b = schedule({ schedule_id: 'sb', last_task_id: 'tb' });
  const c = schedule({ schedule_id: 'sc', last_task_id: null });
  const blocked = blockingRunsBySchedule([a, b, c], [
    task({ task_id: 'ta', status: 'in_progress', sub_status: 'running' }),
    task({ task_id: 'tb', status: 'done', sub_status: null }),
  ]);
  assert.deepEqual([...blocked.keys()], ['sa']);
  assert.equal(blocked.get('sa')?.task_id, 'ta');
});

test('runNowBlockedReason: 按 sub_status 说人话', () => {
  assert.equal(runNowBlockedReason(task({ sub_status: 'waiting_answer' })), '上一轮在等你回答，去会话里回复后才会继续');
  assert.equal(runNowBlockedReason(task({ sub_status: 'waiting_plan' })), '上一轮在等你确认计划');
  assert.equal(runNowBlockedReason(task({ sub_status: 'waiting_approval' })), '上一轮在等你批准权限请求');
  assert.equal(runNowBlockedReason(task({ sub_status: 'running' })), '上一轮还在运行中，先等它结束或中断它');
  assert.equal(runNowBlockedReason(task({ sub_status: null })), '上一轮还在运行中，先等它结束或中断它');
});

test('runNowErrorMessage: 409 走专用文案', () => {
  assert.equal(
    runNowErrorMessage('每日站会', 409, { error: { code: 'SCHEDULE_RUNNING', message: 'still has an unfinished run' } }),
    '「每日站会」上一轮还没结束，先处理或中断它再触发',
  );
});

test('runNowErrorMessage: 其它失败带出后端 message，读不到就退回状态码', () => {
  assert.equal(
    runNowErrorMessage('每日站会', 500, { error: { code: 'INTERNAL', message: '数据库连接失败' } }),
    '「每日站会」数据库连接失败',
  );
  assert.equal(runNowErrorMessage('每日站会', 503, null), '「每日站会」立即触发失败 (503)');
  assert.equal(runNowErrorMessage('每日站会', 502, { error: { message: '   ' } }), '「每日站会」立即触发失败 (502)');
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/scheduleRunNow.test.ts
```

Expected: FAIL —— `Cannot find module './scheduleRunNow'`。

- [ ] **Step 3: 实现**

新建 `web/src/components/tasks/scheduleRunNow.ts`：

```ts
/**
 * 定时任务「立即触发」的前端判据与文案。
 *
 * 纯逻辑放这里而不是 ScheduledTasksView.tsx：那会触发
 * react-refresh/only-export-components；而且 web 测试是 node:test +
 * renderToStaticMarkup（无 DOM、不跑 effect、不触发事件），逻辑必须离开组件才测得到。
 */
import type { ScheduledTask, Task } from '../../types/app';

/**
 * 每条调度「上一轮还没结束」的那个运行；map 里没有 = 可以触发。
 *
 * 判据与后端 isRunActive 的前半段逐字一致：任务停在 in_progress 列、且没有
 * failed 标签。用 decorate() 之后的行 —— sub_status 是计算后的有效值（跑着的是
 * running、等你回答/计划是 waiting_*、跑挂的仍标 failed）。
 *
 * 按 task_id 在全量任务列表里查，而不是复用 runsOf 的 source_schedule_id 过滤：
 * 这里的判据是「last_task_id 指向的那一行」，与运行记录列表的筛选条件恰好重合
 * 只是巧合，绑上去会让两件事一起变。
 *
 * 前端看不见 isSessionRunning（会话是否真的还在流式输出），所以「人工把在跑的
 * 任务标成 done」这种情形这里放行 —— 由后端的 409 兜底，错误条如实报出。
 */
export function blockingRunsBySchedule(schedules: ScheduledTask[], tasks: Task[]): Map<string, Task> {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const blocked = new Map<string, Task>();
  for (const schedule of schedules) {
    const lastId = schedule.last_task_id;
    if (!lastId) continue;
    const run = byId.get(lastId);
    if (!run) continue;
    if (run.status === 'in_progress' && run.sub_status !== 'failed') blocked.set(schedule.schedule_id, run);
  }
  return blocked;
}

/**
 * 禁用原因的 title 文案。移动端没有 hover、看不到 title，颜色是主要线索，
 * 这段文字是桌面端与无障碍的补充。
 */
export function runNowBlockedReason(run: Task): string {
  switch (run.sub_status) {
    case 'waiting_answer': return '上一轮在等你回答，去会话里回复后才会继续';
    case 'waiting_plan': return '上一轮在等你确认计划';
    case 'waiting_approval': return '上一轮在等你批准权限请求';
    default: return '上一轮还在运行中，先等它结束或中断它';
  }
}

/**
 * 立即触发失败的提示条文案。
 *
 * 409（SCHEDULE_RUNNING）单独说人话：它意味着「按钮本该是灰的，但前端漏挡了」
 * （人工把在跑的任务标成了 done），是用户能自己处理的状态。
 */
export function runNowErrorMessage(title: string, status: number, body: unknown): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (error?.code === 'SCHEDULE_RUNNING') return `「${title}」上一轮还没结束，先处理或中断它再触发`;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return message ? `「${title}」${message}` : `「${title}」立即触发失败 (${status})`;
}
```

- [ ] **Step 4: 跑测试，确认通过**

同上命令。Expected: PASS，`# tests 6` / `# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/scheduleRunNow.ts web/src/components/tasks/scheduleRunNow.test.ts
git commit -m "feat(scheduled-tasks): add run-now guard predicates for the scheduled list"
```

---

## Task 6: `ScheduledTasksView` 禁用态与错误条

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksView.tsx`
- Test: `web/src/components/tasks/ScheduledTasksView.test.tsx`

- [ ] **Step 1: 写失败测试**

改 `ScheduledTasksView.test.tsx` 的 import 与 `render` 助手，让它能传新 props：

```tsx
import type { ScheduledTask, Task } from '../../types/app';
import { ScheduledTasksView } from './ScheduledTasksView';

const runningTask: Task = {
  task_id: 't1', project_path: '/proj', title: '跑', description: null,
  status: 'in_progress', sub_status: 'running', executor_provider: 'claude', executor_model: null,
  position: 0, session_id: 'sess-1', started_at: null, completed_at: null,
  ai_summary: null, verdict_reason: null, verdict_at: null,
  priority: 'P2', deadline: null, is_operator: 0, label: 'other', remark: null,
  auto_approve: 0, context_summary: null, context_source_session_id: null,
  context_mode: 'none', context_status: null, context_raw: null,
  source_schedule_id: 's1', created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

function render(
  tasks: ScheduledTask[],
  extra: Partial<Parameters<typeof ScheduledTasksView>[0]> = {},
) {
  return renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView
        tasks={tasks}
        projectOptions={projectOptions}
        {...handlers}
        blockedRuns={new Map()}
        pendingRunNow={new Set()}
        runNowError={null}
        onDismissRunNowError={noop}
        {...extra}
      />
    </StaticRouter>,
  );
}
```

追加测试：

```tsx
// 桌面表格与移动卡片都会渲染 ▶，所以每条断言都用计数覆盖两套布局。
const countDisabledRunNow = (html: string) =>
  (html.match(/<button[^>]*aria-label="立即触发"[^>]*disabled[^>]*>/g) ?? []).length;

test('上一轮还在跑时两套布局的立即触发都禁用，且 title 说明原因', () => {
  const html = render(
    [{ ...baseTask, last_task_id: 't1' }],
    { blockedRuns: new Map([['s1', runningTask]]) },
  );
  assert.equal(countDisabledRunNow(html), 2, '桌面表格与移动卡片都要禁用');
  assert.match(html, /上一轮还在运行中，先等它结束或中断它/);
});

test('等你回答时禁用文案换成对应说法', () => {
  const html = render(
    [{ ...baseTask, last_task_id: 't1' }],
    { blockedRuns: new Map([['s1', { ...runningTask, sub_status: 'waiting_answer' }]]) },
  );
  assert.equal(countDisabledRunNow(html), 2);
  assert.match(html, /上一轮在等你回答/);
});

test('派发中的那一行也禁用，文案是「正在触发…」', () => {
  const html = render([baseTask], { pendingRunNow: new Set(['s1']) });
  assert.equal(countDisabledRunNow(html), 2);
  assert.match(html, /正在触发…/);
});

test('没被挡住的立即触发保持可点', () => {
  const html = render([baseTask]);
  assert.equal(countDisabledRunNow(html), 0, '默认状态下按钮不该是灰的');
  assert.match(html, /title="立即触发"/);
});

test('runNowError 渲染成列表上方的提示条，可关闭', () => {
  const html = render([baseTask], { runNowError: '「每日站会」上一轮还没结束，先处理或中断它再触发' });
  assert.match(html, /上一轮还没结束，先处理或中断它再触发/);
  assert.match(html, />关闭</);
});

test('runNowError 为 null 时不渲染提示条', () => {
  const html = render([baseTask]);
  assert.doesNotMatch(html, />关闭</);
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

Expected: FAIL —— 6 条新用例失败（`disabled` 计数为 0、找不到文案与「关闭」）。tsx 不做类型检查，所以新 props 会原样传进组件、被忽略 —— 这是真实的红。

- [ ] **Step 3: 实现**

`ScheduledTasksView.tsx` 的 import 补 `Task` 与两个纯函数：

```tsx
import type { ScheduledTask, Task } from '../../types/app';
...
import { runNowBlockedReason } from './scheduleRunNow';
```

props 类型（`:9`）加四项：

```tsx
export type ScheduledTasksViewProps = {
  tasks: ScheduledTask[];
  projectOptions: TaskProjectOption[];
  onEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask) => void;
  onRunNow: (task: ScheduledTask) => void;
  /** 「上一轮还没结束」的调度 → schedule_id 对应的那个运行。 */
  blockedRuns: Map<string, Task>;
  /** 正在派发中的 schedule_id（连点闸门）。 */
  pendingRunNow: Set<string>;
  /** 立即触发失败的提示条文案；null = 不显示。 */
  runNowError: string | null;
  onDismissRunNowError: () => void;
};
```

`ActionButton`（`:66`）支持 `disabled`：

```tsx
function ActionButton({ title, label, className, onClick, disabled = false, children }: {
  title: string; label: string; className: string; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <button title={title} aria-label={label} onClick={onClick} disabled={disabled} className={`mobile-touch-target rounded-lg px-2 py-1 ${className}`}>{children}</button>
  );
}
```

`ScheduledTaskCard` 解构补 `blockedRuns` / `pendingRunNow`，并在函数体开头算三兄弟：

```tsx
function ScheduledTaskCard({ task, projectOptions, onEdit, onDelete, onToggle, onRunNow, blockedRuns, pendingRunNow }: ScheduledTaskCardProps) {
  const blocked = blockedRuns.get(task.schedule_id) ?? null;
  const pending = pendingRunNow.has(task.schedule_id);
  const runNowDisabled = Boolean(blocked) || pending;
  const runNowTitle = blocked ? runNowBlockedReason(blocked) : pending ? '正在触发…' : '立即触发';
  return (
```

卡片的 ▶（`:94`）改成：

```tsx
        <ActionButton
          title={runNowTitle}
          label="立即触发"
          className={runNowDisabled ? 'cursor-not-allowed text-muted-foreground/50' : 'text-info hover:bg-info/10'}
          onClick={() => onRunNow(task)}
          disabled={runNowDisabled}
        >
          <Play className="h-3.5 w-3.5" />
        </ActionButton>
```

`ScheduledTasksView` 主体：解构补四项，把空态与列表都用错误条包起来。函数体开头（`const navigate = useNavigate();` 之后）：

```tsx
  const errorStrip = runNowError ? (
    <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-4">
      <span className="min-w-0 flex-1 break-words">{runNowError}</span>
      <button type="button" onClick={onDismissRunNowError} className="shrink-0 font-semibold hover:underline">关闭</button>
    </div>
  ) : null;
```

空态分支（`:105`）改成：

```tsx
  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {errorStrip}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
          <div className="text-sm text-muted-foreground">暂无定时任务</div>
        </div>
      </div>
    );
  }
```

列表分支（`:114`）在 `flex min-h-0 flex-1 flex-col` 容器里、桌面表格之前插入 `{errorStrip}`。

桌面行的 `.map` 从箭头表达式改成块体（要在渲染前算两个局部量），并把 ▶（`:160`）替换掉。整段变成：

```tsx
            {tasks.map((task) => {
              const blocked = blockedRuns.get(task.schedule_id) ?? null;
              const pending = pendingRunNow.has(task.schedule_id);
              const runNowDisabled = Boolean(blocked) || pending;
              const runNowTitle = blocked ? runNowBlockedReason(blocked) : pending ? '正在触发…' : '立即触发';
              return (
              <tr key={task.schedule_id} className={`bg-card shadow-sm ${task.enabled === 0 ? 'opacity-60' : ''}`}>
                {/* ……下面五个 <td> 与原来完全一致，不动…… */}
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      title={runNowTitle}
                      aria-label="立即触发"
                      onClick={() => onRunNow(task)}
                      disabled={runNowDisabled}
                      className={`rounded-lg px-2 py-1 ${runNowDisabled ? 'cursor-not-allowed text-muted-foreground/50' : 'text-info hover:bg-info/10'}`}
                    >
                      <Play className="h-3 w-3" />
                    </button>
                    <button title="编辑" aria-label="编辑" onClick={() => onEdit(task)} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><Pencil className="h-3 w-3" /></button>
                    <button title="删除" aria-label="删除" onClick={() => onDelete(task)} className="rounded-lg px-2 py-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </td>
              </tr>
              );
            })}
```

**关键**：`disabled` 必须排在 `aria-label` 之后（React SSR 按 props 顺序输出属性），测试的正则依赖这个顺序。

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

Expected: PASS，`# tests 18` / `# fail 0`（原有 12 条 + 新增 6 条）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTasksView.tsx web/src/components/tasks/ScheduledTasksView.test.tsx
git commit -m "feat(scheduled-tasks): disable run-now while the previous run is unfinished"
```

---

## Task 7: `ScheduledTasksPanel` 接线

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksPanel.tsx`

这一层没有单测：web 测试无 DOM、不跑 effect、不触发事件，`async function runNow` 测不到。逻辑已经全部下沉到 Task 5 的纯函数里，这里只剩接线 —— 由 `npm run typecheck` 与 Task 8 的 E2E 兜底。

- [ ] **Step 1: 加状态**

`ScheduledTasksPanel.tsx:41` 的 `const runs = useMemo(...)` 之后加：

```tsx
  // 「上一轮还没结束」的调度 → 那个运行。判据见 scheduleRunNow.blockingRunsBySchedule。
  const blockedRuns = useMemo(() => blockingRunsBySchedule(schedules, tasks), [schedules, tasks]);
  // 派发中的 schedule_id。ref 是同步闸门（setState 要等下一轮渲染，同一 tick 里的
  // 第二次点击读到的还是旧值 —— 双击正好是这个 tick 内的场景），state 只负责把按钮
  // 渲染成 disabled。与同文件 submittingRef 是同一套写法。
  const [pendingRunNow, setPendingRunNow] = useState<Set<string>>(new Set());
  const pendingRunNowRef = useRef<Set<string>>(new Set());
  const [runNowError, setRunNowError] = useState<string | null>(null);
```

import 补：

```tsx
import { blockingRunsBySchedule, runNowErrorMessage } from './scheduleRunNow';
```

- [ ] **Step 2: 改 `runNow`（`:86`）**

```tsx
  async function runNow(t: ScheduledTask) {
    const id = t.schedule_id;
    // 双保险：按钮在这两种情况下本就是灰的，这里防的是键盘/自动化绕过 disabled。
    if (pendingRunNowRef.current.has(id) || blockedRuns.has(id)) return;
    pendingRunNowRef.current.add(id);
    setPendingRunNow(new Set(pendingRunNowRef.current));
    setRunNowError(null);
    try {
      const res = await api.scheduledTasks.runNow(id);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRunNowError(runNowErrorMessage(t.title, res.status, body));
        console.error('runNow failed', body ?? res.status);
      }
      // 失败也要刷新：例如被另一个标签页抢先派发了一轮，本地列表已经不同步了。
      void refresh();
    } catch (e) {
      // 请求根本没发出去（断网 / 后端没起来）：没有 status 可用，直接说清。
      setRunNowError(`「${t.title}」立即触发失败：无法连接后端`);
      console.error('runNow failed', e);
    } finally {
      pendingRunNowRef.current.delete(id);
      setPendingRunNow(new Set(pendingRunNowRef.current));
    }
  }
```

- [ ] **Step 3: 传给视图（`:150`）**

```tsx
      <ScheduledTasksView
        tasks={schedules}
        projectOptions={projectOptions}
        onEdit={openEdit}
        onDelete={(t) => void remove(t)}
        onToggle={(t) => void toggle(t)}
        onRunNow={(t) => void runNow(t)}
        blockedRuns={blockedRuns}
        pendingRunNow={pendingRunNow}
        runNowError={runNowError}
        onDismissRunNowError={() => setRunNowError(null)}
      />
```

- [ ] **Step 4: typecheck 与 lint**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck && npx eslint src/components/tasks/ScheduledTasksPanel.tsx src/components/tasks/ScheduledTasksView.tsx src/components/tasks/scheduleRunNow.ts
```

Expected: typecheck 0 错；eslint 对这三个文件 0 错（仓库整体 baseline 本就不干净，标准是**本次改动文件零新增**）。

- [ ] **Step 5: 跑全部相关前端测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx src/components/tasks/scheduleRunNow.test.ts src/components/tasks/ScheduledRunHistoryView.test.tsx src/components/tasks/ScheduledTabBar.test.tsx src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: PASS，全绿。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTasksPanel.tsx
git commit -m "feat(scheduled-tasks): wire the run-now guard into the scheduled panel"
```

---

## Task 8: 全量验收与手工 E2E

**Files:** 无（验证任务）

- [ ] **Step 1: 后端全量测试与 typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --test --tsconfig server/tsconfig.json server/modules/scheduler/tests/scheduler.service.test.ts server/modules/scheduler/tests/scheduler.routes.test.ts && npm run typecheck
```

Expected: 42 条全绿（35 + 7）；typecheck 相对 baseline **零新增**（baseline 本就不干净，先记下改动前的错误条数再对比）。

- [ ] **Step 2: 确认服务在跑新代码**

后端跑在 supervisor 下（`systemctl --user lovdex`），**必须重启才会加载新守卫**。

> ⚠️ 重启任何服务前先**逐次**取得用户明确许可。最小重启 = kill 掉 npm/tsx 子进程让 supervisor 拉起。

前端 dev server（:5188 → 后端 :3188）由 vite HMR 自动吃新代码，不用动。

- [ ] **Step 3: E2E — UI 禁用态**

用 puppeteer-core + 缓存 chromium 连 `http://<lan-ip>:5188`（不是 localhost），深链 `/tasks?view=scheduled`。

1. 找一条调度，点一次 ▶，等它派出的任务进入 `in_progress`（`runsOf` 的「运行记录」子标签里能看到，或直接查库）。
2. 刷新页面。断言：桌面表格（≥1024px 视口）与窄屏卡片（<1024px 视口）两套布局里，那一行的 ▶ 都是 `disabled`，`title` 是「上一轮还在运行中，先等它结束或中断它」。
3. 断言颜色与可用态不同（读 computed color，别靠截图 —— 整页截图会编造内容）。

- [ ] **Step 4: E2E — 后端守卫真的生效（唯一的关键检查）**

先找出「上一轮还在跑」的那条调度，并记下它的任务数：

```bash
python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('file:/home/zhijuhuang/.lovdex/data/new-auth.db?mode=ro', uri=True)
for r in db.execute("""
  select s.schedule_id, s.title, t.task_id, t.status, t.sub_status
  from scheduled_tasks s join tasks t on t.task_id = s.last_task_id
  where t.status = 'in_progress' and coalesce(t.sub_status, '') <> 'failed'
"""):
    print(r)
    print('  tasks now:', db.execute(
        "select count(*) from tasks where source_schedule_id = ?", (r[0],)).fetchone()[0])
EOF
```

拿第一行的 `schedule_id` 与它的 `tasks now` 计数，然后：

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3188/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"zhiju.huang@sophgo.com","code":"888888"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s -o /tmp/run-now.json -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3188/api/scheduled-tasks/<上面那个 schedule_id>/run-now
cat /tmp/run-now.json
```

Expected: `409`，body 为 `{"success":false,"error":{"code":"SCHEDULE_RUNNING","message":"..."}}`。

再跑一次上面那段 python，`tasks now` 必须**与之前相同**（守卫挡下时一个任务都不许建）。

- [ ] **Step 5: E2E — 放行路径**

1. 上一轮跑完（或手动「中断」那个会话）后刷新 → 按钮恢复可点；点击 → 新建一条任务，运行记录里出现。
2. 让一条调度的上一轮跑挂（`sub_status='failed'`）→ 允许触发。
3. 连点两次 ▶ → 查库 `tasks` 表只多出一条。
4. 错误条：在按钮可点的情况下用 curl 制造一次 409 之后刷新页面不会显示错误条（它是即时状态，不持久化 —— 这是预期，不是 bug）。

- [ ] **Step 6: 收尾**

把 E2E 实际验证到什么、没验证到什么，如实记进 spec 或提交信息（沿用 `7af2d0d docs(auto-approve): record what the E2E did and did not prove` 的做法）。
