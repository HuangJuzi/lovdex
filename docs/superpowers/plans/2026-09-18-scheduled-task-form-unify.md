# 定时任务弹窗统一 + 模板名称 LLM 生成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把定时任务的新建/编辑弹窗改成与「新建任务」同构的混合布局，并让模板标题留空时在保存那一刻由 LLM 从描述生成、落库。

**Architecture:** 后端先把 `tasks.service` 里「标题解析 + 阻塞窗口赛跑」的骨架抽成 `task-title.ts` 的纯函数 `resolveGeneratedTitle`，再由 `scheduler.service` 复用；`create`/`update` 因此变成 async，超时后的模型结果走后台回写 + CAS + 二次广播。前端把 `ScheduledTaskForm` 从「纵向表单 + 原生 select」重写成「大 textarea + chip 工具条 + 圆形提交 + 常驻调度区块」，`title` 原样透传空串给后端。

**Tech Stack:** TypeScript / Express / node:test（后端），React 18 / Tailwind / node:test + `renderToStaticMarkup`（前端，无 DOM 环境）

**Spec:** `docs/superpowers/specs/2026-09-18-scheduled-task-form-unify-design.md`

---

## 测试命令（实测可用，务必照抄）

```bash
# 后端（TSX_TSCONFIG_PATH 已全局指向 server/tsconfig.json，直接用即可）
cd backend && npx tsx --test server/modules/scheduler/tests/scheduler.service.test.ts

# 前端（必须 env -u，否则会被全局 TSX_TSCONFIG_PATH 劫持到后端 tsconfig）
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

基线（改动前实测）：`scheduler.service.test.ts` 5 pass / `ScheduledTaskForm.test.tsx` 4 pass。

**验收标准是「零新增失败」**：后端 typecheck 与 lint 的 baseline 本就不干净（`npm run typecheck` 有 11 个 pre-existing 错误、`npm run lint` 44 个），只要不引入**新**错误即可。

---

## 文件结构

**后端**

| 文件 | 动作 | 职责 |
|---|---|---|
| `backend/server/modules/tasks/services/task-title.ts` | 修改 | 新增 `resolveGeneratedTitle` —— 标题解析的共用骨架（纯逻辑，依赖注入） |
| `backend/server/modules/tasks/services/tasks.service.ts` | 修改 | `resolveCreateTitle` 退化为对上面那个函数的薄包装 |
| `backend/server/modules/scheduler/services/scheduler.service.ts` | 修改 | 新增 `applyGeneratedTitle`（回写）；`create`/`update` 改 async 并解析标题 |
| `backend/server/modules/scheduler/scheduler.routes.ts` | 修改 | `POST /`、`PATCH /:id` 改 await；`SchedulerServiceLike` 类型改 Promise |
| `backend/server/index.js` | 修改 | `generateTitle` 闭包提成 const，同时喂给 `tasksService` 与 `schedulerService` |

**前端**

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/components/tasks/ScheduledTaskForm.tsx` | 重写 | 混合布局；新增导出 `canSubmitScheduledTask` / `toApiBody` / `toProjectChipOptions` |
| `web/src/components/tasks/ScheduledTasksPanel.tsx` | 修改 | 删掉本地 `toApiBody`（改为 import）、加同步连击守卫 |
| `web/src/components/tasks/TaskEngineSelect.tsx` | 删除 | 唯一使用方是 `ScheduledTaskForm`，改 chip 后成为死代码 |
| `web/src/components/tasks/TaskEngineSelect.test.tsx` | 删除 | 同上 |

**测试**

| 文件 | 动作 |
|---|---|
| `backend/server/modules/tasks/tests/task-title.test.ts` | 修改（追加 `resolveGeneratedTitle` 用例） |
| `backend/server/modules/scheduler/tests/scheduler.service.test.ts` | 修改（`makeService` 加可选 deps 参数 + 追加取名/回写用例） |
| `backend/server/modules/scheduler/tests/scheduler.routes.test.ts` | 修改（追加空 title 用例） |
| `web/src/components/tasks/ScheduledTaskForm.test.tsx` | 重写（旧断言全部基于 `<select>`/`<option>`，已失效） |

---

## Task 1: 抽取 `resolveGeneratedTitle`

把 `tasks.service.ts:297-321` 的逻辑原样搬进 `task-title.ts`，`tasks.service` 改为调用它。**这一步不改变任何行为**，`tasks.service.title.test.ts`（242 行）是安全网。

**Files:**
- Modify: `backend/server/modules/tasks/services/task-title.ts`（在 `shouldApplyGeneratedTitle` 之后追加）
- Modify: `backend/server/modules/tasks/services/tasks.service.ts:20`（import 行）、`:285-321`（`resolveCreateTitle`）
- Test: `backend/server/modules/tasks/tests/task-title.test.ts`

- [ ] **Step 1: 先跑一遍安全网，确认它现在是绿的**

Run: `cd backend && npx tsx --test server/modules/tasks/tests/tasks.service.title.test.ts`
Expected: 全部 pass（0 fail）。这一步是确认后面重构的回归基线。

- [ ] **Step 2: 写失败的测试**

`backend/server/modules/tasks/tests/task-title.test.ts` 顶部已有一行从 `@/modules/tasks/services/task-title.js` 的 import，把 `resolveGeneratedTitle` 加进去。然后追加：

```ts
// resolveGeneratedTitle 是 tasks.service 与 scheduler.service 共用的骨架：
// 「给了标题就不碰模型」是两条链路共同的前提，必须钉死。
test('resolveGeneratedTitle: a provided title never reaches the model', async () => {
  let calls = 0;
  const res = await resolveGeneratedTitle({
    title: '  手填的名字  ',
    description: '需求正文',
    generateTitle: async () => { calls += 1; return '模型取的名'; },
  });
  assert.equal(res.title, '  手填的名字  ');
  assert.equal(res.writeBack, null);
  assert.equal(calls, 0);
});

test('resolveGeneratedTitle: a blank description skips the model and falls back to the default name', async () => {
  let calls = 0;
  const res = await resolveGeneratedTitle({
    title: '',
    description: null,
    generateTitle: async () => { calls += 1; return '模型取的名'; },
  });
  assert.equal(res.title, '未命名任务');
  assert.equal(res.writeBack, null);
  assert.equal(calls, 0);
});

test('resolveGeneratedTitle: a model answer inside the window wins', async () => {
  const res = await resolveGeneratedTitle({
    title: '',
    description: '修复登录超时',
    generateTitle: async () => '修复登录超时',
    blockingMs: 50,
  });
  assert.equal(res.title, '修复登录超时');
  assert.equal(res.writeBack, null);
});

test('resolveGeneratedTitle: a model that misses the window yields the fallback plus a write-back', async () => {
  let release: (v: string | null) => void = () => {};
  const pending = new Promise<string | null>((r) => { release = r; });
  const res = await resolveGeneratedTitle({
    title: '',
    description: '每天早上汇总提交记录',
    generateTitle: () => pending,
    blockingMs: 10,
  });
  assert.equal(res.title, '每天早上汇总提交记录');
  assert.ok(res.writeBack, 'the in-flight request must be handed back for a later write-back');
  release('每日提交汇总');
  assert.equal(await res.writeBack, '每日提交汇总');
});

test('resolveGeneratedTitle: a generateTitle that throws synchronously survives', async () => {
  const res = await resolveGeneratedTitle({
    title: '',
    description: '修复登录超时',
    generateTitle: () => { throw new Error('mis-wired dep'); },
    blockingMs: 50,
  });
  assert.equal(res.title, '修复登录超时');
  assert.equal(res.writeBack, null);
});

test('resolveGeneratedTitle: a missing generateTitle dep falls back without throwing', async () => {
  const res = await resolveGeneratedTitle({ title: '', description: '修复登录超时', blockingMs: 50 });
  assert.equal(res.title, '修复登录超时');
  assert.equal(res.writeBack, null);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd backend && npx tsx --test server/modules/tasks/tests/task-title.test.ts`
Expected: FAIL —— `resolveGeneratedTitle is not a function`。

- [ ] **Step 4: 实现**

在 `backend/server/modules/tasks/services/task-title.ts` 的 `shouldApplyGeneratedTitle` 之后追加：

```ts
/**
 * 标题解析的共用骨架：调用方给了非空 title 就原样用（**永不触模型**），否则先本地
 * 兜底提炼，再与模型赛跑 `blockingMs` 阻塞窗口。返回要落库的标题，以及超时情况下
 * 仍在途的请求（调用方负责 fire-and-forget 回写）。
 *
 * 从 tasks.service.resolveCreateTitle 原样抽出，定时任务模板复用同一套语义：
 * 「模型取名是尽力而为，绝不能拖垮保存」。
 */
export async function resolveGeneratedTitle(input: {
  title?: string | null;
  description?: string | null;
  generateTitle?: (input: { description: string | null }) => Promise<string | null>;
  blockingMs?: number;
}): Promise<{ title: string; writeBack: Promise<string | null> | null }> {
  const provided = typeof input.title === 'string' ? input.title : '';
  if (provided.trim()) return { title: provided, writeBack: null };

  const fallback = deriveFallbackTitle(input.description);
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  let pending: Promise<string | null> | undefined;
  try {
    // The contract is a Promise (so a rejection is handled by raceTaskTitle),
    // but a synchronous throw here — mis-wired dep, failed init — must not
    // become "建任务失败": naming is best-effort by definition.
    pending = description ? input.generateTitle?.({ description }) : undefined;
  } catch (error) {
    console.error('[task-title] title generation failed', {
      error: error instanceof Error ? error.message : error,
    });
    pending = undefined;
  }
  if (!pending) return { title: fallback, writeBack: null };

  const { title, background } = await raceTaskTitle(pending, fallback, input.blockingMs);
  return { title, writeBack: background };
}
```

`raceTaskTitle` 的第三参数有默认值 `= TITLE_BLOCKING_TIMEOUT_MS`，传 `undefined` 即走默认，所以 `input.blockingMs` 直接透传即可。

- [ ] **Step 5: 跑新测试确认通过**

Run: `cd backend && npx tsx --test server/modules/tasks/tests/task-title.test.ts`
Expected: 全部 pass。

- [ ] **Step 6: 把 `tasks.service` 改成薄包装**

`backend/server/modules/tasks/services/tasks.service.ts:20` 的 import 改为（`deriveFallbackTitle` 与 `raceTaskTitle` 在本文件已不再直接使用，留着会变成 lint 的 unused import）：

```ts
import { resolveGeneratedTitle, shouldApplyGeneratedTitle } from './task-title.js';
```

把 `:285-321` 的 `resolveCreateTitle`（含它上面那段 JSDoc）整体替换为：

```ts
  /**
   * Resolves the title for a new task.
   *
   * A title the caller actually provided always wins and never reaches the model.
   * A blank one is derived locally from the description first line, then — only
   * when there IS a description worth reading — raced against the model for up to
   * `titleBlockingMs`. Returns the title to persist plus, when the model was too
   * slow, the still-in-flight request to write back later.
   *
   * Resolution runs after validation on purpose: a request that is going to 400
   * must not spend the blocking window on a model call.
   *
   * The skeleton itself lives in task-title.ts — the scheduler's template titles
   * share it verbatim.
   */
  async function resolveCreateTitle(
    input: CreateTaskInput,
  ): Promise<{ title: string; writeBack: Promise<string | null> | null }> {
    return resolveGeneratedTitle({
      title: input.title,
      description: input.description,
      generateTitle: opts.deps?.generateTitle,
      blockingMs: opts.titleBlockingMs,
    });
  }
```

- [ ] **Step 7: 跑安全网 + typecheck，确认零新增错误**

```bash
cd backend && npx tsx --test server/modules/tasks/tests/tasks.service.title.test.ts
cd backend && npx tsx --test server/modules/tasks/tests/task-title.test.ts
cd backend && npm run typecheck 2>&1 | tail -5
```
Expected: 两个测试文件全 pass；typecheck 错误数仍是 11（pre-existing），**不得多**。

- [ ] **Step 8: Commit**

```bash
git add backend/server/modules/tasks/services/task-title.ts backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/task-title.test.ts
git commit -m "refactor(tasks): extract resolveGeneratedTitle so the scheduler can reuse it"
```

---

## Task 2: scheduler 取名接线（deps + `create` + 超时回写）

**Files:**
- Modify: `backend/server/modules/scheduler/services/scheduler.service.ts`（`SchedulerDeps`、import、`create`、新增 `applyGeneratedTitle`、`dispatch` 上方注释）
- Test: `backend/server/modules/scheduler/tests/scheduler.service.test.ts`

- [ ] **Step 1: 给 `makeService` 加一个可选 deps 参数**

现在 `makeService(nowIso)`（`:47-95`）硬编码了 `createSchedulerService` 的全部依赖，取名相关的用例没法注入。把签名和结尾改成：

```ts
function makeService(nowIso: string, extra: Partial<SchedulerDeps> = {}) {
```

（`const svc = createSchedulerService({ ... })` 的最后一个字段 `now: () => new Date(nowIso),` 后面加一行 `...extra,`。）

顶部 import 补上 `SchedulerDeps` 类型：

```ts
import { computeNext, createSchedulerService, type SchedulerDeps } from '@/modules/scheduler/services/scheduler.service.js';
```

注意 `makeService` 返回的是 `{ svc, rows, createdTasks, launches, broadcasts }` —— **没有 `db`**，行数据在 `rows`（一个 `Map<string, ScheduledTaskRow>`）里，`createScheduledTask` 固定写 `schedule_id: 'new'`。

- [ ] **Step 2: 写失败的测试**

追加：

```ts
test('create: a blank title is generated from the description', async () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async ({ description }) => `取自：${description}`,
    titleBlockingMs: 50,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { title: string };
  assert.equal(row.title, '取自：每天汇总提交记录');
  assert.equal(rows.get('new')?.title, '取自：每天汇总提交记录');
});

test('create: a provided title never reaches the model', async () => {
  let calls = 0;
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async () => { calls += 1; return '模型取的名'; },
    titleBlockingMs: 50,
  });
  const row = await svc.create({
    title: '我自己的名字', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { title: string };
  assert.equal(row.title, '我自己的名字');
  assert.equal(calls, 0);
});

test('create: a model that misses the window writes the title back later and rebroadcasts', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows, broadcasts } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string; title: string };
  // 阻塞窗口内没等到模型 → 先落描述首行
  assert.equal(row.title, '每天汇总提交记录');
  const before = broadcasts.length;

  release('每日提交汇总');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rows.get(row.schedule_id)?.title, '每日提交汇总');
  const after = broadcasts.slice(before);
  assert.equal(after.length, 1);
  assert.equal((after[0] as { kind: string }).kind, 'scheduled_task_upserted');
});

test('write-back yields when the user renamed the template in the meantime', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  rows.set(row.schedule_id, { ...rows.get(row.schedule_id)!, title: '用户改的名字' });

  release('模型取的名');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rows.get(row.schedule_id)?.title, '用户改的名字');
});

test('write-back never throws when the row was deleted mid-flight', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  rows.delete(row.schedule_id);

  release('模型取的名');
  await new Promise((r) => setTimeout(r, 0));
  // 没有 unhandledRejection 就是通过 —— 上面这行 await 之后进程还活着
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd backend && npx tsx --test server/modules/scheduler/tests/scheduler.service.test.ts`
Expected: 前两条 FAIL（`row.title` 是 `''`）；后三条：回写那条 FAIL（标题仍是描述首行、广播数 0），CAS 与删除那两条 pass（当前没有回写机制，什么都没发生）。

- [ ] **Step 4: 实现**

`backend/server/modules/scheduler/services/scheduler.service.ts` 顶部 import 追加：

```ts
import { resolveGeneratedTitle } from '@/modules/tasks/services/task-title.js';
```

`SchedulerDeps`（`:9-16`）加两个字段：

```ts
  /** 模板标题留空时用 LLM 从描述取名；与 tasksService 同一个契约。 */
  generateTitle?: (input: { description: string | null }) => Promise<string | null>;
  /** 单测注入口；生产走 TITLE_BLOCKING_TIMEOUT_MS（3s）。 */
  titleBlockingMs?: number;
```

在 `createSchedulerService` 内部、`dispatch` 之前插入：

```ts
  /**
   * Background write-back for a template title that arrived after the blocking
   * window.
   *
   * CAS on the placeholder we actually wrote: if the user renamed the template
   * while the model was thinking — or deleted it — the generated title yields.
   * Broadcasts a second `scheduled_task_upserted` so an open list picks the new
   * name up live.
   *
   * Never throws: this runs detached from create/update, and a DB hiccup here
   * must not surface as an unhandled rejection.
   */
  function applyGeneratedTitle(scheduleId: string, generated: string | null, placeholderTitle: string): void {
    try {
      if (!generated) return;
      const current = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!current || current.title !== placeholderTitle) return;
      const updated = deps.scheduledTasksDb.updateScheduledTask(scheduleId, { title: generated });
      if (!updated) return;
      deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: updated, timestamp: now().toISOString() });
    } catch (error) {
      console.error('[scheduler] title write-back failed', {
        scheduleId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }
```

把 `create`（`:170-190`）替换为：

```ts
    async create(input: Record<string, unknown>): Promise<unknown> {
      validateScheduleInput(input);
      const description = typeof input.description === 'string' ? input.description : null;
      // 解析放在校验之后：会 400 的请求不该花阻塞窗口（同 tasks.service）。
      const { title, writeBack } = await resolveGeneratedTitle({
        title: String(input.title ?? ''),
        description,
        generateTitle: deps.generateTitle,
        blockingMs: deps.titleBlockingMs,
      });
      const row = deps.scheduledTasksDb.createScheduledTask({
        title,
        description,
        projectPath: typeof input.projectPath === 'string' && input.projectPath ? input.projectPath : null,
        executorProvider: typeof input.executorProvider === 'string' ? input.executorProvider : undefined,
        executorModel: typeof input.executorModel === 'string' ? input.executorModel : null,
        priority: typeof input.priority === 'string' ? input.priority : undefined,
        label: typeof input.label === 'string' ? input.label : undefined,
        autoRun: input.autoRun !== 0,
        scheduleType: input.scheduleType as never,
        cronExpr: typeof input.cronExpr === 'string' ? input.cronExpr : null,
        intervalSeconds: typeof input.intervalSeconds === 'number' ? input.intervalSeconds : null,
        runAt: typeof input.runAt === 'string' ? input.runAt : null,
        timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
        nextRunAt: initialNextRun(input as never, now()),
      });
      deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      if (writeBack) {
        void writeBack.then((generated) => applyGeneratedTitle(row.schedule_id, generated, title));
      }
      return row;
    },
```

`dispatch()` 上方 `:71-73` 那条注释已不成立（标题在保存时就落库了，调度路径不再进取名分支）。替换为：

```ts
    // The template title is resolved and persisted at save time (task-title), so
    // this normally does not touch the model. A legacy row with a blank title
    // still falls back to createTask's own resolution.
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && npx tsx --test server/modules/scheduler/tests/scheduler.service.test.ts`
Expected: 原有 5 条 + 新增 5 条全部 pass，且无 unhandledRejection 告警。

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/scheduler/services/scheduler.service.ts backend/server/modules/scheduler/tests/scheduler.service.test.ts
git commit -m "feat(scheduler): generate and write back a template title when blank"
```

---

## Task 3: `update()` 传空标题时重新生成

**Files:**
- Modify: `backend/server/modules/scheduler/services/scheduler.service.ts`（`update`）
- Test: `backend/server/modules/scheduler/tests/scheduler.service.test.ts`

- [ ] **Step 1: 写失败的测试**

追加：

```ts
test('update: a blank title regenerates from the description', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async ({ description }) => `取自：${description}`,
    titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { title: '', description: '新描述' }) as { title: string };
  assert.equal(updated.title, '取自：新描述');
});

test('update: a blank title with no new description falls back to the stored description', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async ({ description }) => `取自：${description}`,
    titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { title: '' }) as { title: string };
  assert.equal(updated.title, '取自：旧描述');
});

test('update: omitting the title leaves it untouched', async () => {
  let calls = 0;
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async () => { calls += 1; return '不该被调用'; },
    titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { priority: 'P0' }) as { title: string };
  assert.equal(updated.title, '旧名字');
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx tsx --test server/modules/scheduler/tests/scheduler.service.test.ts`
Expected: 前两条 FAIL（`update` 目前是同步的，`await` 裸行对象合法，所以拿到的是 `title: ''` 的行，而不是生成的名字）；第三条 pass（没传 title 时行为不变）。

- [ ] **Step 3: 实现**

`update`（`:191-244`）签名改 async：

```ts
    async update(scheduleId: string, updates: Record<string, unknown>): Promise<unknown> {
```

（函数体开头到 `keyMap` 那个 `for` 循环保持不变。）在 `for (const [from, to] of Object.entries(keyMap))` 循环之后、`const recompute = ...` 之前插入：

```ts
      // 标题传了空串 = 让模型按描述重新取名；没传 = 不动（keyMap 不会把它放进 cleaned）。
      let pendingTitle: { promise: Promise<string | null>; placeholder: string } | null = null;
      if (typeof updates.title === 'string') {
        const resolved = await resolveGeneratedTitle({
          title: updates.title,
          // 同一次 PATCH 里改了描述就用新的，否则用库里现有的。
          description: typeof cleaned.description === 'string' ? cleaned.description : current.description,
          generateTitle: deps.generateTitle,
          blockingMs: deps.titleBlockingMs,
        });
        cleaned.title = resolved.title;
        if (resolved.writeBack) pendingTitle = { promise: resolved.writeBack, placeholder: resolved.title };
      }
```

把结尾（`:241-243`）改为：

```ts
      const row = deps.scheduledTasksDb.updateScheduledTask(scheduleId, cleaned);
      if (row) deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      const pending = pendingTitle;
      if (row && pending) {
        void pending.promise.then((generated) => applyGeneratedTitle(scheduleId, generated, pending.placeholder));
      }
      return row;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx tsx --test server/modules/scheduler/tests/scheduler.service.test.ts`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/scheduler/services/scheduler.service.ts backend/server/modules/scheduler/tests/scheduler.service.test.ts
git commit -m "feat(scheduler): regenerate the template title when cleared on edit"
```

---

## Task 4: 路由改 await + 类型

**Files:**
- Modify: `backend/server/modules/scheduler/scheduler.routes.ts:9-17`（`SchedulerServiceLike`）、`:25-31`（POST）、`:38-47`（PATCH）
- Test: `backend/server/modules/scheduler/tests/scheduler.routes.test.ts`

- [ ] **Step 1: 写失败的测试**

追加。注意不要给 `makeSvc()` 返回对象的 `create` 属性直接赋值（类型会对不上），用展开构造一个新对象：

```ts
test('POST / returns the title the service resolved for a blank title', async () => {
  const base = makeSvc();
  // 模拟 scheduler.service 的取名行为：空 title 进来，生成后的名字出去。
  const svc = {
    ...base,
    create: async (i: Record<string, unknown>) =>
      base.create({ ...i, title: i.title === '' ? 'AI 取的名' : i.title }),
  };
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', description: '每天汇总', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { title: string };
    assert.equal(body.title, 'AI 取的名');
  } finally { await close(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx tsx --test server/modules/scheduler/tests/scheduler.routes.test.ts`
Expected: FAIL —— 路由现在是 `res.status(201).json(svc.create(body))`，拿到一个 Promise，序列化成 `{}`，`body.title` 是 `undefined`。

- [ ] **Step 3: 实现**

`SchedulerServiceLike` 里两行改类型：

```ts
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (scheduleId: string, updates: Record<string, unknown>) => Promise<unknown>;
```

`POST /` 的 `res.status(201).json(svc.create(body));` 改为：

```ts
    // Must be awaited: 取名最长阻塞一个 blocking window, and a bare promise
    // serializes to `{}`.
    res.status(201).json(await svc.create(body));
```

`PATCH /:scheduleId` 的 `const row = svc.update(String(req.params.scheduleId), body);` 改为：

```ts
    const row = await svc.update(String(req.params.scheduleId), body);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx tsx --test server/modules/scheduler/tests/scheduler.routes.test.ts`
Expected: 原有用例 + 新增 1 条全部 pass。

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/scheduler/scheduler.routes.ts backend/server/modules/scheduler/tests/scheduler.routes.test.ts
git commit -m "fix(scheduler): await create/update so generated titles reach the response"
```

---

## Task 5: `index.js` 接线

**Files:**
- Modify: `backend/server/index.js:469-484`（`createTasksService`）、`:576-585`（`createSchedulerService`）

- [ ] **Step 1: 把 `generateTitle` 提成 const**

把 `:469-484` 改为（`const generateTitle = ...` 必须在 `createTasksService` 之前）：

```js
// 标题为空时用 LLM（默认 DeepSeek Flash，可在 Operator 设置里换）从 description
// 提炼一个短名。走与任务上下文压缩同一条 headless 一次性调用路径；失败/超时一律
// 返回 null，调用方据此降级到需求首行兜底 —— 取名失败绝不能导致建任务/存定时任务
// 报错。tasksService 与 schedulerService 共用同一份。
const generateTitle = ({ description }) =>
    requestTaskTitle({
        description,
        runOneShot: runOneShotClaudeText,
        model: getAppConfig().get().oneshot.titleModel,
    });
const tasksService = createTasksService(tasksDb, {
    broadcast: broadcastTask,
    deps: {
        projectsDb,
        sessionsDb,
        generateTitle,
    },
```

- [ ] **Step 2: 喂给 schedulerService**

`:576-585` 的 `createSchedulerService({...})` 末尾（`broadcast: broadcastTask,` 之后）加一行：

```js
    generateTitle,
```

- [ ] **Step 3: 确认后端 typecheck 零新增错误**

Run: `cd backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -5`
Expected: 仍是 11 个 pre-existing 错误，**不得多**。

- [ ] **Step 4: Commit**

```bash
git add backend/server/index.js
git commit -m "chore(server): share the title generator between tasks and the scheduler"
```

---

## Task 6: 前端纯函数 `canSubmitScheduledTask`

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 写失败的测试**

`web/src/components/tasks/ScheduledTaskForm.test.tsx:21` 的 import 行补上 `canSubmitScheduledTask`：

```ts
const { ScheduledTaskForm, EMPTY_DRAFT, canSubmitScheduledTask } = await import('./ScheduledTaskForm');
```

追加：

```ts
test('canSubmitScheduledTask: only a non-empty description may be submitted', () => {
  assert.equal(canSubmitScheduledTask('', false), false);
  assert.equal(canSubmitScheduledTask('   \n  ', false), false);
  assert.equal(canSubmitScheduledTask('每天汇总提交记录', false), true);
});

test('canSubmitScheduledTask: an in-flight save blocks a second submit', () => {
  // 取名最长阻塞 3s，这期间按钮若仍可点，双击就是两条一模一样的定时任务。
  assert.equal(canSubmitScheduledTask('每天汇总提交记录', true), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: FAIL —— `canSubmitScheduledTask is not a function`。

- [ ] **Step 3: 实现**

在 `ScheduledTaskForm.tsx` 的 `EMPTY_DRAFT` 之后追加：

```tsx
/**
 * 确认按钮的可用性判据：描述非空，且没有保存请求在途。
 *
 * 在途那一档不是锦上添花 —— title 留空时后端要等模型取名（阻塞窗口最长
 * `TITLE_BLOCKING_TIMEOUT_MS` = 3s）才落库，这期间弹窗一直开着，按钮若仍可点，
 * 双击 / Enter 连击就是两次 POST，列表里多出一条一模一样的定时任务。
 *
 * 只卡描述：调度字段（cron / 触发时间 / 间隔）的缺失走提交时的内联报错，与
 * CreateTaskDialog 把可用性判据保持在单一维度上的做法一致。
 */
export function canSubmitScheduledTask(description: string, submitting: boolean): boolean {
  return description.trim() !== '' && !submitting;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: 原有 4 条 + 新增 2 条全部 pass。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(tasks): add canSubmitScheduledTask guard for the scheduled-task form"
```

---

## Task 7: `toApiBody` 迁入表单并导出

`toApiBody` 现在住在 `ScheduledTasksPanel.tsx`，而那个模块 import 了 `utils/api`（模块作用域会碰 `constants/config` 的 vite 环境变量），在 `node:test` 里 import 不安全。它是「draft → 请求体」的映射，本来就属于表单，迁过去顺带拿到测试覆盖。

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`（新增导出）
- Modify: `web/src/components/tasks/ScheduledTasksPanel.tsx:12-27`（删掉本地实现，改 import）
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 写失败的测试**

import 行补上 `toApiBody`：

```ts
const { ScheduledTaskForm, EMPTY_DRAFT, canSubmitScheduledTask, toApiBody } = await import('./ScheduledTaskForm');
const { ASSISTANT_OPTION_VALUE } = await import('./projectOptions');
```

追加：

```ts
test('toApiBody: a blank name is passed through as an empty string', () => {
  // 关键回归点：前端一旦在这里本地兜底填了名字，后端的 LLM 取名分支就永远不会进入。
  const body = toApiBody({ ...EMPTY_DRAFT, description: '每天汇总提交记录', title: '' });
  assert.equal(body.title, '');
});

test('toApiBody: the assistant project is sent as a null projectPath', () => {
  const body = toApiBody({ ...EMPTY_DRAFT, projectPath: ASSISTANT_OPTION_VALUE });
  assert.equal(body.projectPath, null);
});

test('toApiBody: only the field matching the schedule type is populated', () => {
  const once = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'once', runAt: '2026-09-19T01:00', cronExpr: '0 9 * * *' });
  assert.equal(once.cronExpr, null);
  assert.equal(once.intervalSeconds, null);
  assert.ok(once.runAt);

  const cron = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronExpr: '0 9 * * *' });
  assert.equal(cron.cronExpr, '0 9 * * *');
  assert.equal(cron.runAt, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: FAIL —— `toApiBody is not a function`。

- [ ] **Step 3: 实现**

在 `ScheduledTaskForm.tsx` 的 `canSubmitScheduledTask` 之后追加：

```tsx
/**
 * draft → POST/PATCH /api/scheduled-tasks 的请求体。
 *
 * `title` 原样透传，**不做任何本地兜底**：空串是「让后端用 LLM 从描述取名」的信号，
 * 前端一旦在这里填了名字，后端的取名分支就永远不会进入（同 CreateTaskDialog）。
 */
export function toApiBody(d: ScheduledTaskDraft) {
  const projectPath = d.projectPath === ASSISTANT_OPTION_VALUE || !d.projectPath ? null : d.projectPath;
  return {
    title: d.title,
    description: d.description || null,
    projectPath,
    executorProvider: d.executorProvider,
    priority: d.priority,
    label: d.label,
    autoRun: d.autoRun ? 1 : 0,
    scheduleType: d.scheduleType,
    cronExpr: d.scheduleType === 'cron' ? d.cronExpr : null,
    intervalSeconds: d.scheduleType === 'interval' ? Number(d.intervalSeconds) : null,
    runAt: d.scheduleType === 'once' ? (d.runAt ? new Date(d.runAt).toISOString() : null) : null,
  };
}
```

`ScheduledTaskForm.tsx` 顶部已 import 了 `ASSISTANT_OPTION_VALUE`，无需再加。

`ScheduledTasksPanel.tsx` 删掉 `:12-27` 的整个本地 `toApiBody`，import 行（`:8`）改为：

```ts
import { ScheduledTaskForm, toApiBody, type ScheduledTaskDraft } from './ScheduledTaskForm';
```

`ASSISTANT_OPTION_VALUE` 的 import（`:7`）在 panel 里已无别的用处，一并删掉。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTasksPanel.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "refactor(tasks): move toApiBody into the scheduled-task form so it is testable"
```

---

## Task 8: 重写 `ScheduledTaskForm` 为混合布局

本次改动最大的一步。改完之后 `TaskEngineSelect` 变成死代码（Task 10 删）。

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`（整体替换 render 部分）
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 写失败的测试**

先删掉文件里**原本就有的 4 条**用例（它们全部基于 `<select>` / `<option>`，改 chip 后不再成立）：

- `renders a remote project option with its host prefix`
- `renders a local project option without a prefix`
- `engine select is disabled while availability resolves (loading)`
- `renders deterministically with a remote option selected while availability resolves`

（Task 6/7 新增的那几条保留。）import 行补 `toProjectChipOptions`，然后追加：

```ts
test('renders the big composer textarea with the auto-naming hint', () => {
  const html = renderWithOptions([]);
  assert.ok(html.includes('说清楚要做什么就行，名称留空会自动生成'));
});

test('renders a name chip that reads 名称 while the name is blank', () => {
  const html = renderWithOptions([]);
  assert.ok(html.includes('名称'));
});

test('engine chip is disabled while availability resolves (loading)', () => {
  const html = renderWithOptions([]);
  const engineChip = /<button[^>]*aria-label="引擎"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(engineChip.length > 0, 'engine chip must render');
  // 必须断言 disabled **属性**，不能断言子串 'disabled' —— ChipSelect 的 className 里
  // 始终含 Tailwind 的 `disabled:cursor-not-allowed disabled:opacity-50`，
  // `includes('disabled')` 恒真，等于没测。（原来的 <select> 用例没这个问题，因为
  // <select> 的 className 里没有 `disabled:` 前缀的类。）
  assert.ok(/ disabled=""/.test(engineChip), 'engine chip must carry the disabled attribute while loading');
});

test('renders the schedule section segmented control, defaulting to 单次', () => {
  const html = renderWithOptions([]);
  for (const label of ['单次', '间隔', 'Cron']) assert.ok(html.includes(label));
  assert.ok(html.includes('自动执行'));
});

test('toProjectChipOptions: a remote project carries its host name as a hint', () => {
  const options = toProjectChipOptions([
    { value: '/r/app', label: 'MyApp', remoteHostId: 'h1', remoteHostName: 'dev-01' },
    { value: '/l/app', label: 'LocalApp' },
  ]);
  assert.deepEqual(options[0], { value: '/r/app', label: 'MyApp', hint: 'dev-01' });
  assert.deepEqual(options[1], { value: '/l/app', label: 'LocalApp', hint: undefined });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: FAIL —— 旧布局里没有那句 placeholder，也没有 `aria-label="引擎"` 的 chip。

- [ ] **Step 3: 实现**

改动分四块。

**(a) import 区**替换为：

```tsx
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';

import type { ScheduledTask, ScheduledTaskScheduleType, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { cn } from '../../lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { AnchorPopover } from './AnchorPopover';
import { ChipSelect, type ChipSelectOption } from './ChipSelect';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
import type { TaskProjectOption } from './TaskCard';
import { ENGINE_NAMES, useTaskEngineAvailability } from './useTaskEngineAvailability';
```

（`TaskEngineSelect` 的 import 删除；`ENGINE_NAMES` 现在从这里直接拿。）

**(b) `INTERVAL_PRESETS` 之后**加：

```tsx
const SCHEDULE_TYPES: { value: ScheduledTaskScheduleType; label: string }[] = [
  { value: 'once', label: '单次' },
  { value: 'interval', label: '间隔' },
  { value: 'cron', label: 'Cron' },
];

/**
 * 项目 chip 的选项：远端项目把主机名挂在弹层行的右侧（同 CreateTaskDialog）。
 * 抽成纯函数是为了能在无 DOM 环境下直接断言。
 */
export function toProjectChipOptions(projectOptions: TaskProjectOption[]): ChipSelectOption[] {
  return projectOptions.map((o) => ({
    value: o.value,
    label: o.label,
    hint: o.remoteHostName ?? undefined,
  }));
}
```

**(c) `toDraft` 之后、组件之前**加 `NameChip`：

```tsx
/** 名称芯片：空名时虚线边框 + 文案「名称」，点开是个普通输入框。 */
function NameChip({ value, onChange, isMobile }: { value: string; onChange: (v: string) => void; isMobile: boolean }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="名称"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 items-center gap-1 rounded-full border bg-card px-3 text-sm transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          value.trim() ? 'border-border/80 text-foreground' : 'border-dashed border-border text-muted-foreground',
        )}
      >
        <span className="max-w-[190px] truncate">{value.trim() || '名称'}</span>
      </button>
      <AnchorPopover open={open} onOpenChange={setOpen} anchorRef={anchorRef} isMobile={isMobile} ariaLabel="名称">
        <div className="flex flex-col gap-1 p-1">
          <span className="text-xs font-medium text-muted-foreground">名称</span>
          <Input
            className="h-9 w-full"
            placeholder="留空则由 AI 从描述生成"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </AnchorPopover>
    </>
  );
}
```

**(d) 组件体**。在 `const [localError, setLocalError] = useState<string | null>(null);` 之后加：

```tsx
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 640 });
```

`submit` 里的标题校验删掉，加上描述校验：

```tsx
  const submit = () => {
    setLocalError(null);
    if (engineAvailability.status === 'unavailable') {
      setLocalError(engineAvailability.hint);
      return;
    }
    if (!draft.description.trim()) { setLocalError('请先描述这个定时任务要做什么'); return; }
    if (draft.scheduleType === 'cron' && !draft.cronExpr.trim()) { setLocalError('请填写 cron 表达式'); return; }
    if (draft.scheduleType === 'once' && !draft.runAt) { setLocalError('请选择触发时间'); return; }
    if (draft.scheduleType === 'interval' && !(Number(draft.intervalSeconds) > 0)) { setLocalError('间隔必须大于 0 秒'); return; }
    onSubmit(draft);
  };
```

把 `const fieldCls = '...';` 那一行**删除**，替换为：

```tsx
  const engineOptions: ChipSelectOption[] = engineAvailability.status === 'ready'
    ? engineAvailability.options.map((e) => ({ value: e, label: ENGINE_NAMES[e] }))
    // 非 ready 时保留一项，芯片才显示得出当前引擎的中文名而不是裸的「引擎」二字。
    : [{ value: draft.executorProvider, label: ENGINE_NAMES[draft.executorProvider] }];
  const engineHint = 'hint' in engineAvailability ? engineAvailability.hint : undefined;
  const priorityOptions: ChipSelectOption[] = PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_META[p].label }));
  const labelOptions: ChipSelectOption[] = LABEL_ORDER.map((l) => ({ value: l, label: LABEL_META[l].label }));
  const intervalOptions: ChipSelectOption[] = INTERVAL_PRESETS.some((p) => p.value === draft.intervalSeconds)
    ? INTERVAL_PRESETS.map((p) => ({ value: p.value, label: p.label }))
    // 库里存着的自定义间隔不在预设里，补一项进去，免得芯片显示成别的预设值。
    : [{ value: draft.intervalSeconds, label: `每 ${draft.intervalSeconds} 秒` },
       ...INTERVAL_PRESETS.map((p) => ({ value: p.value, label: p.label }))];
  const projectChipOptions = toProjectChipOptions(projectOptions);
  const canSubmit = canSubmitScheduledTask(draft.description, submitting);
```

整个 `return (...)` 替换为：

```tsx
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="max-h-[85vh] w-full sm:max-w-[66.7vw] overflow-y-auto">
        <DialogTitle>{initial ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{initial ? '编辑定时任务' : '新建定时任务'}</h2>
          <p className="text-xs text-muted-foreground">说清楚要做什么就行，其余都可以之后再补</p>
        </div>

        <div className="p-5">
          <div className="rounded-2xl border border-border/80 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/50">
            <textarea
              autoFocus
              className="min-h-[180px] w-full resize-y rounded-t-2xl border-0 bg-transparent px-4 py-3 text-base leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:min-h-[240px]"
              placeholder="说清楚要做什么就行，名称留空会自动生成"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2.5">
              <NameChip value={draft.title} onChange={(v) => set('title', v)} isMobile={isMobile} />
              <ChipSelect
                ariaLabel="项目" label="项目" options={projectChipOptions}
                value={draft.projectPath} isMobile={isMobile}
                onChange={(v) => set('projectPath', v)}
              />
              <ChipSelect
                ariaLabel="引擎" label="引擎" options={engineOptions}
                value={draft.executorProvider} disabled={engineAvailability.status !== 'ready'} isMobile={isMobile}
                onChange={(v) => set('executorProvider', v as TaskEngine)}
              />
              <ChipSelect
                ariaLabel="优先级" label="优先级" options={priorityOptions}
                value={draft.priority} isMobile={isMobile}
                onChange={(v) => set('priority', v as TaskPriority)}
              />
              <ChipSelect
                ariaLabel="标签" label="标签" options={labelOptions}
                value={draft.label} isMobile={isMobile}
                onChange={(v) => set('label', v as TaskLabel)}
              />
              <button
                type="button"
                aria-label={submitting ? '保存中，请稍候' : canSubmit ? '保存定时任务' : '描述为空，暂不能保存'}
                aria-busy={submitting}
                title="保存"
                disabled={!canSubmit}
                onClick={submit}
                className={cn(
                  'ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90',
                  submitting ? 'cursor-wait opacity-70' : 'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {engineHint && <p className="mt-2 text-xs text-muted-foreground">{engineHint}</p>}

          <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border p-3">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">调度</span>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
                {SCHEDULE_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => set('scheduleType', t.value)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm transition-colors',
                      draft.scheduleType === t.value ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {draft.scheduleType === 'once' && (
                <Input
                  type="datetime-local" className="h-9 w-auto"
                  value={draft.runAt} onChange={(e) => set('runAt', e.target.value)}
                />
              )}
              {draft.scheduleType === 'interval' && (
                <ChipSelect
                  ariaLabel="间隔" label="间隔" options={intervalOptions}
                  value={draft.intervalSeconds} isMobile={isMobile}
                  onChange={(v) => set('intervalSeconds', v)}
                />
              )}
              {draft.scheduleType === 'cron' && (
                <Input
                  className="h-9 w-auto" placeholder="0 9 * * *"
                  value={draft.cronExpr} onChange={(e) => set('cronExpr', e.target.value)}
                />
              )}
              <button
                type="button"
                aria-pressed={draft.autoRun}
                onClick={() => set('autoRun', !draft.autoRun)}
                className={cn(
                  'flex h-9 items-center rounded-full border px-3 text-sm transition-colors',
                  draft.autoRun ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border/80 bg-card text-muted-foreground',
                )}
              >
                自动执行
              </button>
              <span className="text-xs text-muted-foreground">关闭则仅生成提醒任务，不自动开跑</span>
            </div>
          </div>

          {(localError || error) && <p className="mt-2 text-sm text-red-600">{localError ?? error}</p>}

          <div className="mt-3 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: 全部 pass。

- [ ] **Step 5: 跑前端 typecheck 确认零新增错误**

Run: `cd web && npm run typecheck 2>&1 | tail -5`
Expected: 与改动前同样的错误数，不得多。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(tasks): unify the scheduled-task dialog with the task composer layout"
```

---

## Task 9: `ScheduledTasksPanel` 加同步连击守卫

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksPanel.tsx`

- [ ] **Step 1: 实现**

`import { forwardRef, useCallback, useImperativeHandle, useState } from 'react';` 改为：

```ts
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
```

在 `const [formKey, setFormKey] = useState(0);` 之后加：

```ts
  // 连击守卫。用同步的 ref 而不是 submitting state：setState 要等下一轮渲染才生效，
  // 同一 tick 里（双击、Enter 连击）的第二次调用读到的还是旧值。标题留空时后端要等
  // 模型取名（最长 3s），这个窗口期足够双击两次。
  const submittingRef = useRef(false);
```

`submit` 改为：

```ts
  async function submit(draft: ScheduledTaskDraft) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const body = toApiBody(draft);
    try {
      const res = editing
        ? await api.scheduledTasks.update(editing.schedule_id, body)
        : await api.scheduledTasks.create(body);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message ?? `保存失败 (${res.status})`);
        return;
      }
      setFormOpen(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
```

`ScheduledTaskForm` 的 `onClose` 也改用 ref（现在是裸 `setFormOpen(false)`，在途时弹窗仍能被关掉）：

```tsx
        onClose={() => { if (!submittingRef.current) setFormOpen(false); }}
```

- [ ] **Step 2: 跑邻居测试确认没连累别人**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx`
Expected: 全部 pass（panel 本身无测试覆盖，这一步只确认没打破邻居）。

- [ ] **Step 3: Commit**

```bash
git add web/src/components/tasks/ScheduledTasksPanel.tsx
git commit -m "fix(tasks): guard the scheduled-task form against double submits"
```

---

## Task 10: 删掉死代码 `TaskEngineSelect`

**Files:**
- Delete: `web/src/components/tasks/TaskEngineSelect.tsx`
- Delete: `web/src/components/tasks/TaskEngineSelect.test.tsx`

- [ ] **Step 1: 确认真的没人用了**

Run: `cd /mnt/b/workdir/github/lovdex && grep -rn "TaskEngineSelect" web/src`
Expected: 只剩 `TaskEngineSelect.tsx` 与 `TaskEngineSelect.test.tsx` 自身的行。若还有别的引用，**停下**，说明计划有误。

- [ ] **Step 2: 删除**

```bash
git rm web/src/components/tasks/TaskEngineSelect.tsx web/src/components/tasks/TaskEngineSelect.test.tsx
```

- [ ] **Step 3: 确认 `ENGINE_NAMES` 仍然有人用**

Run: `cd /mnt/b/workdir/github/lovdex && grep -rn "ENGINE_NAMES" web/src`
Expected: 至少 `useTaskEngineAvailability.ts`（定义）与 `ScheduledTaskForm.tsx`（使用）。若它在 `useTaskEngineAvailability.ts` 里变成只导出未使用，**不要删** —— 它是该 hook 模块的公开常量。

- [ ] **Step 4: typecheck**

Run: `cd web && npm run typecheck 2>&1 | tail -5`
Expected: 零新增错误。

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(tasks): drop the now-unused TaskEngineSelect"
```

---

## Task 11: 端到端手工验收

自动化测试覆盖不到「弹窗长什么样、后端真的叫了模型」，这一步用真实运行的应用补上。

- [ ] **Step 1: 起前后端**

`cd backend && npm run dev`，另开终端 `cd web && npm run dev`。

**注意**：重启后端前必须先问用户（同一后端跑着别的项目，见 `lovdex-backend-restart-requires-confirm`）。若后端已在运行且代码已热加载，跳过重启。

- [ ] **Step 2: 浏览器验收**

用 `http://<本机IP>:5188`（不是 localhost）打开，进 `/tasks?view=scheduled`，点右上「新建任务」：

1. 弹窗宽度与「新建任务」弹窗一致（约 66.7vw），不再是窄条
2. 描述输入框是大的多行框，占位文案含「名称留空会自动生成」
3. 工具条是胶囊 chip：名称 / 项目 / 引擎 / 优先级 / 标签，右下角圆形箭头按钮
4. 描述为空时圆形按钮是灰的、点不动
5. 填一段描述、名称留空 → 点提交 → 保存后列表里的标题是 AI 提炼的短名（**不是**描述首行原文）；若首行原文出现了，等 1~2 秒看 WS 是否推来第二次更新
6. 编辑该条，把名称清空再保存 → 标题重新生成
7. 编辑该条，只改优先级、不动名称 → 标题不变
8. 切到「间隔」和「Cron」，确认条件字段跟着换

- [ ] **Step 3: 记录结果**

把不符合预期的点写回 spec 或直接修；全部符合则本计划完成。

---

## 自查记录

**Spec 覆盖**：§1 组件结构 → Task 8；§2 字段映射 → Task 8；§3 校验与提交 → Task 6/8/9；§4.1 抽取 → Task 1；§4.2 接线 → Task 2/3；§4.3 回写 → Task 2；§4.4 路由与接线 → Task 4/5；§4.5 调度路径注释 → Task 2 Step 4；§5 降级 → Task 1/2；§6 测试 → 各 Task 内；§7 不在范围内 → 未安排任务（正确）；§8 影响面 → Task 10（删死代码）、描述必填的副作用已在 spec 确认。

**类型一致性**：`resolveGeneratedTitle` 在 Task 1 定义，Task 2/3 调用，签名一致（`{ title, description, generateTitle, blockingMs }` → `{ title, writeBack }`）。`applyGeneratedTitle(scheduleId, generated, placeholderTitle)` 在 Task 2 一次成型，create/update 两处调用一致。`canSubmitScheduledTask(description, submitting)` 在 Task 6 定义、Task 8 使用。`toApiBody` 在 Task 7 定义并导出、Task 9 从 `ScheduledTaskForm` import。`toProjectChipOptions` 在 Task 8 定义并导出、同任务内使用。

**测试基座对齐**：scheduler 测试用的是 `makeService(nowIso, extra)` 返回的 `{ svc, rows, createdTasks, launches, broadcasts }`（无 `db`，行数据在 `rows` 这个 Map 里，`createScheduledTask` 固定写 `schedule_id: 'new'`）；断言一律走 `rows.get(...)`，不虚构 `db.getScheduledTask`。

**已知取舍**：项目 chip 的远端项目显示方式从「`🌐 dev-01 · MyApp`」改为「label + 右侧 hint」（对齐 `CreateTaskDialog`），这是本次唯一一处**可见**的行为变化，Task 8 的 `toProjectChipOptions` 测试把它钉住了。
