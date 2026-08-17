# Task 页筛选 + 表格视图 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 lovdex-cli 的 Task 页面新增项目/日期筛选、表格视图（看板/表格可切换）、并美化返回导航按钮。

**Architecture:** 纯前端方案。`useTasks` 继续拉全量任务，新增纯函数 `filterTasks`（taskFilter.ts）做项目/助手/日期过滤，看板与表格共用过滤结果；新增 `sortTasks`（taskTable.ts）做组内排序；`TaskBoard.tsx` 持有 filter state + 视图模式（localStorage 持久化），按模式渲染看板或 `TaskTableView`。返回按钮抽成 `TaskBackNav` 组件。

**Tech Stack:** React 18 + TypeScript + Tailwind（shadcn 风格 HSL 变量）、`lucide-react`、`node:test` + `tsx` 跑测试。

**设计文档：** `docs/superpowers/specs/2026-08-12-task-filter-table-design.md`

---

## 测试命令

所有测试用（工作目录 `lovdex-cli`，必须先 `unset TSX_TSCONFIG_PATH` 或用 `TSX_TSCONFIG_PATH=` 前缀）：

```bash
TSX_TSCONFIG_PATH= node --import tsx --test <文件>
```

单文件：`TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/taskFilter.test.ts`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/components/tasks/taskFilter.ts` (新增) | 过滤纯函数：`EMPTY_TASK_FILTER`、`resolveDateRange`、`filterTasks` |
| `src/components/tasks/taskFilter.test.ts` (新增) | 过滤单测 |
| `src/components/tasks/taskTable.ts` (新增) | `sortTasks` 组内排序纯函数 |
| `src/components/tasks/taskTable.test.ts` (新增) | 排序单测 |
| `src/components/tasks/TaskBackNav.tsx` (新增) | 返回导航按钮（outline 样式） |
| `src/components/tasks/TaskFilterBar.tsx` (新增) | 筛选栏 UI |
| `src/components/tasks/TaskFilterBar.test.tsx` (新增) | 筛选栏 smoke 测试 |
| `src/components/tasks/TaskTableView.tsx` (新增) | 表格视图（B3+ B 视觉） |
| `src/components/tasks/TaskTableView.test.tsx` (新增) | 表格 smoke 测试 |
| `src/components/tasks/TaskBoard.tsx` (修改) | 持有 filter/viewMode state，渲染筛选栏 + 看板/表格 |
| `src/components/tasks/TaskDetail.tsx` (修改) | 头部导航换成 `TaskBackNav` |
| `src/components/operators/OperatorSettingsPage.tsx` (修改) | 头部返回按钮换成 `BackToTasksButton`，移除不再用的 `useNavigate` |

---

## Task 1: taskFilter.ts（过滤纯函数 + 单测）

**Files:**
- Create: `src/components/tasks/taskFilter.ts`
- Test: `src/components/tasks/taskFilter.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/components/tasks/taskFilter.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import {
  EMPTY_TASK_FILTER,
  type TaskFilter,
  filterTasks,
  resolveDateRange,
} from './taskFilter';

const mkTask = (over: Partial<Task> & { task_id: string }): Task => ({
  project_path: '/home/user/proj',
  title: '测试任务',
  description: null,
  status: 'todo',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: null,
  started_at: null,
  completed_at: null,
  ai_summary: null,
  sub_status: null,
  verdict_reason: null,
  verdict_at: null,
  priority: 'P2',
  deadline: null,
  is_operator: 0,
  label: 'other',
  remark: null,
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
  ...over,
});

const NOW = new Date(2026, 7, 12, 15, 30); // 2026-08-12 15:30 本地时间

const filterOf = (patch: Partial<TaskFilter>): TaskFilter => ({ ...EMPTY_TASK_FILTER, ...patch });

test('resolveDateRange: preset all with no custom returns null', () => {
  assert.equal(resolveDateRange(filterOf({ preset: 'all' }), NOW), null);
});

test('resolveDateRange: today spans local midnight to end of day and covers now', () => {
  const range = resolveDateRange(filterOf({ preset: 'today' }), NOW)!;
  const from = new Date(range.from);
  const to = new Date(range.to);
  assert.equal(from.getHours(), 0);
  assert.equal(from.getMinutes(), 0);
  assert.equal(to.getHours(), 23);
  assert.equal(to.getMinutes(), 59);
  assert.ok(NOW.getTime() >= range.from && NOW.getTime() <= range.to);
});

test('resolveDateRange: week starts Monday local midnight', () => {
  const range = resolveDateRange(filterOf({ preset: 'week' }), NOW)!;
  const from = new Date(range.from);
  assert.equal(from.getDay(), 1); // Monday
  assert.equal(from.getHours(), 0);
  assert.ok(NOW.getTime() >= range.from && NOW.getTime() <= range.to);
});

test('resolveDateRange: month starts on the 1st', () => {
  const range = resolveDateRange(filterOf({ preset: 'month' }), NOW)!;
  const from = new Date(range.from);
  assert.equal(from.getDate(), 1);
  assert.equal(from.getHours(), 0);
  assert.ok(NOW.getTime() <= range.to);
});

test('resolveDateRange: year starts Jan 1', () => {
  const range = resolveDateRange(filterOf({ preset: 'year' }), NOW)!;
  const from = new Date(range.from);
  assert.equal(from.getMonth(), 0);
  assert.equal(from.getDate(), 1);
});

test('resolveDateRange: custom both sides is a closed local-day range', () => {
  const range = resolveDateRange(filterOf({ customFrom: '2026-08-01', customTo: '2026-08-12' }), NOW)!;
  assert.equal(new Date(range.from).getDate(), 1);
  assert.equal(new Date(range.to).getHours(), 23);
  assert.ok(range.from <= NOW.getTime() && NOW.getTime() <= range.to);
});

test('resolveDateRange: from only has no upper bound', () => {
  const range = resolveDateRange(filterOf({ customFrom: '2026-08-12' }), NOW)!;
  assert.equal(new Date(range.from).getDate(), 12);
  assert.equal(range.to, Number.POSITIVE_INFINITY);
});

test('resolveDateRange: to only has no lower bound', () => {
  const range = resolveDateRange(filterOf({ customTo: '2026-08-01' }), NOW)!;
  assert.equal(new Date(range.to).getDate(), 1);
  assert.equal(range.from, Number.NEGATIVE_INFINITY);
});

test('filterTasks: project path exact match', () => {
  const a = mkTask({ task_id: 'a', project_path: '/p1' });
  const b = mkTask({ task_id: 'b', project_path: '/p2' });
  const out = filterTasks([a, b], filterOf({ projectPath: '/p1' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: assistant option keeps operator tasks', () => {
  const a = mkTask({ task_id: 'a', is_operator: 1 });
  const b = mkTask({ task_id: 'b', is_operator: 0 });
  const out = filterTasks([a, b], filterOf({ projectPath: ASSISTANT_OPTION_VALUE }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: assistantOnly keeps only operator tasks', () => {
  const a = mkTask({ task_id: 'a', is_operator: 1 });
  const b = mkTask({ task_id: 'b', is_operator: 0 });
  const out = filterTasks([a, b], filterOf({ assistantOnly: true }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: created date range filters by created_at', () => {
  const inRange = mkTask({ task_id: 'a', created_at: '2026-08-12T02:00:00.000Z' });
  const outRange = mkTask({ task_id: 'b', created_at: '2026-07-01T02:00:00.000Z' });
  const out = filterTasks([inRange, outRange], filterOf({ preset: 'today' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: deadline date range excludes tasks without deadline', () => {
  const withDeadline = mkTask({ task_id: 'a', deadline: '2026-08-15' });
  const noDeadline = mkTask({ task_id: 'b', deadline: null });
  const out = filterTasks(
    [withDeadline, noDeadline],
    filterOf({ dateField: 'deadline', customFrom: '2026-08-14', customTo: '2026-08-16' }),
    NOW,
  );
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: activity uses updated_at', () => {
  const active = mkTask({ task_id: 'a', updated_at: '2026-08-12T02:00:00.000Z' });
  const stale = mkTask({ task_id: 'b', updated_at: '2026-07-01T02:00:00.000Z' });
  const out = filterTasks([active, stale], filterOf({ dateField: 'activity', preset: 'today' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: invalid timestamp is excluded by an active date filter', () => {
  const bad = mkTask({ task_id: 'a', created_at: 'not-a-date' });
  const good = mkTask({ task_id: 'b', created_at: '2026-08-12T02:00:00.000Z' });
  const out = filterTasks([bad, good], filterOf({ preset: 'today' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['b']);
});

test('filterTasks: no date filter keeps tasks regardless of timestamps', () => {
  const bad = mkTask({ task_id: 'a', created_at: 'not-a-date' });
  const out = filterTasks([bad], filterOf({ preset: 'all' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/taskFilter.test.ts`
Expected: FAIL — `Cannot find module './taskFilter'`

- [ ] **Step 3: 实现 taskFilter.ts**

创建 `src/components/tasks/taskFilter.ts`：

```ts
import type { Task } from '../../types/app';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';

export type TaskDateField = 'created' | 'deadline' | 'activity';
export type TaskFilterPreset = 'all' | 'today' | 'week' | 'month' | 'year';

export type TaskFilter = {
  projectPath: string;
  assistantOnly: boolean;
  dateField: TaskDateField;
  preset: TaskFilterPreset;
  customFrom: string;
  customTo: string;
};

export const EMPTY_TASK_FILTER: TaskFilter = {
  projectPath: '',
  assistantOnly: false,
  dateField: 'created',
  preset: 'all',
  customFrom: '',
  customTo: '',
};

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

/** 按 项目 → 助手开关 → 日期 三个维度（AND）过滤任务。 */
export function filterTasks(tasks: Task[], filter: TaskFilter, now: Date): Task[] {
  const range = resolveDateRange(filter, now);
  return tasks.filter((task) => {
    if (filter.projectPath === ASSISTANT_OPTION_VALUE) {
      if (task.is_operator !== 1) return false;
    } else if (filter.projectPath) {
      if (task.project_path !== filter.projectPath) return false;
    }
    if (filter.assistantOnly && task.is_operator !== 1) return false;
    if (range) {
      const value = taskDateValue(task, filter.dateField);
      if (value === null) return false;
      if (value < range.from || value > range.to) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/taskFilter.test.ts`
Expected: PASS — `# tests 17` `# pass 17`

- [ ] **Step 5: 类型检查**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 无报错

- [ ] **Step 6: Commit**

```bash
git add src/components/tasks/taskFilter.ts src/components/tasks/taskFilter.test.ts
git commit -m "feat(tasks): add pure task filter functions (project/assistant/date)"
```

---

## Task 2: taskTable.ts（组内排序纯函数 + 单测）

**Files:**
- Create: `src/components/tasks/taskTable.ts`
- Test: `src/components/tasks/taskTable.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/components/tasks/taskTable.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { sortTasks } from './taskTable';

const mkTask = (over: Partial<Task> & { task_id: string }): Task => ({
  project_path: '/home/user/proj',
  title: '测试任务',
  description: null,
  status: 'todo',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: null,
  started_at: null,
  completed_at: null,
  ai_summary: null,
  sub_status: null,
  verdict_reason: null,
  verdict_at: null,
  priority: 'P2',
  deadline: null,
  is_operator: 0,
  label: 'other',
  remark: null,
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
  ...over,
});

test('sortTasks: created desc orders newest first', () => {
  const old = mkTask({ task_id: 'a', created_at: '2026-08-01T00:00:00.000Z' });
  const recent = mkTask({ task_id: 'b', created_at: '2026-08-12T00:00:00.000Z' });
  const out = sortTasks([old, recent], 'created', 'desc');
  assert.deepEqual(out.map((t) => t.task_id), ['b', 'a']);
});

test('sortTasks: title asc uses localeCompare', () => {
  const a = mkTask({ task_id: 'a', title: 'apple' });
  const b = mkTask({ task_id: 'b', title: 'banana' });
  const out = sortTasks([b, a], 'title', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('sortTasks: status follows STATUS_ORDER (todo before done)', () => {
  const done = mkTask({ task_id: 'a', status: 'done' });
  const todo = mkTask({ task_id: 'b', status: 'todo' });
  const out = sortTasks([done, todo], 'status', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['b', 'a']);
});

test('sortTasks: priority follows PRIORITY_ORDER (P0 before P2)', () => {
  const p2 = mkTask({ task_id: 'a', priority: 'P2' });
  const p0 = mkTask({ task_id: 'b', priority: 'P0' });
  const out = sortTasks([p2, p0], 'priority', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['b', 'a']);
});

test('sortTasks: deadline asc puts no-deadline first then by date', () => {
  const noDeadline = mkTask({ task_id: 'a', deadline: null });
  const later = mkTask({ task_id: 'b', deadline: '2026-08-20' });
  const earlier = mkTask({ task_id: 'c', deadline: '2026-08-10' });
  const out = sortTasks([later, noDeadline, earlier], 'deadline', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'c', 'b']);
});

test('sortTasks: does not mutate the input array', () => {
  const a = mkTask({ task_id: 'a', created_at: '2026-08-01T00:00:00.000Z' });
  const b = mkTask({ task_id: 'b', created_at: '2026-08-12T00:00:00.000Z' });
  const input = [a, b];
  sortTasks(input, 'created', 'desc');
  assert.deepEqual(input.map((t) => t.task_id), ['a', 'b']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/taskTable.test.ts`
Expected: FAIL — `Cannot find module './taskTable'`

- [ ] **Step 3: 实现 taskTable.ts**

创建 `src/components/tasks/taskTable.ts`：

```ts
import type { Task } from '../../types/app';

import { PRIORITY_ORDER, STATUS_ORDER } from './taskStatus';

export type TaskSortKey =
  | 'title'
  | 'project'
  | 'status'
  | 'priority'
  | 'deadline'
  | 'created'
  | 'activity';

export type TaskSortDir = 'asc' | 'desc';

function sortValue(task: Task, key: TaskSortKey): string | number {
  switch (key) {
    case 'title':
      return task.title;
    case 'project':
      return task.project_path;
    case 'status':
      return STATUS_ORDER.indexOf(task.status);
    case 'priority':
      return PRIORITY_ORDER.indexOf(task.priority ?? 'P2');
    case 'deadline':
      return task.deadline ?? '';
    case 'created':
      return Date.parse(task.created_at) || 0;
    case 'activity':
      return Date.parse(task.updated_at) || 0;
  }
}

/** 组内排序：按 key 升/降序，等值回退到「创建时间 desc」再按 task_id 保证稳定。不修改入参。 */
export function sortTasks(tasks: Task[], key: TaskSortKey, dir: TaskSortDir): Task[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    return tb - ta || a.task_id.localeCompare(b.task_id);
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/taskTable.test.ts`
Expected: PASS — `# tests 6` `# pass 6`

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/taskTable.ts src/components/tasks/taskTable.test.ts
git commit -m "feat(tasks): add in-group sortTasks pure function"
```

---

## Task 3: TaskBackNav.tsx（返回导航按钮）

**Files:**
- Create: `src/components/tasks/TaskBackNav.tsx`

- [ ] **Step 1: 实现组件**

创建 `src/components/tasks/TaskBackNav.tsx`：

```tsx
import { ArrowLeft, Home } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { cn } from '../../lib/utils';
import { Button } from '../../shared/view/ui';

/** 「← 返回任务面板」outline 按钮，供 OperatorSettingsPage 头部复用。 */
export function BackToTasksButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('gap-1.5', className)}
      onClick={() => navigate('/tasks')}
    >
      <ArrowLeft className="h-4 w-4" />
      返回任务面板
    </Button>
  );
}

/** 「返回主页」outline 按钮。 */
export function HomeButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('gap-1.5', className)}
      onClick={() => navigate('/')}
    >
      <Home className="h-4 w-4" />
      返回主页
    </Button>
  );
}

/** TaskDetail 头部右侧的两个返回按钮。 */
export function TaskBackNav({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <BackToTasksButton />
      <HomeButton />
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 无报错（此时组件未引用，仅编译）

- [ ] **Step 3: Commit**

```bash
git add src/components/tasks/TaskBackNav.tsx
git commit -m "feat(tasks): add outline back-nav buttons (tasks/home)"
```

---

## Task 4: TaskFilterBar.tsx（筛选栏 + smoke 测试）

**Files:**
- Create: `src/components/tasks/TaskFilterBar.tsx`
- Test: `src/components/tasks/TaskFilterBar.test.tsx`

- [ ] **Step 1: 写失败 smoke 测试**

创建 `src/components/tasks/TaskFilterBar.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { EMPTY_TASK_FILTER } from './taskFilter';
import { TaskFilterBar } from './TaskFilterBar';

test('filter bar renders default options', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: EMPTY_TASK_FILTER,
      onChange: () => {},
    }),
  );
  assert.match(html, /全部项目/);
  assert.match(html, /Lovdex助手/);
  assert.match(html, /创建时间/);
  assert.match(html, /最近活动/);
  assert.doesNotMatch(html, /清除筛选/);
});

test('filter bar renders assistant option value and shows clear when active', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [],
      filter: { ...EMPTY_TASK_FILTER, assistantOnly: true },
      onChange: () => {},
    }),
  );
  assert.match(html, new RegExp(ASSISTANT_OPTION_VALUE));
  assert.match(html, /清除筛选/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/TaskFilterBar.test.tsx`
Expected: FAIL — `Cannot find module './TaskFilterBar'`

- [ ] **Step 3: 实现 TaskFilterBar.tsx**

创建 `src/components/tasks/TaskFilterBar.tsx`：

```tsx
import { Pill, PillBar } from '../../shared/view/ui';

import type { TaskProjectOption } from './TaskCard';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
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

/**
 * Task 页筛选栏：项目下拉 + 只看助手开关 + 日期字段切换 + 快捷项 + 自定义范围。
 * 项目单选与助手开关互斥：选具体项目关闭助手；开助手则项目重置为全部。
 */
export function TaskFilterBar({ projectOptions, filter, onChange }: TaskFilterBarProps) {
  const hasFilter =
    filter.projectPath !== '' ||
    filter.assistantOnly ||
    filter.preset !== 'all' ||
    filter.customFrom !== '' ||
    filter.customTo !== '';

  const selectProject = (value: string) => {
    onChange({ ...filter, projectPath: value, assistantOnly: false });
  };

  const toggleAssistant = () => {
    onChange(
      filter.assistantOnly
        ? { ...filter, assistantOnly: false }
        : { ...filter, projectPath: '', assistantOnly: true },
    );
  };

  const pickPreset = (preset: TaskFilterPreset) => {
    onChange({ ...filter, preset, customFrom: '', customTo: '' });
  };

  const presetActive = (preset: TaskFilterPreset) =>
    filter.preset === preset && filter.customFrom === '' && filter.customTo === '';

  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-2 sm:px-4">
      {/* 项目下拉 */}
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1">
        <span className="text-xs text-muted-foreground">项目</span>
        <select
          className="bg-transparent text-xs text-foreground outline-none"
          value={filter.projectPath}
          onChange={(e) => selectProject(e.target.value)}
        >
          <option value="">全部项目</option>
          <option value={ASSISTANT_OPTION_VALUE}>🤖 Lovdex助手</option>
          {projectOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* 只看助手 */}
      <button
        type="button"
        aria-pressed={filter.assistantOnly}
        onClick={toggleAssistant}
        className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
          filter.assistantOnly
            ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
            : 'bg-muted/50 text-muted-foreground hover:text-foreground'
        }`}
      >
        🤖 只看助手
      </button>

      {/* 日期字段 */}
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

      {/* 快捷项 */}
      <PillBar>
        {PRESET_OPTIONS.map((o) => (
          <Pill key={o.value} isActive={presetActive(o.value)} onClick={() => pickPreset(o.value)}>
            {o.label}
          </Pill>
        ))}
      </PillBar>

      {/* 自定义范围 */}
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1">
        <span className="text-xs text-muted-foreground">从</span>
        <input
          type="date"
          className="bg-transparent text-xs text-foreground outline-none"
          value={filter.customFrom}
          onChange={(e) => onChange({ ...filter, preset: 'all', customFrom: e.target.value })}
        />
        <span className="text-xs text-muted-foreground">至</span>
        <input
          type="date"
          className="bg-transparent text-xs text-foreground outline-none"
          value={filter.customTo}
          onChange={(e) => onChange({ ...filter, preset: 'all', customTo: e.target.value })}
        />
      </div>

      {/* 清除筛选 */}
      {hasFilter && (
        <button
          type="button"
          className="rounded-md px-2 py-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => onChange(EMPTY_TASK_FILTER)}
        >
          清除筛选
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/TaskFilterBar.test.tsx`
Expected: PASS — `# tests 2` `# pass 2`

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/TaskFilterBar.tsx src/components/tasks/TaskFilterBar.test.tsx
git commit -m "feat(tasks): add task filter bar (project/assistant/date/preset/range)"
```

---

## Task 5: TaskTableView.tsx（表格视图 + smoke 测试）

**Files:**
- Create: `src/components/tasks/TaskTableView.tsx`
- Test: `src/components/tasks/TaskTableView.test.tsx`

- [ ] **Step 1: 写失败 smoke 测试**

创建 `src/components/tasks/TaskTableView.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Task } from '../../types/app';

import { TaskTableView } from './TaskTableView';

const mkTask = (over: Partial<Task> & { task_id: string }): Task => ({
  project_path: '/home/user/proj',
  title: '测试任务',
  description: null,
  status: 'todo',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: null,
  started_at: null,
  completed_at: null,
  ai_summary: null,
  sub_status: null,
  verdict_reason: null,
  verdict_at: null,
  priority: 'P2',
  deadline: null,
  is_operator: 0,
  label: 'other',
  remark: null,
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
  ...over,
});

test('table renders status group header and task title', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
      projectOptions: [],
    }),
  );
  assert.match(html, /待办/);
  assert.match(html, /表格任务/);
  assert.match(html, /创建时间/);
  assert.match(html, /操作/);
});

test('table shows empty state when no tasks', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, { tasks: [], projectOptions: [] }),
  );
  assert.match(html, /暂无任务/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/TaskTableView.test.tsx`
Expected: FAIL — `Cannot find module './TaskTableView'`

- [ ] **Step 3: 实现 TaskTableView.tsx**

创建 `src/components/tasks/TaskTableView.tsx`：

```tsx
import { Fragment, useMemo, useState, type ReactNode } from 'react';

import type { Task, TaskStatus } from '../../types/app';

import type { TaskProjectOption } from './TaskCard';
import { SubStatusBadge } from './SubStatusBadge';
import { sortTasks, type TaskSortDir, type TaskSortKey } from './taskTable';
import { groupByStatus, LABEL_META, PRIORITY_META, STATUS_META, STATUS_ORDER } from './taskStatus';
import { taskDeadlineInfo } from './taskDeadline';
import { formatAbsoluteTime } from './taskTimestamp';

/** 列定义：`key` 存在即可排序；`static` 列（子状态/操作）无排序。 */
const COLUMNS: { key?: TaskSortKey; label: string; alignRight?: boolean }[] = [
  { key: 'title', label: '标题' },
  { key: 'project', label: '项目' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
  { label: '子状态' },
  { key: 'deadline', label: '截止日期' },
  { key: 'created', label: '创建时间' },
  { key: 'activity', label: '最近活动' },
  { label: '操作', alignRight: true },
];

type TaskTableViewProps = {
  tasks: Task[];
  projectOptions: TaskProjectOption[];
  onStart?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onOpenSession?: (task: Task) => void;
  onProjectChange?: (task: Task, nextPath: string) => void;
  onOpenTask?: (task: Task) => void;
};

function ActionBtn({
  className,
  onClick,
  children,
}: {
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold transition-opacity hover:opacity-80 ${
        className ?? ''
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 任务表格视图（B3+ B 视觉）：按状态分组 + 卡片行 + 左色条 + 组内排序 + 行内操作。
 * 仅渲染非空分组；空列表显示「暂无任务」。
 */
export function TaskTableView({
  tasks,
  projectOptions,
  onStart,
  onStatusChange,
  onOpenSession,
  onProjectChange,
  onOpenTask,
}: TaskTableViewProps) {
  const [sortKey, setSortKey] = useState<TaskSortKey>('created');
  const [sortDir, setSortDir] = useState<TaskSortDir>('desc');
  const groups = useMemo(() => groupByStatus(tasks), [tasks]);
  const now = new Date();

  const toggleSort = (key: TaskSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'created' || key === 'activity' ? 'desc' : 'asc');
    }
  };

  const sorted = (status: TaskStatus) => sortTasks(groups[status], sortKey, sortDir);

  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="py-16 text-center text-sm text-muted-foreground">暂无任务</div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4">
      <table
        className="w-full min-w-[1080px] border-separate text-sm"
        style={{ borderSpacing: '0 7px' }}
      >
        <thead>
          <tr>
            {COLUMNS.map((col) => {
              const sortable = col.key !== undefined;
              return (
                <th
                  key={col.label}
                  onClick={sortable ? () => toggleSort(col.key as TaskSortKey) : undefined}
                  className={`whitespace-nowrap px-4 pb-1 text-xs font-semibold text-muted-foreground ${
                    col.alignRight ? 'text-right' : 'text-left'
                  } ${sortable ? 'cursor-pointer select-none hover:text-foreground' : ''}`}
                >
                  {col.label}
                  {sortable && sortKey === col.key && (
                    <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {STATUS_ORDER.map((status) => {
            const rows = sorted(status);
            if (rows.length === 0) return null;
            return (
              <Fragment key={status}>
                <tr>
                  <td colSpan={9} className="px-2 pb-1">
                    <div className="flex items-center gap-2 px-2 text-sm font-semibold">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: STATUS_META[status].color }}
                      />
                      {STATUS_META[status].label}
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {rows.length}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  </td>
                </tr>
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
                  />
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TaskRow({
  task,
  projectOptions,
  now,
  onStart,
  onStatusChange,
  onOpenSession,
  onProjectChange,
  onOpenTask,
}: {
  task: Task;
  projectOptions: TaskProjectOption[];
  now: Date;
  onStart?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onOpenSession?: (task: Task) => void;
  onProjectChange?: (task: Task, nextPath: string) => void;
  onOpenTask?: (task: Task) => void;
}) {
  const isClaude = task.executor_provider === 'claude';
  const priority = task.priority ?? 'P2';
  const label = task.label ?? 'other';
  const deadlineInfo = taskDeadlineInfo(task, now);
  const overdue = deadlineInfo?.overdue ?? false;
  const statusColor = STATUS_META[task.status].color;

  const canOpenSession =
    task.session_id &&
    (task.status === 'in_progress' ||
      task.status === 'in_review' ||
      ['only_plan', 'needs_review', 'blocked'].includes(task.sub_status ?? ''));

  return (
    <tr
      className="cursor-pointer transition-transform hover:-translate-y-px"
      onClick={() => onOpenTask?.(task)}
    >
      {/* 标题 + 副行（Label + 引擎·模型） */}
      <td
        className="rounded-l-lg bg-card px-4 py-3 shadow-sm"
        style={{ borderLeft: `3px solid ${statusColor}` }}
      >
        <div className="font-semibold text-card-foreground">{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {LABEL_META[label] && (
            <span
              className="rounded-full px-2 py-0.5 font-semibold"
              style={{ color: LABEL_META[label].color, backgroundColor: `${LABEL_META[label].color}1a` }}
            >
              {LABEL_META[label].label}
            </span>
          )}
          <span
            className={`font-semibold ${
              isClaude
                ? 'text-green-600 dark:text-green-400'
                : task.executor_provider === 'sophcode'
                  ? 'text-violet-600 dark:text-violet-400'
                  : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {isClaude ? '◈ Claude' : task.executor_provider === 'sophcode' ? '◈ SophCode' : '◈ Codex'}
          </span>
          {task.executor_model && <span className="font-mono">{task.executor_model}</span>}
        </div>
      </td>

      {/* 项目 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 text-xs shadow-sm">
        {task.status === 'todo' && task.is_operator !== 1 && projectOptions.length > 0 ? (
          <select
            value={task.project_path}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              onProjectChange?.(task, e.target.value);
            }}
            title="修改项目"
            className="max-w-40 cursor-pointer truncate rounded-full border border-border/50 bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground outline-none"
          >
            {!projectOptions.some((o) => o.value === task.project_path) && (
              <option value={task.project_path} disabled>
                {task.project_path}
              </option>
            )}
            {projectOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span
            className={
              task.is_operator === 1
                ? 'font-medium text-violet-600 dark:text-violet-400'
                : 'text-muted-foreground'
            }
          >
            {task.is_operator === 1 ? '🤖 Lovdex助手' : task.project_path}
          </span>
        )}
      </td>

      {/* 状态 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 text-xs font-medium shadow-sm">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: statusColor }} />
          {STATUS_META[task.status].label}
        </span>
      </td>

      {/* 优先级 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 shadow-sm">
        {PRIORITY_META[priority] && (
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ color: PRIORITY_META[priority].color, backgroundColor: `${PRIORITY_META[priority].color}1a` }}
          >
            {PRIORITY_META[priority].label}
          </span>
        )}
      </td>

      {/* 子状态 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 shadow-sm">
        {task.sub_status ? (
          <SubStatusBadge subStatus={task.sub_status} />
        ) : (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </td>

      {/* 截止日期 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 text-xs shadow-sm">
        {task.deadline ? (
          <span className={overdue ? 'font-semibold text-red-500' : 'text-muted-foreground'}>
            {task.deadline}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </td>

      {/* 创建时间 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 font-mono text-[11px] text-muted-foreground shadow-sm">
        {formatAbsoluteTime(task.created_at)}
      </td>

      {/* 最近活动 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 font-mono text-[11px] text-muted-foreground shadow-sm">
        {formatAbsoluteTime(task.updated_at)}
      </td>

      {/* 操作 */}
      <td className="whitespace-nowrap rounded-r-lg bg-card px-4 py-3 text-right shadow-sm">
        <div className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {task.status === 'todo' && onStart && (
            <ActionBtn onClick={() => onStart(task)} className="bg-primary/10 text-primary">
              ▶ 开始执行
            </ActionBtn>
          )}
          {task.sub_status === 'failed' && onStart && (
            <ActionBtn onClick={() => onStart(task)} className="bg-primary/10 text-primary">
              ↻ 重试
            </ActionBtn>
          )}
          {task.status === 'in_review' && (
            <>
              <ActionBtn
                onClick={() => onStatusChange?.(task, 'done')}
                className="bg-green-500/10 text-green-600 dark:text-green-400"
              >
                ✓ 标记完成
              </ActionBtn>
              {task.session_id && onOpenSession && (
                <ActionBtn onClick={() => onOpenSession(task)} className="bg-muted text-muted-foreground">
                  打开会话
                </ActionBtn>
              )}
            </>
          )}
          {task.status === 'in_progress' && canOpenSession && onOpenSession && (
            <ActionBtn onClick={() => onOpenSession(task)} className="bg-muted text-muted-foreground">
              打开会话
            </ActionBtn>
          )}
        </div>
      </td>
    </tr>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/TaskTableView.test.tsx`
Expected: PASS — `# tests 2` `# pass 2`

- [ ] **Step 5: 类型检查**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 无报错

- [ ] **Step 6: Commit**

```bash
git add src/components/tasks/TaskTableView.tsx src/components/tasks/TaskTableView.test.tsx
git commit -m "feat(tasks): add card-style table view with group headers and sorting"
```

---

## Task 6: TaskBoard.tsx（接入筛选 + 视图切换）

**Files:**
- Modify: `src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 增加 import**

在 `src/components/tasks/TaskBoard.tsx` 顶部，现有 `import { Button, Dialog, ... } from '../../shared/view/ui';` 之后加入：

```tsx
import { LayoutGrid, Table } from 'lucide-react';

import useLocalStorage from '../../hooks/useLocalStorage';
import { cn } from '../../lib/utils';
import { TaskFilterBar } from './TaskFilterBar';
import { TaskTableView } from './TaskTableView';
import { EMPTY_TASK_FILTER, filterTasks, type TaskFilter } from './taskFilter';
```

- [ ] **Step 2: 增加 filter / viewMode state**

把组件内（`const { tasks, loading, loadError, refresh, upsert } = useTasks({}, subscribe);` 之后）：

```tsx
const groups = useMemo(() => groupByStatus(tasks), [tasks]);
```

替换为：

```tsx
const [filter, setFilter] = useState<TaskFilter>(EMPTY_TASK_FILTER);
const [viewMode, setViewMode] = useLocalStorage<'board' | 'table'>('taskViewMode', 'board');
const filteredTasks = useMemo(() => filterTasks(tasks, filter, new Date()), [tasks, filter]);
const groups = useMemo(() => groupByStatus(filteredTasks), [filteredTasks]);
```

- [ ] **Step 3: header 加视图切换**

把 header 里：

```tsx
<ViewSwitcher active="tasks" className="w-40 flex-shrink-0 sm:w-44" />
<div className="ml-auto">
```

替换为：

```tsx
<ViewSwitcher active="tasks" className="w-40 flex-shrink-0 sm:w-44" />
<div className="flex rounded-lg bg-muted/50 p-0.5">
  <button
    type="button"
    aria-pressed={viewMode === 'board'}
    onClick={() => setViewMode('board')}
    className={cn(
      'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all',
      viewMode === 'board'
        ? 'bg-background text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground',
    )}
  >
    <LayoutGrid className="h-3 w-3" />
    看板
  </button>
  <button
    type="button"
    aria-pressed={viewMode === 'table'}
    onClick={() => setViewMode('table')}
    className={cn(
      'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all',
      viewMode === 'table'
        ? 'bg-background text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground',
    )}
  >
    <Table className="h-3 w-3" />
    表格
  </button>
</div>
<div className="ml-auto">
```

- [ ] **Step 4: body 渲染筛选栏 + 条件渲染**

把 `loading ? ... : loadError ? ... : (` 后面的看板容器：

```tsx
<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3 sm:flex-row sm:gap-3 sm:overflow-x-auto sm:overflow-y-hidden sm:px-4 sm:pb-4">
  {STATUS_ORDER.map((status) => (
    ...
  ))}
</div>
```

替换为（保留原有 `STATUS_ORDER.map(...)` 内容不动，仅在外面套一层）：

```tsx
<div className="flex min-h-0 flex-1 flex-col">
  <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} />
  {viewMode === 'table' ? (
    <TaskTableView
      tasks={filteredTasks}
      projectOptions={projectOptions}
      onStart={runTask}
      onStatusChange={(task, status) => updateStatus(task, status)}
      onOpenSession={(task) => task.session_id && navigate(`/session/${task.session_id}`)}
      onProjectChange={(task, nextPath) => changeProject(task, nextPath)}
      onOpenTask={(task) => navigate(`/task/${task.task_id}`)}
    />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3 sm:flex-row sm:gap-3 sm:overflow-x-auto sm:overflow-y-hidden sm:px-4 sm:pb-4">
      {STATUS_ORDER.map((status) => (
        /* 原看板列内容保持不变 */
      ))}
    </div>
  )}
</div>
```

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 无报错

Run: `cd lovdex-cli && TSX_TSCONFIG_PATH= node --import tsx --test src/components/tasks/*.test.ts src/components/tasks/*.test.tsx`
Expected: 全绿（含既有测试）

- [ ] **Step 6: 手测**

Run: `cd lovdex-cli && npm run dev`
手测清单（见设计文档 §9）：
- 项目下拉 / 助手开关 / 日期字段 / 快捷项 / 自定义范围 / 清除筛选，看板与表格结果一致
- 看板/表格切换后刷新，保持上次视图
- 表格分组头、排序、行内操作、行点击进详情

- [ ] **Step 7: Commit**

```bash
git add src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): wire filter bar and board/table view toggle into task page"
```

---

## Task 7: 返回按钮接入 TaskDetail / OperatorSettingsPage

**Files:**
- Modify: `src/components/tasks/TaskDetail.tsx`
- Modify: `src/components/operators/OperatorSettingsPage.tsx`

- [ ] **Step 1: TaskDetail 头部换 TaskBackNav**

在 `src/components/tasks/TaskDetail.tsx` 顶部 import 区（`import { ViewSwitcher } from './ViewSwitcher';` 之后）加：

```tsx
import { TaskBackNav } from './TaskBackNav';
```

把 header 里：

```tsx
<div className="ml-auto flex flex-shrink-0 items-center gap-2">
  <button
    className="text-sm text-muted-foreground hover:text-foreground"
    onClick={() => navigate('/tasks')}
  >
    ← 返回任务面板
  </button>
  <span className="text-xs text-muted-foreground/50">·</span>
  <button
    className="text-sm text-muted-foreground hover:text-foreground"
    onClick={() => navigate('/')}
  >
    返回主页
  </button>
</div>
```

替换为：

```tsx
<TaskBackNav className="ml-auto flex flex-shrink-0 items-center gap-2" />
```

（`navigate` 在本文件其余地方仍在使用，保留 import。）

- [ ] **Step 2: OperatorSettingsPage 换 BackToTasksButton**

在 `src/components/operators/OperatorSettingsPage.tsx`：
- 删掉 `import { useNavigate } from 'react-router-dom';`
- 加 `import { BackToTasksButton } from '../tasks/TaskBackNav';`
- 删掉 `const navigate = useNavigate();`（第 78 行）
- 把 header 里：

```tsx
<button
  className="text-sm text-muted-foreground hover:text-foreground"
  onClick={() => navigate('/tasks')}
>
  ← 返回任务面板
</button>
```

替换为：

```tsx
<BackToTasksButton />
```

- [ ] **Step 3: 类型检查 + lint**

Run: `cd lovdex-cli && npm run typecheck`
Expected: 无报错（`navigate` 未用会报未使用？tsconfig 未开 noUnusedLocals，但 lint 会查——确认 lint 通过）

Run: `cd lovdex-cli && npm run lint`
Expected: 无 error

- [ ] **Step 4: 手测**

Run: `cd lovdex-cli && npm run dev`
- `/task/:id` 页头部显示两个 outline 按钮：返回任务面板 / 返回主页，hover 有效
- `/settings/operator` 页头部显示 outline 的返回任务面板按钮

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/TaskDetail.tsx src/components/operators/OperatorSettingsPage.tsx
git commit -m "feat(tasks): swap header nav to outline back buttons on detail and operator pages"
```

---

## Self-Review 记录

- **Spec 覆盖**：
  - 项目筛选（下拉 + 助手开关互斥）→ Task 1 filterTasks + Task 4 筛选栏
  - 日期筛选（三字段切换 + 快捷项 + 自定义范围）→ Task 1 resolveDateRange/filterTasks + Task 4
  - 表格视图（B3+ B：分组头/卡片行/副行/排序/行内操作）→ Task 5
  - 视图切换 + localStorage 持久化 → Task 6
  - 返回按钮美化（outline + 图标）→ Task 3 + Task 7
  - 测试：taskFilter / taskTable / 组件 smoke → Task 1/2/4/5
- **占位符扫描**：无 TBD/TODO；每个改文件的步骤都给了完整代码。
- **类型一致性**：`TaskFilter`/`EMPTY_TASK_FILTER`/`resolveDateRange`/`filterTasks`/`sortTasks`/`TaskSortKey`/`TaskSortDir` 在 Task 1/2/4/5/6 中签名一致；`TaskProjectOption` 复用 `TaskCard` 导出；`groupByStatus`/`STATUS_META`/`PRIORITY_META`/`LABEL_META`/`STATUS_ORDER` 均为 `taskStatus.ts` 既有导出。
