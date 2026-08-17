# Task 多项目筛选 + 批量删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Task 页项目筛选从单选改为多选（🤖 Lovdex助手 并入多选），并在表格 + 看板两个视图支持勾选任务批量删除。

**Architecture:** 前端 `TaskFilter.projectPath: string` → `projectPaths: string[]`，加 `normalizeTaskFilter` 迁移老 localStorage；新增 `ProjectMultiSelect` 多选下拉替换单选 `<select>` 与「只看助手」开关。批量删除走新后端接口 `POST /api/tasks/batch-delete`（service 循环删库 + 逐个 `task_deleted` 广播），选择状态提升到 `TaskBoard` 共享给表格（复选框列 + 全选）与看板（卡片复选框）。

**Tech Stack:** 后端 Node.js + Express + better-sqlite3，测试 `node --test --import tsx`（cwd=`backend/`，`TSX_TSCONFIG_PATH` 已指向 `server/tsconfig.json`）。前端 React + TypeScript + Tailwind，测试 `env -u TSX_TSCONFIG_PATH npx tsx --test`（cwd=`web/`，组件用 `react-dom/server` `renderToStaticMarkup` 冒烟）。仓库根 `/mnt/b/workdir/github/lovdex/lovdex`。

**设计文档:** `docs/superpowers/specs/2026-08-17-task-multi-project-filter-batch-delete-design.md`

---

## 文件结构

- `backend/server/modules/tasks/services/tasks.service.ts` — 加 `deleteTasks(ids)`
- `backend/server/modules/tasks/tests/tasks.service.test.ts` — 加 `deleteTasks` 测试
- `backend/server/modules/tasks/tasks.routes.ts` — 加 `POST /api/tasks/batch-delete`
- `backend/server/modules/tasks/tests/tasks.routes.test.ts` — 新文件：批量删除路由测试
- `web/src/components/tasks/taskFilter.ts` — 类型改多选 + `normalizeTaskFilter` + `toggleProjectFilter`
- `web/src/components/tasks/taskFilter.test.ts` — 更新 + 新增测试
- `web/src/components/tasks/ProjectMultiSelect.tsx` — 新文件：多选下拉
- `web/src/components/tasks/TaskFilterBar.tsx` — 用多选替换单选 + 移除只看助手
- `web/src/components/tasks/TaskFilterBar.test.tsx` — 更新测试
- `web/src/components/tasks/TaskBoard.tsx` — filter 归一化 + selection 状态 + 操作条 + 删除
- `web/src/components/tasks/TaskTableView.tsx` — 复选框列 + 全选表头
- `web/src/components/tasks/TaskCard.tsx` — 卡片复选框
- `web/src/utils/api.js` — `tasks.removeMany`

---

## Task 1: 后端 `deleteTasks` 服务方法

**Files:**
- Modify: `backend/server/modules/tasks/services/tasks.service.ts`（在 `deleteTask` 之后插入）
- Test: `backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tasks.service.test.ts` 的 `deleteTask broadcasts task_deleted` 测试之后追加：

```ts
test('deleteTasks deletes each id and broadcasts task_deleted per id', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const n = svc.deleteTasks(['t1', 'missing']);
  assert.equal(n, 2);
  assert.equal(events.length, 2);
  assert.equal((events[0] as { taskId: string }).taskId, 't1');
  assert.equal((events[1] as { taskId: string }).taskId, 'missing');
  assert.equal(db.getTask('t1'), null);
});

test('deleteTasks with an empty list is a no-op', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  assert.equal(svc.deleteTasks([]), 0);
  assert.equal(events.length, 0);
  assert.equal(db.getTask('t1')?.task_id, 't1');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（cwd=`backend/`）:
```bash
node --test --import tsx server/modules/tasks/tests/tasks.service.test.ts
```
Expected: FAIL —— `TypeError: svc.deleteTasks is not a function`（或类型层面 `deleteTasks` 不存在）。

- [ ] **Step 3: 实现最小代码**

在 `tasks.service.ts` 返回对象里，`deleteTask` 方法（约 348-351 行）之后插入：

```ts
    deleteTasks(taskIds: string[]): number {
      let deleted = 0;
      for (const taskId of taskIds) {
        resolveDb.deleteTask(taskId);
        emit({ kind: 'task_deleted', taskId, actor: 'user' });
        deleted += 1;
      }
      return deleted;
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run（cwd=`backend/`）:
```bash
node --test --import tsx server/modules/tasks/tests/tasks.service.test.ts
```
Expected: PASS（新增 2 条 + 既有全部通过）。

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat(tasks): add deleteTasks batch service method"
```

---

## Task 2: 后端 `POST /api/tasks/batch-delete` 路由

**Files:**
- Modify: `backend/server/modules/tasks/tasks.routes.ts`
- Create: `backend/server/modules/tasks/tests/tasks.routes.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `backend/server/modules/tasks/tests/tasks.routes.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { buildTasksRouter } from '../tasks.routes.js';
import type { TasksService } from '../services/tasks.service.js';
import { AppError } from '@/shared/utils.js';

/** 挂载批量删除路由 + 一个映射 AppError 的错误中间件（复刻 index.js 的全局中间件）。 */
function buildTestApp(deleted: { calls: string[][] }) {
  const app = express();
  app.use(express.json());
  const fakeService = {
    deleteTasks: (ids: string[]) => {
      deleted.calls.push(ids);
      return ids.length;
    },
  } as unknown as TasksService;
  app.use('/api/tasks', buildTasksRouter(fakeService, { createSession: () => 's1' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    }
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'internal' } });
  });
  return app;
}

function listen(t: ReturnType<typeof test>, deleted: { calls: string[][] }) {
  const server = buildTestApp(deleted).listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return { port };
}

test('POST /api/tasks/batch-delete forwards ids and returns the deleted count', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: ['t1', 't2'] }),
  });
  assert.strictEqual(res.status, 200);
  assert.deepEqual(deleted.calls, [['t1', 't2']]);
  assert.deepEqual(await res.json(), { success: true, deleted: 2 });
});

test('POST /api/tasks/batch-delete rejects a missing or non-array taskIds', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: 't1' }),
  });
  assert.strictEqual(res.status, 400);
  assert.deepEqual(deleted.calls, []);
});

test('POST /api/tasks/batch-delete rejects a non-string entry', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: ['t1', 42] }),
  });
  assert.strictEqual(res.status, 400);
  assert.deepEqual(deleted.calls, []);
});

test('POST /api/tasks/batch-delete rejects an empty or oversized list', async (t) => {
  const deleted: { calls: string[][] } = { calls: [] };
  const { port } = listen(t, deleted);
  const empty = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: [] }),
  });
  assert.strictEqual(empty.status, 400);
  const big = await fetch(`http://127.0.0.1:${port}/api/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: Array.from({ length: 501 }, (_, i) => `t${i}`) }),
  });
  assert.strictEqual(big.status, 400);
  assert.deepEqual(deleted.calls, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（cwd=`backend/`）:
```bash
node --test --import tsx server/modules/tasks/tests/tasks.routes.test.ts
```
Expected: FAIL —— 路由不存在，POST `/api/tasks/batch-delete` 落到 404（`res.status` 断言失败）。

- [ ] **Step 3: 实现路由**

在 `tasks.routes.ts` 的 `DELETE /:taskId` 路由之前插入（放在 `move` 之后、`DELETE` 之前）：

```ts
  // POST /api/tasks/batch-delete
  router.post(
    '/batch-delete',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskIds = body.taskIds;
      if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 500) {
        throw new AppError('invalid taskIds: expected a non-empty array of at most 500 ids', {
          code: 'INVALID_REQUEST',
          statusCode: 400,
        });
      }
      if (!taskIds.every((id) => typeof id === 'string' && id.length > 0)) {
        throw new AppError('invalid taskIds: every entry must be a non-empty string', {
          code: 'INVALID_REQUEST',
          statusCode: 400,
        });
      }
      const deleted = tasksService.deleteTasks(taskIds as string[]);
      res.json({ success: true, deleted });
    }),
  );
```

- [ ] **Step 4: 运行测试确认通过**

Run（cwd=`backend/`）:
```bash
node --test --import tsx server/modules/tasks/tests/tasks.routes.test.ts
```
Expected: PASS（4 条全部通过）。

- [ ] **Step 5: 类型检查 + 提交**

Run（cwd=`backend/`）:
```bash
npm run typecheck
```
Expected: 无错误。

```bash
git add backend/server/modules/tasks/tasks.routes.ts backend/server/modules/tasks/tests/tasks.routes.test.ts
git commit -m "feat(tasks): add POST /api/tasks/batch-delete endpoint"
```

---

## Task 3: `taskFilter.ts` 多选类型 + 迁移 + 过滤逻辑

> 注意：本任务改 `TaskFilter` 类型后，`TaskFilterBar.tsx` 与 `TaskBoard.tsx` 仍引用旧的 `projectPath`/`assistantOnly`，`web/` 的 `npm run typecheck` 会在 Task 3–5 之间暂时失败，属预期；Task 5/6 完成后恢复。前端测试命令不受影响（`tsx` 不做类型检查）。

**Files:**
- Modify: `web/src/components/tasks/taskFilter.ts`
- Test: `web/src/components/tasks/taskFilter.test.ts`

- [ ] **Step 1: 写失败测试**

更新 `taskFilter.test.ts`：把 `filterOf` 之上的 helper 区改为多选形状，替换两个旧项目过滤测试，并新增迁移/切换测试。具体改动：

1. 顶部导入与 `filterOf` 保持不变（`filterOf` 用 `{ ...EMPTY_TASK_FILTER, ...patch }`，`EMPTY_TASK_FILTER` 改后自带 `projectPaths: []`）。

2. 替换 `filterTasks: project path exact match` 测试：

```ts
test('filterTasks: single project path match', () => {
  const a = mkTask({ task_id: 'a', project_path: '/p1' });
  const b = mkTask({ task_id: 'b', project_path: '/p2' });
  const out = filterTasks([a, b], filterOf({ projectPaths: ['/p1'] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: multiple projects are OR-ed together', () => {
  const a = mkTask({ task_id: 'a', project_path: '/p1' });
  const b = mkTask({ task_id: 'b', project_path: '/p2' });
  const c = mkTask({ task_id: 'c', project_path: '/p3' });
  const out = filterTasks([a, b, c], filterOf({ projectPaths: ['/p1', '/p2'] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});
```

3. 替换 `filterTasks: assistant option keeps operator tasks` 测试：

```ts
test('filterTasks: assistant sentinel keeps operator tasks', () => {
  const a = mkTask({ task_id: 'a', is_operator: 1 });
  const b = mkTask({ task_id: 'b', is_operator: 0 });
  const out = filterTasks([a, b], filterOf({ projectPaths: [ASSISTANT_OPTION_VALUE] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: assistant + a project are OR-ed together', () => {
  const a = mkTask({ task_id: 'a', is_operator: 1 });
  const b = mkTask({ task_id: 'b', project_path: '/p1' });
  const c = mkTask({ task_id: 'c', project_path: '/p2' });
  const out = filterTasks([a, b, c], filterOf({ projectPaths: [ASSISTANT_OPTION_VALUE, '/p1'] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('filterTasks: empty projectPaths means no project filter', () => {
  const a = mkTask({ task_id: 'a', project_path: '/p1' });
  const b = mkTask({ task_id: 'b', is_operator: 1 });
  const out = filterTasks([a, b], filterOf({ projectPaths: [] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});
```

4. 删除 `filterTasks: assistantOnly keeps only operator tasks` 测试。

5. 新增迁移 + 切换测试（追加在文件末尾，`normalizeTaskFilter`/`toggleProjectFilter` 导入见 Step 3）：

```ts
test('normalizeTaskFilter: migrates legacy single projectPath', () => {
  const out = normalizeTaskFilter({ projectPath: '/p1', preset: 'all' });
  assert.deepEqual(out.projectPaths, ['/p1']);
  assert.equal(out.dateField, 'created');
});

test('normalizeTaskFilter: migrates legacy assistantOnly to the sentinel', () => {
  const out = normalizeTaskFilter({ projectPath: '', assistantOnly: true });
  assert.deepEqual(out.projectPaths, [ASSISTANT_OPTION_VALUE]);
});

test('normalizeTaskFilter: keeps the new projectPaths shape as-is', () => {
  const out = normalizeTaskFilter({ projectPaths: ['/p1', ASSISTANT_OPTION_VALUE], dateField: 'deadline', preset: 'week', customFrom: '', customTo: '' });
  assert.deepEqual(out.projectPaths, ['/p1', ASSISTANT_OPTION_VALUE]);
  assert.equal(out.dateField, 'deadline');
  assert.equal(out.preset, 'week');
});

test('normalizeTaskFilter: null/undefined/empty falls back to defaults', () => {
  assert.deepEqual(normalizeTaskFilter(null).projectPaths, []);
  assert.deepEqual(normalizeTaskFilter(undefined).projectPaths, []);
  assert.deepEqual(normalizeTaskFilter({}).projectPaths, []);
});

test('toggleProjectFilter: adds and removes a value', () => {
  assert.deepEqual(toggleProjectFilter([], '/p1'), ['/p1']);
  assert.deepEqual(toggleProjectFilter(['/p1', '/p2'], '/p2'), ['/p1']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskFilter.test.ts
```
Expected: FAIL —— `projectPaths` 不存在于 `TaskFilter`，`normalizeTaskFilter`/`toggleProjectFilter` 未导出。

- [ ] **Step 3: 实现**

用以下内容整体替换 `taskFilter.ts`：

```ts
import type { Task } from '../../types/app';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';

export type TaskDateField = 'created' | 'deadline' | 'activity';
export type TaskFilterPreset = 'all' | 'today' | 'week' | 'month' | 'year';

export type TaskFilter = {
  projectPaths: string[];
  dateField: TaskDateField;
  preset: TaskFilterPreset;
  customFrom: string;
  customTo: string;
};

export const EMPTY_TASK_FILTER: TaskFilter = {
  projectPaths: [],
  dateField: 'created',
  preset: 'all',
  customFrom: '',
  customTo: '',
};

/**
 * 归一化持久化在 localStorage 里的筛选对象：兼容旧的 `projectPath: string` /
 * `assistantOnly: boolean` 形状（老用户无感迁移），缺失字段补默认值。
 */
export function normalizeTaskFilter(raw: unknown): TaskFilter {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let projectPaths: string[] = [];
  if (Array.isArray(src.projectPaths)) {
    projectPaths = (src.projectPaths as unknown[]).filter((v): v is string => typeof v === 'string');
  } else {
    const legacyPath = typeof src.projectPath === 'string' ? src.projectPath : '';
    if (legacyPath) projectPaths = [legacyPath];
    if (src.assistantOnly === true && !projectPaths.includes(ASSISTANT_OPTION_VALUE)) {
      projectPaths = [ASSISTANT_OPTION_VALUE];
    }
  }
  return {
    projectPaths,
    dateField:
      src.dateField === 'deadline' || src.dateField === 'activity' ? src.dateField : 'created',
    preset:
      src.preset === 'today' || src.preset === 'week' || src.preset === 'month' || src.preset === 'year'
        ? src.preset
        : 'all',
    customFrom: typeof src.customFrom === 'string' ? src.customFrom : '',
    customTo: typeof src.customTo === 'string' ? src.customTo : '',
  };
}

/** 勾选/取消勾选一个项目（或助手哨兵），返回新的 projectPaths 数组。 */
export function toggleProjectFilter(paths: string[], value: string): string[] {
  return paths.includes(value) ? paths.filter((p) => p !== value) : [...paths, value];
}

/**
 * 解析生效的日期区间（本地时区，毫秒时间戳）。返回 null 表示不过滤日期。
 * 自定义 from/to 优先；只设一侧时另一侧无界；否则按 preset 快捷项计算。
 */
export function resolveDateRange(
  filter: TaskFilter,
  now: Date,
): { from: number; to: number } | null {
  if (filter.customFrom || filter.customTo) {
    const from = filter.customFrom
      ? Date.parse(`${filter.customFrom}T00:00:00`)
      : Number.NEGATIVE_INFINITY;
    const to = filter.customTo
      ? Date.parse(`${filter.customTo}T23:59:59.999`)
      : Number.POSITIVE_INFINITY;
    if (Number.isNaN(from) || Number.isNaN(to)) return null;
    return { from, to };
  }

  const startOfDay = () => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const endOfDay = () => {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d;
  };

  switch (filter.preset) {
    case 'all':
      return null;
    case 'today': {
      return { from: startOfDay().getTime(), to: endOfDay().getTime() };
    }
    case 'week': {
      const from = startOfDay();
      const diff = from.getDay() === 0 ? 6 : from.getDay() - 1; // 周一 = 0 偏移
      from.setDate(from.getDate() - diff);
      return { from: from.getTime(), to: endOfDay().getTime() };
    }
    case 'month': {
      const from = startOfDay();
      from.setDate(1);
      return { from: from.getTime(), to: endOfDay().getTime() };
    }
    case 'year': {
      const from = new Date(now.getFullYear(), 0, 1);
      from.setHours(0, 0, 0, 0);
      return { from: from.getTime(), to: endOfDay().getTime() };
    }
  }
}

/** 取任务在指定日期字段上的毫秒时间戳；缺失或非法返回 null。deadline 按当天 23:59:59.999 算。 */
function taskDateValue(task: Task, field: TaskDateField): number | null {
  const raw =
    field === 'created' ? task.created_at
      : field === 'deadline' ? task.deadline
        : task.updated_at;
  if (!raw) return null;
  const iso = field === 'deadline' ? `${raw}T23:59:59.999` : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** 按 项目多选 → 日期 两个维度（AND）过滤任务。 */
export function filterTasks(tasks: Task[], filter: TaskFilter, now: Date): Task[] {
  const range = resolveDateRange(filter, now);
  return tasks.filter((task) => {
    if (filter.projectPaths.length > 0) {
      const match =
        (filter.projectPaths.includes(ASSISTANT_OPTION_VALUE) && task.is_operator === 1) ||
        filter.projectPaths.includes(task.project_path);
      if (!match) return false;
    }
    if (range) {
      const value = taskDateValue(task, filter.dateField);
      if (value === null) return false;
      if (value < range.from || value > range.to) return false;
    }
    return true;
  });
}
```

在 `taskFilter.test.ts` 顶部导入加 `normalizeTaskFilter`、`toggleProjectFilter`：

```ts
import {
  EMPTY_TASK_FILTER,
  filterTasks,
  normalizeTaskFilter,
  resolveDateRange,
  toggleProjectFilter,
  type TaskFilter,
} from './taskFilter';
```

- [ ] **Step 4: 运行测试确认通过**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskFilter.test.ts
```
Expected: PASS（全部通过，含旧日期测试）。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/tasks/taskFilter.ts web/src/components/tasks/taskFilter.test.ts
git commit -m "feat(tasks): multi-project filter model + legacy migration"
```

---

## Task 4: `ProjectMultiSelect.tsx` 多选下拉组件

**Files:**
- Create: `web/src/components/tasks/ProjectMultiSelect.tsx`

> 组件把 popover 列表始终渲染在 DOM 里、用 `hidden` 控制显隐，使 `renderToStaticMarkup` 冒烟测试能断言选项文案（与仓库 SSR 冒烟测试风格一致）。

- [ ] **Step 1: 写失败测试**

新建 `web/src/components/tasks/ProjectMultiSelect.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { ProjectMultiSelect } from './ProjectMultiSelect';

test('renders the trigger summary and all option labels', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      value: [],
      onChange: () => {},
    }),
  );
  assert.match(html, /项目/);
  assert.match(html, /全部项目/);
  assert.match(html, /Lovdex助手/);
  assert.match(html, /proj/);
  assert.match(html, /全选/);
  assert.match(html, /清空/);
});

test('shows a single selected label and the multi summary', () => {
  const one = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      value: ['/p'],
      onChange: () => {},
    }),
  );
  assert.match(one, /proj/);

  const many = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [
        { value: '/p', label: 'proj' },
        { value: '/q', label: 'qproj' },
      ],
      value: ['/p', '/q'],
      onChange: () => {},
    }),
  );
  assert.match(many, /2 个项目/);
});

test('renders the assistant sentinel as an option', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [],
      value: [ASSISTANT_OPTION_VALUE],
      onChange: () => {},
    }),
  );
  assert.match(html, /Lovdex助手/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ProjectMultiSelect.test.tsx
```
Expected: FAIL —— `Cannot find module './ProjectMultiSelect'`。

- [ ] **Step 3: 实现**

新建 `web/src/components/tasks/ProjectMultiSelect.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';

import type { TaskProjectOption } from './TaskCard';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { toggleProjectFilter } from './taskFilter';

type ProjectMultiSelectProps = {
  projectOptions: TaskProjectOption[];
  value: string[];
  onChange: (next: string[]) => void;
};

function labelOf(value: string, projectOptions: TaskProjectOption[]): string {
  if (value === ASSISTANT_OPTION_VALUE) return '🤖 Lovdex助手';
  return projectOptions.find((o) => o.value === value)?.label ?? value;
}

/** 项目多选下拉：触发器显示摘要，展开为可勾选列表 + 全选/清空。 */
export function ProjectMultiSelect({ projectOptions, value, onChange }: ProjectMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const allValues = [ASSISTANT_OPTION_VALUE, ...projectOptions.map((o) => o.value)];

  const summary =
    value.length === 0
      ? '全部项目'
      : value.length === 1
        ? labelOf(value[0], projectOptions)
        : `${value.length} 个项目`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-xl border-2 border-border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none"
      >
        <span className="text-muted-foreground">项目</span>
        <span className="max-w-40 truncate">{summary}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      <div
        className={cn(
          'absolute left-0 top-full z-20 mt-1 w-64 max-w-[80vw] rounded-xl border border-border bg-popover p-1.5 shadow-lg',
          open ? '' : 'hidden',
        )}
      >
        <div className="max-h-64 overflow-y-auto">
          {allValues.map((v) => {
            const checked = value.includes(v);
            return (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/60"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(toggleProjectFilter(value, v))}
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
                <span className="flex-1 truncate">{labelOf(v, projectOptions)}</span>
                {checked && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </label>
            );
          })}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-border/60 px-1 pt-1.5 text-xs">
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange(allValues)}>
            全选
          </button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange([])}>
            清空
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ProjectMultiSelect.test.tsx
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/tasks/ProjectMultiSelect.tsx web/src/components/tasks/ProjectMultiSelect.test.tsx
git commit -m "feat(tasks): add ProjectMultiSelect dropdown component"
```

---

## Task 5: `TaskFilterBar.tsx` 接入多选 + 移除只看助手

**Files:**
- Modify: `web/src/components/tasks/TaskFilterBar.tsx`
- Test: `web/src/components/tasks/TaskFilterBar.test.tsx`

- [ ] **Step 1: 写失败测试**

用以下内容整体替换 `TaskFilterBar.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EMPTY_TASK_FILTER } from './taskFilter';
import { TaskFilterBar } from './TaskFilterBar';

test('filter bar renders the project multi-select and no assistant toggle', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: EMPTY_TASK_FILTER,
      onChange: () => {},
    }),
  );
  assert.match(html, /全部项目/);
  assert.match(html, /Lovdex助手/);
  assert.match(html, /proj/);
  assert.match(html, /创建时间/);
  assert.match(html, /最近活动/);
  assert.doesNotMatch(html, /只看助手/);
  assert.doesNotMatch(html, /清除筛选/);
});

test('filter bar shows the selected project and a clear button when active', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: { ...EMPTY_TASK_FILTER, projectPaths: ['/p'] },
      onChange: () => {},
    }),
  );
  assert.match(html, /proj/);
  assert.match(html, /清除筛选/);
});

test('filter bar mobile trigger shows a multi-project summary', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: { ...EMPTY_TASK_FILTER, projectPaths: ['/p'], preset: 'today' },
      onChange: () => {},
    }),
  );
  assert.match(html, /筛选/);
  assert.match(html, /项目：proj · 日期：今天/);
  assert.match(html, /aria-expanded="false"/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskFilterBar.test.tsx
```
Expected: FAIL —— 组件仍渲染单选 `<select>`/「只看助手」，断言 `/只看助手/` 反匹配、`/全部项目/` 等不匹配（同时因 `filter.projectPath` 不存在而运行时报错）。

- [ ] **Step 3: 实现**

用以下内容整体替换 `TaskFilterBar.tsx`：

```tsx
import { useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Pill, PillBar } from '../../shared/view/ui';

import type { TaskProjectOption } from './TaskCard';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { ProjectMultiSelect } from './ProjectMultiSelect';
import {
  EMPTY_TASK_FILTER,
  type TaskDateField,
  type TaskFilter,
  type TaskFilterPreset,
} from './taskFilter';

const DATE_FIELD_OPTIONS: { value: TaskDateField; label: string }[] = [
  { value: 'created', label: '创建时间' },
  { value: 'deadline', label: '截止时间' },
  { value: 'activity', label: '最近活动' },
];

const PRESET_OPTIONS: { value: TaskFilterPreset; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '今年' },
  { value: 'all', label: '全部' },
];

type TaskFilterBarProps = {
  projectOptions: TaskProjectOption[];
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
};

/** 项目维度的摘要文案：全部 / 单个标签 / N 个项目。 */
function projectFilterLabel(filter: TaskFilter, projectOptions: TaskProjectOption[]): string {
  const paths = filter.projectPaths;
  if (paths.length === 0) return '全部';
  if (paths.length === 1) {
    const v = paths[0];
    return v === ASSISTANT_OPTION_VALUE
      ? '🤖 Lovdex助手'
      : projectOptions.find((o) => o.value === v)?.label ?? v;
  }
  return `${paths.length} 个`;
}

/** 移动端触发行上的一句话摘要，例如「项目：全部 · 日期：今天」。 */
function filterSummary(filter: TaskFilter, projectOptions: TaskProjectOption[]): string {
  const projectLabel = projectFilterLabel(filter, projectOptions);
  const dateRange =
    filter.customFrom || filter.customTo
      ? `${filter.customFrom || '…'} ~ ${filter.customTo || '…'}`
      : PRESET_OPTIONS.find((p) => p.value === filter.preset)?.label ?? '全部';
  return `项目：${projectLabel} · 日期：${dateRange}`;
}

/**
 * Task 页筛选栏：项目多选 + 日期字段切换 + 快捷项 + 自定义范围。
 * 移动端（<sm）默认折叠为「筛选」触发行，点开展开全部控件；
 * 桌面端（≥sm）始终展开，分组 justify-between 铺满一行。
 */
export function TaskFilterBar({ projectOptions, filter, onChange }: TaskFilterBarProps) {
  const [open, setOpen] = useState(false);

  const hasFilter =
    filter.projectPaths.length > 0 ||
    filter.preset !== 'all' ||
    filter.customFrom !== '' ||
    filter.customTo !== '';

  const pickPreset = (preset: TaskFilterPreset) => {
    onChange({ ...filter, preset, customFrom: '', customTo: '' });
  };

  const presetActive = (preset: TaskFilterPreset) =>
    filter.preset === preset && filter.customFrom === '' && filter.customTo === '';

  const summary = filterSummary(filter, projectOptions);

  return (
    <div className="border-b border-border/60 sm:border-0">
      {/* 移动端触发行 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground sm:hidden"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
        筛选
        <span className="truncate text-muted-foreground/80">{summary}</span>
        {hasFilter && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />}
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>

      {/* 控件区：移动端折叠展开；桌面端固定一排（放不下时横向滚动），能放下则 mx-auto 居中留白 */}
      <div className="sm:overflow-x-auto">
        <div
          className={cn(
            'gap-x-3 gap-y-2 sm:mx-auto sm:flex sm:w-max sm:flex-row sm:flex-nowrap sm:items-center sm:gap-x-6 sm:px-4 sm:py-2',
            open ? 'flex flex-col px-3 pb-2 pt-1' : 'hidden sm:flex',
          )}
        >
          {/* 左簇：项目多选 */}
          <div className="flex flex-wrap items-center gap-2">
            <ProjectMultiSelect
              projectOptions={projectOptions}
              value={filter.projectPaths}
              onChange={(projectPaths) => onChange({ ...filter, projectPaths })}
            />
          </div>

          {/* 中左簇：日期字段 */}
          <PillBar>
            {DATE_FIELD_OPTIONS.map((o) => (
              <Pill
                key={o.value}
                isActive={filter.dateField === o.value}
                onClick={() => onChange({ ...filter, dateField: o.value })}
              >
                {o.label}
              </Pill>
            ))}
          </PillBar>

          {/* 中右簇：快捷项 */}
          <PillBar>
            {PRESET_OPTIONS.map((o) => (
              <Pill
                key={o.value}
                isActive={presetActive(o.value)}
                onClick={() => pickPreset(o.value)}
              >
                {o.label}
              </Pill>
            ))}
          </PillBar>

          {/* 右簇：自定义范围 + 清除 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-xl border-2 border-border bg-card px-2.5 py-1.5">
              <span className="text-sm text-muted-foreground">从</span>
              <input
                type="date"
                className={`bg-transparent text-sm text-foreground outline-none ${
                  filter.customFrom === '' ? 'date-empty' : ''
                }`}
                value={filter.customFrom}
                onChange={(e) => onChange({ ...filter, preset: 'all', customFrom: e.target.value })}
              />
              <span className="text-sm text-muted-foreground">至</span>
              <input
                type="date"
                className={`bg-transparent text-sm text-foreground outline-none ${
                  filter.customTo === '' ? 'date-empty' : ''
                }`}
                value={filter.customTo}
                onChange={(e) => onChange({ ...filter, preset: 'all', customTo: e.target.value })}
              />
            </div>

            {hasFilter && (
              <button
                type="button"
                className="rounded-lg px-2 py-1.5 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => onChange(EMPTY_TASK_FILTER)}
              >
                清除筛选
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskFilterBar.test.tsx src/components/tasks/ProjectMultiSelect.test.tsx
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/tasks/TaskFilterBar.tsx web/src/components/tasks/TaskFilterBar.test.tsx
git commit -m "feat(tasks): multi-select project filter bar"
```

---

## Task 6: `TaskBoard.tsx` filter 归一化接线

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 改导入**

把 taskFilter 导入行：

```ts
import { EMPTY_TASK_FILTER, filterTasks, type TaskFilter } from './taskFilter';
```

改为：

```ts
import { EMPTY_TASK_FILTER, filterTasks, normalizeTaskFilter, type TaskFilter } from './taskFilter';
```

- [ ] **Step 2: 改 filter 状态读取**

把：

```ts
  const [filter, setFilter] = useLocalStorage<TaskFilter>('taskFilter', EMPTY_TASK_FILTER);
```

改为：

```ts
  const [storedFilter, setFilter] = useLocalStorage<unknown>('taskFilter', EMPTY_TASK_FILTER);
  const filter = useMemo(() => normalizeTaskFilter(storedFilter), [storedFilter]);
```

（`setFilter` 继续作为 `TaskFilterBar` 的 `onChange` 传入；`useMemo` 已在上方导入。）

- [ ] **Step 3: 验证筛选功能类型闭合**

Run（cwd=`web/`）:
```bash
npm run typecheck
```
Expected: 无错误（Task 3–5 遗留的 `projectPath`/`assistantOnly` 引用已全部消除）。

- [ ] **Step 4: 提交**

```bash
git add web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): normalize persisted filter shape on read"
```

---

## Task 7: `api.js` 增加 `removeMany`

**Files:**
- Modify: `web/src/utils/api.js`

- [ ] **Step 1: 实现**

在 `tasks` 对象的 `remove` 行之后插入：

```js
    remove: (taskId) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
    removeMany: (taskIds) =>
      authenticatedFetch('/api/tasks/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ taskIds }),
      }),
```

- [ ] **Step 2: 验证**

Run（cwd=`web/`）:
```bash
npm run typecheck
```
Expected: 无错误（`api.js` 为 JS，typecheck 的 allowJs 会顺带解析）。

- [ ] **Step 3: 提交**

```bash
git add web/src/utils/api.js
git commit -m "feat(tasks): add api.tasks.removeMany"
```

---

## Task 8: `TaskTableView.tsx` 选择列 + 全选

**Files:**
- Modify: `web/src/components/tasks/TaskTableView.tsx`
- Test: `web/src/components/tasks/TaskTableView.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `TaskTableView.test.tsx` 末尾追加：

```tsx
test('table renders a select-all checkbox when selection is wired', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
      projectOptions: [],
      selected: new Set(['t1']),
      onToggleSelect: () => {},
      onToggleSelectAll: () => {},
    }),
  );
  assert.match(html, /全选/);
  assert.match(html, /选择任务/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskTableView.test.tsx
```
Expected: FAIL —— 无 `/全选/`、`/选择任务/`。

- [ ] **Step 3: 实现**

按以下 4 处编辑 `TaskTableView.tsx`：

**3a.** 扩展 props 类型：

```ts
type TaskTableViewProps = {
  tasks: Task[];
  projectOptions: TaskProjectOption[];
  onStart?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onOpenSession?: (task: Task) => void;
  onProjectChange?: (task: Task, nextPath: string) => void;
  onOpenTask?: (task: Task) => void;
  selected?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  onToggleSelectAll?: (taskIds: string[]) => void;
};
```

**3b.** 解构 props + 派生 `hasSelection`：

```ts
export function TaskTableView({
  tasks,
  projectOptions,
  onStart,
  onStatusChange,
  onOpenSession,
  onProjectChange,
  onOpenTask,
  selected,
  onToggleSelect,
  onToggleSelectAll,
}: TaskTableViewProps) {
  const hasSelection = Boolean(onToggleSelect);
```

**3c.** 在 `<thead><tr>` 里 `COLUMNS.map` 之前加全选表头，并把两处 `colSpan={9}` 改为 `colSpan={hasSelection ? 10 : 9}`：

```tsx
          <thead>
            <tr>
              {hasSelection && (
                <th className="px-2 pb-1">
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={tasks.length > 0 && tasks.every((t) => selected?.has(t.task_id))}
                    onChange={() => onToggleSelectAll?.(tasks.map((t) => t.task_id))}
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                </th>
              )}
              {COLUMNS.map((col) => {
```

**3d.** 给 `TaskRow` 传选择 props，并在 `TaskRow` 内渲染行复选框：

- 在 `rows.map` 渲染 `TaskRow` 处追加两个 props：

```tsx
                  {rows.map((task) => (
                    <TaskRow
                      key={task.task_id}
                      task={task}
                      projectOptions={projectOptions}
                      now={now}
                      onStart={onStart}
                      onStatusChange={onStatusChange}
                      onOpenSession={onOpenSession}
                      onProjectChange={onProjectChange}
                      onOpenTask={onOpenTask}
                      selected={selected}
                      onToggleSelect={onToggleSelect}
                    />
                  ))}
```

- 扩展 `TaskRow` 的函数签名 props：

```ts
function TaskRow({
  task,
  projectOptions,
  now,
  onStart,
  onStatusChange,
  onOpenSession,
  onProjectChange,
  onOpenTask,
  selected,
  onToggleSelect,
}: {
  task: Task;
  projectOptions: TaskProjectOption[];
  now: Date;
  onStart?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onOpenSession?: (task: Task) => void;
  onProjectChange?: (task: Task, nextPath: string) => void;
  onOpenTask?: (task: Task) => void;
  selected?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
}) {
```

- 在 `TaskRow` 的 `<tr>` 内第一个 `<td>`（标题列）之前插入复选框 `<td>`：

```tsx
      {onToggleSelect && (
        <td className="bg-card px-4 py-3 shadow-sm" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label="选择任务"
            checked={selected?.has(task.task_id) ?? false}
            onChange={() => onToggleSelect(task.task_id)}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
        </td>
      )}
```

- [ ] **Step 4: 运行测试确认通过**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskTableView.test.tsx
```
Expected: PASS（新增 1 条 + 既有全部通过）。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/tasks/TaskTableView.tsx web/src/components/tasks/TaskTableView.test.tsx
git commit -m "feat(tasks): table view row selection + select-all"
```

---

## Task 9: `TaskCard.tsx` 卡片复选框

**Files:**
- Modify: `web/src/components/tasks/TaskCard.tsx`
- Test: `web/src/components/tasks/TaskCard.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `TaskCard.test.tsx` 顶部 `render` helper 的 props 类型里加两个可选字段，并新增一条测试。

把 `render` helper 的 props 类型：

```ts
function render(
  task: Task,
  props: {
    projectOptions?: TaskProjectOption[];
    onProjectChange?: (nextPath: string) => void;
    onOpenSession?: () => void;
    onStart?: () => void;
    onStatusChange?: (status: Task['status']) => void;
  } = {},
) {
```

改为（新增 `selected`/`onToggleSelect`）：

```ts
function render(
  task: Task,
  props: {
    projectOptions?: TaskProjectOption[];
    onProjectChange?: (nextPath: string) => void;
    onOpenSession?: () => void;
    onStart?: () => void;
    onStatusChange?: (status: Task['status']) => void;
    selected?: boolean;
    onToggleSelect?: (taskId: string) => void;
  } = {},
) {
```

在文件末尾追加：

```tsx
test('card renders a selection checkbox when onToggleSelect is provided', () => {
  const html = render(baseTask, { selected: true, onToggleSelect: () => {} });
  assert.match(html, /type="checkbox"/);
  assert.match(html, /选择任务/);
});

test('card without onToggleSelect renders no checkbox', () => {
  const html = render(baseTask);
  assert.doesNotMatch(html, /type="checkbox"/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskCard.test.tsx
```
Expected: FAIL —— `/type="checkbox"/`、`/选择任务/` 不匹配。

- [ ] **Step 3: 实现**

在 `TaskCard.tsx`：

**3a.** 扩展 props 类型：

```ts
type TaskCardProps = {
  task: Task;
  onStart?: () => void;
  onStatusChange?: (status: TaskStatus) => void;
  onOpenSession?: () => void;
  /** Candidate projects for the todo-card project selector. */
  projectOptions?: TaskProjectOption[];
  /** Called with the newly selected project path (todo tasks only). */
  onProjectChange?: (nextPath: string) => void;
  /** 是否被批量删除选择，配合 onToggleSelect 显示复选框。 */
  selected?: boolean;
  onToggleSelect?: (taskId: string) => void;
};
```

**3b.** 解构 props：

```ts
export const TaskCard = memo(function TaskCard({
  task,
  onStart,
  onStatusChange,
  onOpenSession,
  projectOptions,
  onProjectChange,
  selected,
  onToggleSelect,
}: TaskCardProps) {
```

**3c.** 在标题行 `<span className="min-w-0 flex-1 ...">{task.title}</span>` 之后加复选框：

```tsx
      <div className="flex items-start gap-2">
        <span
          className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: STATUS_META[task.status].color }}
        />
        <span className="min-w-0 flex-1 break-words text-sm font-semibold text-card-foreground">
          {task.title}
        </span>
        {onToggleSelect && (
          <input
            type="checkbox"
            aria-label="选择任务"
            checked={selected ?? false}
            onChange={() => onToggleSelect(task.task_id)}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
          />
        )}
      </div>
```

- [ ] **Step 4: 运行测试确认通过**

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskCard.test.tsx
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/tasks/TaskCard.tsx web/src/components/tasks/TaskCard.test.tsx
git commit -m "feat(tasks): board card selection checkbox"
```

---

## Task 10: `TaskBoard.tsx` 选择状态 + 操作条 + 删除

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 解构 `remove`**

把 `useTasks` 解构：

```ts
  const { tasks, loading, loadError, refresh, upsert } = useTasks({}, subscribe);
```

改为：

```ts
  const { tasks, loading, loadError, refresh, upsert, remove } = useTasks({}, subscribe);
```

- [ ] **Step 2: 加选择状态与剪枝**

在 `const groups = useMemo(() => groupByStatus(filteredTasks), [filteredTasks]);` 之后插入：

```ts
  // 批量删除选择：跨表格/看板两个视图共享同一份 task_id 集合。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (ids: string[]) => {
    setSelected((prev) => {
      if (ids.length > 0 && ids.every((id) => prev.has(id))) return new Set();
      return new Set(ids);
    });
  };

  const clearSelection = () => setSelected(new Set());

  // 已删/已不存在的任务 id 从选择里剪掉，避免幽灵勾选。
  useEffect(() => {
    const ids = new Set(tasks.map((t) => t.task_id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 个任务？此操作不可恢复。`)) return;
    setDeleting(true);
    try {
      const res = await api.tasks.removeMany(ids);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('deleteSelected failed', err?.error?.message ?? res.status);
        return;
      }
      // task_deleted ws 事件会从 useTasks 本地列表移除行；这里兜底本地删 + 清空选择。
      ids.forEach((id) => remove(id));
      clearSelection();
    } catch (err) {
      console.error('deleteSelected failed', err);
    } finally {
      setDeleting(false);
    }
  }
```

- [ ] **Step 3: 渲染操作条 + 给两个视图传 props**

把：

```tsx
        <div className="flex min-h-0 flex-1 flex-col">
          <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} />
          {effectiveView === 'table' ? (
```

改为：

```tsx
        <div className="flex min-h-0 flex-1 flex-col">
          <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} />
          {selected.size > 0 && (
            <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 sm:px-4">
              <span className="text-sm font-medium">已选 {selected.size} 项</span>
              <button
                type="button"
                onClick={clearSelection}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                取消选择
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void deleteSelected()}
                className="ml-auto rounded-lg bg-red-500/10 px-3 py-1.5 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400"
              >
                {deleting ? '删除中…' : '删除'}
              </button>
            </div>
          )}
          {effectiveView === 'table' ? (
```

给 `TaskTableView` 追加三个 props（在 `onOpenTask` 之后）：

```tsx
            <TaskTableView
              tasks={filteredTasks}
              projectOptions={projectOptions}
              onStart={runTask}
              onStatusChange={(task, status) => updateStatus(task, status)}
              onOpenSession={(task) => task.session_id && navigate(`/session/${task.session_id}`)}
              onProjectChange={(task, nextPath) => changeProject(task, nextPath)}
              onOpenTask={(task) => navigate(`/task/${task.task_id}`)}
              selected={selected}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
            />
```

给看板 `TaskCard` 追加两个 props（在 `onProjectChange` 之后）：

```tsx
                      <TaskCard
                        key={task.task_id}
                        task={task}
                        onStart={() => runTask(task)}
                        onStatusChange={(s) => updateStatus(task, s)}
                        onOpenSession={() => task.session_id && navigate(`/session/${task.session_id}`)}
                        projectOptions={projectOptions}
                        onProjectChange={(nextPath) => changeProject(task, nextPath)}
                        selected={selected.has(task.task_id)}
                        onToggleSelect={toggleSelect}
                      />
```

- [ ] **Step 4: 类型检查 + 全量前端测试**

Run（cwd=`web/`）:
```bash
npm run typecheck
```
Expected: 无错误。

Run（cwd=`web/`）:
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/tasks/taskFilter.test.ts \
  src/components/tasks/ProjectMultiSelect.test.tsx \
  src/components/tasks/TaskFilterBar.test.tsx \
  src/components/tasks/TaskTableView.test.tsx \
  src/components/tasks/TaskCard.test.tsx
```
Expected: PASS（全部通过）。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): batch delete selection + action bar"
```

---

## 最终验证

- [ ] 后端全量回归：

Run（cwd=`backend/`）:
```bash
node --test --import tsx server/modules/tasks/tests/tasks.service.test.ts server/modules/tasks/tests/tasks.routes.test.ts
```
Expected: PASS。

- [ ] 后端类型检查：

Run（cwd=`backend/`）:
```bash
npm run typecheck
```
Expected: 无错误。

- [ ] 前端类型检查：

Run（cwd=`web/`）:
```bash
npm run typecheck
```
Expected: 无错误。

- [ ] 前端构建：

Run（cwd=`web/`）:
```bash
npm run build
```
Expected: 构建成功。

- [ ] 手测清单（见设计文档 §6）：
  1. 项目多选：勾选多个项目 → 表格/看板同时显示；勾选助手 → 叠加助手任务；取消全部 → 显示全部。
  2. 老 localStorage `{ projectPath: '/a', assistantOnly: true }` → 刷新后正确迁移生效。
  3. 表格勾选行 → 顶部「已选 N 项」→ 删除确认 → 行消失、选择清空；全选/取消全选。
  4. 看板卡片勾选 → 批量删除；跨视图切换选择一致。
  5. 删除中按钮禁用；删除失败给出错误且选择保留。
