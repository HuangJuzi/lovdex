# 任务页筛选行可折叠 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务页顶部两条常驻筛选行（`TaskFilterBar` + 表格内的状态 pill 行）收进 header 的一个「筛选」按钮后面，默认收起，并用小圆点标示"有筛选正在生效"。

**Architecture:** 折叠状态与状态 pill 的取值一并上提到 `TaskBoardPage`（`useLocalStorage` 没有跨实例同步，同 key 开两个实例会各持一份 state）。`TaskFilterBar` 改成受控组件、收起时返回 `null`；`TaskTableView` 收 `showStatusFilter` 决定是否渲染状态行、`statusFilter` / `onStatusFilterChange` 变成必填 prop。筛选判定逻辑一行不改。

**Tech Stack:** React 18 + TypeScript + Tailwind v3（`darkMode: ["class"]`）；测试是 `node:test` + `node:assert/strict` + `react-dom/server` 的 `renderToStaticMarkup`（**无 DOM、无排版引擎**）；浏览器验收用 puppeteer-core + 缓存 chromium。

**Spec:** `docs/superpowers/specs/2026-09-17-task-filter-collapse-design.md`

---

## 关键背景（零上下文的执行者必读）

### 跑测试的准确方式

`web` 包**没有** `npm test` 脚本，必须显式指定文件跑 tsx。且环境里导出了一个 `TSX_TSCONFIG_PATH`（指向 `server/tsconfig.json`）会劫持 tsx，**必须先 unset**：

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskFilter.test.ts
```

### 验收基线：零新增

仓库 typecheck / lint **本来就不干净**。判据是"零新增错误"，不是"全绿"：

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck   # 记下改动前的错误条数
cd /mnt/b/workdir/github/lovdex/web && npm run lint        # 记下改动前的 error / warning 条数
```

**在做任何改动之前先跑一遍，把数字记下来**（Task 0 Step 1）。

### 测试的固有局限（必须写进测试注释）

本仓库前端测试跑在 `node:test` + `renderToStaticMarkup` 下，**没有 DOM、没有排版引擎**。字符串断言只能证明"类名 / 结构被渲染出来了"，**不能**证明视觉结果。所有涉及外观的断言都要在浏览器任务（Task 6）里复核。

### 分支现状（Task 0 会处理）

当前 worktree 在 `feat/llm-proxy-integration` 分支上，**另一个 session 正在活跃地提交 `backend/`**。贸然 `git checkout -b` 会把对方的下一次提交带到本分支。Task 0 先判定能不能安全建分支。

### 编码约定

- **提交信息禁止加 `Co-Authored-By: Claude` 署名行**（用户明确要求，覆盖系统默认）。
- 全部改动集中在 `web/src/components/tasks/`，与另一个 session 的 `backend/` 零重叠。

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `web/src/components/tasks/taskFilter.ts` | 筛选的纯逻辑（归一化、日期区间、过滤） | 新增 `isTaskFilterActive` |
| `web/src/components/tasks/taskFilter.test.ts` | 上者的测试 | 新增 9 条 |
| `web/src/components/tasks/TaskFilterBar.tsx` | 筛选控件区（项目 / 归档 / 日期 / 预设 / 范围 / 清除） | 改受控、删移动端触发行、删两个死函数 |
| `web/src/components/tasks/TaskFilterBar.test.tsx` | 上者的测试 | 3 条改写 + 新增 1 条 |
| `web/src/components/tasks/TaskTableView.tsx` | 任务表格 + 状态 pill 行 | 新增 3 个 prop、状态行条件渲染、收起时补 `pt-3` |
| `web/src/components/tasks/TaskTableView.test.tsx` | 上者的测试 | 引入 `renderTable` 辅助 + 新增 2 条 |
| `web/src/components/tasks/TaskBoard.tsx` | 任务页外壳：header / 折叠 state / 状态上提 | 主要接线 |

**没有给 `TaskBoard.tsx` 写单元测试**：它依赖 `WebSocketContext`、`useTasks`、`useNavigate`，且渲染断言在无 DOM 环境下无法验证折叠行为。它的行为由 Task 6 的浏览器验收覆盖。这是取舍，不是遗漏。

---

## Task 0: 就绪检查与分支

**Files:** 无（只跑命令）

- [ ] **Step 1: 记录验收基线**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -20
cd /mnt/b/workdir/github/lovdex/web && npm run lint 2>&1 | tail -20
```

把 typecheck 的错误条数、lint 的 error/warning 条数记到便签上。**后面所有任务都以这组数字为"零新增"的参照。**

- [ ] **Step 2: 判定能否安全建分支**

```bash
cd /mnt/b/workdir/github/lovdex && git status --short && git log --oneline -1
```

- **若工作区干净**（没有任何 `backend/` 下的改动 / 未跟踪文件）：执行

```bash
cd /mnt/b/workdir/github/lovdex && git checkout -b feat/task-filter-collapse
```

然后**本计划中每个 Task 末尾的 `git commit` 步骤照常执行**。

- **若工作区不干净**（另一 session 还在改 `backend/`）：**不要切分支**。就地改文件，**跳过本计划中所有 `git commit` 步骤**，改由 Task 7 统一处理。

无论走哪条路，下面的实现步骤完全一样。

- [ ] **Step 3: 确认要改的文件当前没有别人的改动**

```bash
cd /mnt/b/workdir/github/lovdex && git status --short -- web/src/components/tasks/
```

预期：**无输出**。若有输出，先停下来问用户，不要覆盖。

---

## Task 1: 新增纯函数 `isTaskFilterActive`

**Files:**
- Modify: `web/src/components/tasks/taskFilter.ts`
- Test: `web/src/components/tasks/taskFilter.test.ts`

- [ ] **Step 1: 写失败测试**

在 `web/src/components/tasks/taskFilter.test.ts` 顶部补两个 import。现有 import 块是：

```ts
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import {
  EMPTY_TASK_FILTER,
  filterTasks,
  normalizeTaskFilter,
  resolveDateRange,
  toggleProjectFilter,
  type TaskFilter,
} from './taskFilter';
```

改成：

```ts
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { STATUS_ORDER } from './taskStatus';
import {
  EMPTY_TASK_FILTER,
  filterTasks,
  isTaskFilterActive,
  normalizeTaskFilter,
  resolveDateRange,
  toggleProjectFilter,
  type TaskFilter,
} from './taskFilter';
```

然后在文件**末尾**追加（文件里已有 `filterOf` 辅助函数，直接复用）：

```ts
// ── isTaskFilterActive：折叠后要不要亮「有东西被筛掉」的圆点 ──────────────

test('isTaskFilterActive: all defaults is inactive', () => {
  assert.equal(isTaskFilterActive(filterOf({}), [...STATUS_ORDER]), false);
});

test('isTaskFilterActive: a project selection is active', () => {
  assert.equal(isTaskFilterActive(filterOf({ projectPaths: ['/p1'] }), [...STATUS_ORDER]), true);
});

test('isTaskFilterActive: a date preset is active', () => {
  assert.equal(isTaskFilterActive(filterOf({ preset: 'today' }), [...STATUS_ORDER]), true);
});

test('isTaskFilterActive: a custom range on one side only is active', () => {
  assert.equal(isTaskFilterActive(filterOf({ customFrom: '2026-08-01' }), [...STATUS_ORDER]), true);
  assert.equal(isTaskFilterActive(filterOf({ customTo: '2026-08-01' }), [...STATUS_ORDER]), true);
});

test('isTaskFilterActive: showArchived alone is NOT active (it adds rows, never hides)', () => {
  assert.equal(isTaskFilterActive(filterOf({ showArchived: true }), [...STATUS_ORDER]), false);
});

test('isTaskFilterActive: dateField alone is NOT active', () => {
  assert.equal(isTaskFilterActive(filterOf({ dateField: 'deadline' }), [...STATUS_ORDER]), false);
});

test('isTaskFilterActive: dropping one status pill is active', () => {
  const partial = STATUS_ORDER.filter((s) => s !== 'in_progress');
  assert.equal(isTaskFilterActive(filterOf({}), partial), true);
});

test('isTaskFilterActive: archived pill is ignored while showArchived is off', () => {
  // 默认（showArchived=false）不渲染 archived 列，所以「没勾 archived」不算筛掉东西。
  const withoutArchived = STATUS_ORDER.filter((s) => s !== 'archived');
  assert.equal(isTaskFilterActive(filterOf({}), withoutArchived), false);
});

test('isTaskFilterActive: archived pill counts once showArchived is on', () => {
  const withoutArchived = STATUS_ORDER.filter((s) => s !== 'archived');
  assert.equal(isTaskFilterActive(filterOf({ showArchived: true }), withoutArchived), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskFilter.test.ts
```

预期：9 条新用例 FAIL（`isTaskFilterActive is not a function` 之类），原有 29 条 PASS。

- [ ] **Step 3: 实现**

`web/src/components/tasks/taskFilter.ts` 第 1 行的 import 现在是：

```ts
import type { Task } from '../../types/app';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
```

改成：

```ts
import type { Task, TaskStatus } from '../../types/app';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { STATUS_ORDER } from './taskStatus';
```

（不构成循环依赖：`taskStatus.ts` 只引 `types/app` 与 `taskTimestamp.ts`。）

在文件**末尾**（`filterTasks` 之后）追加：

```ts
/**
 * 是否处于「有东西被筛掉了」的状态：任务级筛选（项目 / 日期）或状态 pill 否掉了某个状态。
 *
 * `showArchived` 不计入 —— 打开它只会多出行、不会藏行；关闭时 archived 本就不渲染，
 * 那是默认值而非用户施加的筛选。`dateField` 同理：单改日期字段不筛掉任何东西。
 * 这两条与 `TaskFilterBar` 里「清除筛选」按钮的显示条件保持同一套语义。
 */
export function isTaskFilterActive(filter: TaskFilter, statusFilter: TaskStatus[]): boolean {
  if (filter.projectPaths.length > 0) return true;
  if (filter.preset !== 'all' || filter.customFrom !== '' || filter.customTo !== '') return true;
  const renderable = STATUS_ORDER.filter((s) => s !== 'archived' || filter.showArchived);
  return !renderable.every((s) => statusFilter.includes(s));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskFilter.test.ts
```

预期：全部 PASS（29 + 9 = 38 条）。

- [ ] **Step 5: 提交**（Task 0 判定为"不干净"则跳过）

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/taskFilter.ts web/src/components/tasks/taskFilter.test.ts
git commit -m "feat(tasks): add isTaskFilterActive for the collapsible filter indicator"
```

---

## Task 2: `TaskFilterBar` 改成受控、删掉移动端触发行

**Files:**
- Modify: `web/src/components/tasks/TaskFilterBar.tsx`
- Test: `web/src/components/tasks/TaskFilterBar.test.tsx`

- [ ] **Step 1: 改写测试（先写失败测试）**

把 `web/src/components/tasks/TaskFilterBar.test.tsx` **整个文件**替换为：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EMPTY_TASK_FILTER, type TaskFilter } from './taskFilter';
import { TaskFilterBar } from './TaskFilterBar';

const renderBar = (open: boolean, filter: TaskFilter = EMPTY_TASK_FILTER) =>
  renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter,
      onChange: () => {},
      open,
    }),
  );

/**
 * 局限同 TaskTableView.test.tsx：`node:test` + `renderToStaticMarkup` 没有 DOM、
 * 没有排版引擎，这里只能证明结构与类名被渲染出来，不能证明视觉结果。
 */
test('filter bar renders nothing while collapsed', () => {
  assert.equal(renderBar(false), '');
});

test('filter bar renders the project multi-select trigger and no assistant toggle', () => {
  const html = renderBar(true);
  assert.match(html, /全部项目/);
  assert.match(html, /创建时间/);
  assert.match(html, /最近活动/);
  assert.doesNotMatch(html, /只看助手/);
  assert.doesNotMatch(html, /清除筛选/);
});

test('filter bar shows the selected project and a clear button when active', () => {
  const html = renderBar(true, { ...EMPTY_TASK_FILTER, projectPaths: ['/p'] });
  assert.match(html, /proj/);
  assert.match(html, /清除筛选/);
});

test('filter bar no longer renders its own mobile trigger row', () => {
  // 移动端触发行已删除：折叠改由 TaskBoard 的 header 按钮统一控制。
  // 触发行独有的特征是「项目：xxx · 日期：xxx」这句摘要，控件区里不会出现。
  assert.doesNotMatch(renderBar(true), /项目：/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskFilterBar.test.tsx
```

预期：`filter bar renders nothing while collapsed` FAIL（现在 `open` 被忽略、永远渲染控件区，所以返回的不是空串）；`no longer renders its own mobile trigger row` FAIL（摘要还在）。

- [ ] **Step 3: 实现**

改 `web/src/components/tasks/TaskFilterBar.tsx`。**逐段照做。**

(a) 文件头部的 import 块（第 1-15 行）整体替换为：

```tsx
import { cn } from '../../lib/utils';   // ← 若 (f) 之后 cn 已无调用点，连这行一起删（见 Step 5）
import { Pill, PillBar } from '../../shared/view/ui';

import type { TaskProjectOption } from './TaskCard';
import { ProjectMultiSelect } from './ProjectMultiSelect';
import {
  EMPTY_TASK_FILTER,
  type TaskDateField,
  type TaskFilter,
  type TaskFilterPreset,
} from './taskFilter';
```

删掉的：`import { useState } from 'react';`、`import { ChevronDown, SlidersHorizontal } from 'lucide-react';`、`import { ASSISTANT_OPTION_VALUE } from './projectOptions';`（后两个函数删掉后都没人用了）。

(b) 删除 `projectFilterLabel`（原第 37-48 行）与 `filterSummary`（原第 50-58 行）两个函数，连同它们上方的文档注释。已核实：`filterSummary` 的唯一调用点是即将删掉的移动端触发行，`projectFilterLabel` 的唯一调用点在 `filterSummary` 内部。

(c) props 类型加 `open`：

```tsx
type TaskFilterBarProps = {
  projectOptions: TaskProjectOption[];
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
  /** 展开 / 收起由 TaskBoard 的 header「筛选」按钮统一控制；收起时整个组件不渲染。 */
  open: boolean;
};
```

(d) 组件签名与函数体开头：

```tsx
/**
 * Task 页筛选栏：项目多选 + 日期字段切换 + 快捷项 + 自定义范围。
 * 受控组件：`open` 由 TaskBoard 的 header 按钮驱动，收起时返回 null。
 * 移动端（<sm）控件竖排，桌面端（≥sm）一排居中；两端共用同一个折叠入口。
 */
export function TaskFilterBar({ projectOptions, filter, onChange, open }: TaskFilterBarProps) {
  if (!open) return null;

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

  return (
    <div className="border-b border-border/60 sm:border-0">
      <div className="sm:overflow-x-auto">
        <div className="flex flex-col gap-x-3 gap-y-2 px-3 pb-2 pt-1 sm:mx-auto sm:flex sm:w-max sm:flex-row sm:flex-nowrap sm:items-center sm:gap-x-6 sm:px-4 sm:py-2">
```

(e) 原来的移动端触发行（`<button ... className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground sm:hidden">…</button>`）整块删除。

(f) 控件区那个 `className={cn(...)}` 的三元表达式**删掉**，直接换成上面 (d) 里那串固定类名，因为此时一定处于展开状态。注意**不要**写成 `hidden sm:flex` —— Tailwind 把变体类排在样式表更后面，`hidden sm:flex` 在 `≥sm` 是**可见**的，那会是个隐藏不掉的 bug。

(g) 控件区内部的五个分组（项目多选 / 显示归档 / 日期字段 / 快捷项 / 自定义范围 + 清除筛选）**一字不改**。

(h) 收尾的 `</div></div></div>` 闭合层级与原来一致（原来是三层：外层 border div → `sm:overflow-x-auto` → 控件区）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskFilterBar.test.tsx
```

预期：4 条全部 PASS。

- [ ] **Step 5: 确认没有留下未使用的 import**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx eslint src/components/tasks/TaskFilterBar.tsx
```

预期：无 `no-unused-vars` 报错。若有，删掉对应的 import。

- [ ] **Step 6: 提交**（Task 0 判定为"不干净"则跳过）

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskFilterBar.tsx web/src/components/tasks/TaskFilterBar.test.tsx
git commit -m "refactor(tasks): make TaskFilterBar controlled, drop its own mobile toggle row"
```

> ⚠️ 此步之后 `TaskBoard.tsx` 会因为没传 `open` 而 typecheck 报错，`npm run typecheck` 暂时不干净。Task 4 会修好。**不要**为了让它过而给 `open` 加默认值。

---

## Task 3: `TaskTableView` 状态行可折叠 + 状态取值受控

**Files:**
- Modify: `web/src/components/tasks/TaskTableView.tsx`
- Test: `web/src/components/tasks/TaskTableView.test.tsx`

- [ ] **Step 1: 给测试文件加 `renderTable` 辅助函数**

在 `web/src/components/tasks/TaskTableView.test.tsx` 的 import 块之后、`mkTask` 定义之前，插入：

```tsx
/**
 * 渲染辅助：把 `statusFilter` / `onStatusFilterChange` 这两个必填 prop 的默认值收在一处，
 * 免得 15 个用例各写一遍。`showStatusFilter` 有默认值 `true`，不传即展开态。
 */
const renderTable = (props: Partial<React.ComponentProps<typeof TaskTableView>> = {}) =>
  renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [],
      projectOptions: [],
      statusFilter: [...STATUS_ORDER],
      onStatusFilterChange: () => {},
      ...props,
    }),
  );
```

同时在 import 块里补上 `STATUS_ORDER`：

```tsx
import { STATUS_ORDER } from './taskStatus';
import { TaskTableView } from './TaskTableView';
```

- [ ] **Step 2: 把 15 个现有用例改用 `renderTable`**

机械替换：凡形如

```tsx
const html = renderToStaticMarkup(
  React.createElement(TaskTableView, { …props… }),
);
```

一律改成

```tsx
const html = renderTable({ …props… });
```

共 **15** 处（Step 1 插入辅助函数**之前**，它们的起始行号是 43、56、63、77、90、100、116、129、140、161、175、189、202、217、228 —— 插入后整体下移，别按行号找，按"每个 `test(...)` 里那一处 `renderToStaticMarkup(React.createElement(TaskTableView, …))`"来找）。**props 内容一字不改**，只改外层调用形式。

改完自检：`grep -c "renderTable(" src/components/tasks/TaskTableView.test.tsx` 应为 15（辅助函数定义那行写的是 `renderTable = (`，不计入）。

- [ ] **Step 3: 追加两条新用例**

在 `TaskTableView.test.tsx` **末尾**追加：

```tsx
/** 取出表格滚动区的类名集合（顺序无关：eslint 的 tailwindcss/classnames-order 会重排）。 */
const scrollerClasses = (html: string): string[] => {
  const m = html.match(/<div class="([^"]*overflow-x-auto[^"]*)"/);
  assert.ok(m, '未找到表格滚动区');
  return m[1].split(/\s+/);
};

test('状态筛选行可折叠：showStatusFilter=false 时整行不渲染，但状态筛选仍然生效', () => {
  const html = renderTable({
    tasks: [
      mkTask({ task_id: 't1', title: '待办任务', status: 'todo' }),
      mkTask({ task_id: 't2', title: '进行中任务', status: 'in_progress' }),
    ],
    statusFilter: ['in_progress'],
    showStatusFilter: false,
  });
  assert.doesNotMatch(html, /data-testid="status-filter"/);
  // 行没了、筛选还在：只有 in_progress 分组被渲染出来。
  assert.match(html, /进行中任务/);
  assert.doesNotMatch(html, /待办任务/);
});

test('状态筛选行收起的替代间距：showStatusFilter=false 时滚动区补 pt-3', () => {
  // 展开时状态行的 py-2.5 提供了表头与卡片上沿之间的间距；行没了就得补回来。
  assert.match(renderTable({ showStatusFilter: true }), /data-testid="status-filter"/);
  assert.ok(!scrollerClasses(renderTable({ showStatusFilter: true })).includes('pt-3'));
  assert.ok(scrollerClasses(renderTable({ showStatusFilter: false })).includes('pt-3'));
});
```

- [ ] **Step 4: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskTableView.test.tsx
```

预期：两条新用例 FAIL（`showStatusFilter` 被忽略，状态行照渲染、也没有 `pt-3`）。其余 15 条此时仍 PASS（`renderTable` 已把必填 prop 补上）。

- [ ] **Step 5: 实现**

改 `web/src/components/tasks/TaskTableView.tsx`。

(a) props 类型（`TaskTableViewProps`）加上三个字段：

```tsx
type TaskTableViewProps = {
  tasks: Task[];
  projectOptions: TaskProjectOption[];
  showArchived?: boolean;
  /**
   * 状态 pill 行的取值。**由上层的 TaskBoard 持有**：`useLocalStorage` 没有跨实例同步，
   * 同 key 开两个实例会各持一份 state，header 的折叠按钮就判断不出筛选是否生效。
   */
  statusFilter: TaskStatus[];
  onStatusFilterChange: (next: TaskStatus[]) => void;
  /** 折叠筛选区时传 false：整行不渲染，筛选本身照常生效。 */
  showStatusFilter?: boolean;
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

(b) 组件签名加参数，并在解构里给 `showStatusFilter` 默认值：

```tsx
export function TaskTableView({
  tasks,
  projectOptions,
  showArchived = false,
  statusFilter,
  onStatusFilterChange,
  showStatusFilter = true,
  onStart,
  onStatusChange,
  onOpenSession,
  onProjectChange,
  onOpenTask,
  selected,
  onToggleSelect,
  onToggleSelectAll,
}: TaskTableViewProps) {
```

(c) 删掉内部的 state，改用 prop。原第 102 行：

```tsx
  const [statusFilter, setStatusFilter] = useLocalStorage<TaskStatus[]>('taskTableStatusFilter', [...STATUS_ORDER]);
```

**整行删除**。（`useLocalStorage` 仍被 `sortKey` / `sortDir` 使用，import 保留；`STATUS_ORDER` 仍被 `statusesToRender` 使用，import 保留。）

(d) 两处 setter 调用改成回调 prop：

"全部" pill 的 `onClick`：

```tsx
onClick={() => onStatusFilterChange([...statusesToRender])}
```

单个状态 pill 的 `onClick`（原来是函数式更新 `setStatusFilter((sel) => toggleStatus(sel, status))`；改成受控后直接用当前值算新数组）：

```tsx
onClick={() => onStatusFilterChange(toggleStatus(statusFilter, status))}
```

(e) 状态筛选行改成条件渲染。原第 136-160 行那段 `<div data-testid="status-filter" …>…</div>` 外面包一层条件：

```tsx
      {/* 状态筛选行：固定，不随表格横向滚动。折叠筛选区时整行不渲染（筛选本身仍生效）。 */}
      {showStatusFilter && (
        <div
          data-testid="status-filter"
          className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4"
        >
          {/* …内容与原来完全一致… */}
        </div>
      )}
```

(f) 滚动区补间距。原第 180 行：

```tsx
      <div className="min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4">
```

改成：

```tsx
      {/* 展开时表头与卡片上沿的间距由状态行的 py-2.5 提供；行没了要补上。 */}
      <div className={`min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4${showStatusFilter ? '' : ' pt-3'}`}>
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskTableView.test.tsx
```

预期：17 条（15 改 + 2 新）全部 PASS。

- [ ] **Step 7: 提交**（Task 0 判定为"不干净"则跳过）

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskTableView.tsx web/src/components/tasks/TaskTableView.test.tsx
git commit -m "feat(tasks): make the table status filter row collapsible and lift its state"
```

---

## Task 4: `TaskBoard` 接线 + header「筛选」按钮

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`

**这个文件没有单元测试**（依赖 `WebSocketContext` / `useTasks` / `useNavigate`，且无 DOM 环境下断言不了折叠行为）。正确性由 Task 5 的 typecheck / lint 与 Task 6 的浏览器验收覆盖。

- [ ] **Step 1: 补 import**

第 3 行的 lucide 具名 import 加 `SlidersHorizontal`：

```tsx
import { Clock, LayoutGrid, Plus, SlidersHorizontal, Table, X } from 'lucide-react';
```

第 11-15 行的类型 import 加 `TaskStatus`：

```tsx
import type {
  Project,
  Task,
  TaskStatus,
} from '../../types/app';
```

第 27 行的 `taskFilter` import 加 `isTaskFilterActive`：

```tsx
import { EMPTY_TASK_FILTER, filterTasks, isTaskFilterActive, normalizeTaskFilter } from './taskFilter';
```

（`STATUS_ORDER` 第 21 行已经导入了，不用动。）

- [ ] **Step 2: 加折叠 state 与上提状态筛选**

在第 35 行 `const [viewMode, setViewMode] = useLocalStorage<...>('taskViewMode', 'board');` **之后**插入：

```tsx
  // 筛选区折叠：两条筛选行（TaskFilterBar + 表格内的状态 pill 行）常驻时纵向占用过大，
  // 默认收起。由 header 的「筛选」按钮统一控制。
  const [filtersOpen, setFiltersOpen] = useLocalStorage<boolean>('taskFiltersOpen', false);
  // 状态 pill 的取值从 TaskTableView 上提到这里：`useLocalStorage` 是纯 useState、
  // 没有跨实例同步，同 key 开两个实例会各持一份 state，header 按钮就判断不出筛选是否生效。
  // key 不变，老用户已存的取值继续有效。
  const [statusFilter, setStatusFilter] = useLocalStorage<TaskStatus[]>(
    'taskTableStatusFilter',
    [...STATUS_ORDER],
  );
```

- [ ] **Step 3: 算圆点判据**

在第 45 行 `const effectiveView = isMobile && viewMode !== 'scheduled' ? 'board' : viewMode;` **之后**插入：

```tsx
  // 看板视图不消费状态 pill（列固定渲染全部状态），此时一个非全选的状态 pill
  // 并没有筛掉任何东西，不该点亮圆点 —— 传「全部状态」进去把它排除掉。
  const effectiveStatusFilter = effectiveView === 'table' ? statusFilter : [...STATUS_ORDER];
  const hasActiveFilter = isTaskFilterActive(filter, effectiveStatusFilter);
```

- [ ] **Step 4: 在 header 里加按钮**

原第 314 行是视图切换器那个分组的收尾 `</div>`，原第 315 行是 `<div className="ml-auto flex items-center gap-2">`。**在这两行之间**插入：

```tsx
        {/* 筛选区折叠开关。放切换器分组外面 —— 放进那个带边框的组里会被当成第四个视图。
            定时视图没有筛选，不渲染。 */}
        {effectiveView !== 'scheduled' && (
          <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
            <button
              type="button"
              aria-expanded={filtersOpen}
              title={
                filtersOpen
                  ? '收起筛选'
                  : hasActiveFilter
                    ? '展开筛选（当前有筛选条件生效，列表可能只显示部分任务）'
                    : '展开筛选'
              }
              onClick={() => setFiltersOpen((o) => !o)}
              className={cn(
                'relative flex items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-sm font-normal transition-all',
                filtersOpen
                  ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5 flex-shrink-0" />
              {/* 移动端（<640px）只留图标，与相邻按钮一致 */}
              <span className="hidden sm:inline">筛选</span>
              {hasActiveFilter && !filtersOpen && (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary"
                />
              )}
            </button>
          </div>
        )}
```

- [ ] **Step 5: 给两个子组件透传 prop**

原第 350 行：

```tsx
          <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} />
```

改成：

```tsx
          <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} open={filtersOpen} />
```

原第 403-416 行的 `<TaskTableView …>` 里补三个 prop，插在 `showArchived={filter.showArchived}` 之后：

```tsx
              showArchived={filter.showArchived}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              showStatusFilter={filtersOpen}
```

- [ ] **Step 6: typecheck 与 lint**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -20
cd /mnt/b/workdir/github/lovdex/web && npm run lint 2>&1 | tail -20
```

预期：回到 Task 0 Step 1 记下的基线 —— **零新增**。Task 2 之后暂时出现的 `open` 缺失错误应在此消失。

- [ ] **Step 7: 提交**（Task 0 判定为"不干净"则跳过）

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): add a header filter toggle collapsing both filter rows"
```

---

## Task 5: 自动化验收

**Files:** 无（只跑命令）

- [ ] **Step 1: 跑全部受影响的测试**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test \
  src/components/tasks/taskFilter.test.ts \
  src/components/tasks/TaskFilterBar.test.tsx \
  src/components/tasks/TaskTableView.test.tsx \
  src/components/tasks/taskStatus.test.ts \
  src/components/tasks/TaskInboxPanel.test.tsx
```

预期：全部 PASS。

- [ ] **Step 2: 跑整个 tasks 目录，确认没有连带打挂别的**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/*.test.ts src/components/tasks/*.test.tsx
```

预期：无 FAIL。若有，先判断是不是本次改动引入的（对照 `git stash` 前后，或直接看失败是否落在本计划改过的文件上）。

- [ ] **Step 3: 全量 typecheck + lint，对照基线**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -20
cd /mnt/b/workdir/github/lovdex/web && npm run lint 2>&1 | tail -20
```

预期：与 Task 0 Step 1 的数字**逐项相等或更少**。任何一个数字变大 → 停下来修，别往下走。

---

## Task 6: 浏览器验收

**Files:** 无（只跑脚本）

前置：:5188 前端 / :3188 后端已在跑。**本次是纯前端改动，走 vite HMR，不要重启后端**（重启前必须先问用户：同一个后端还跑着别的项目）。

登录：`zhiju.huang@sophgo.com` / code `888888`。

- [ ] **Step 1: 准备 puppeteer 脚本骨架**

`puppeteer-core` 的 ESM 入口在这个环境里不存在，**必须用 CommonJS 的 `index.js` 绝对路径**：

```js
import puppeteer from '/home/zhijuhuang/.cursor-server/extensions/yzane.markdown-pdf-1.5.0-universal/node_modules/puppeteer-core/index.js';

const CHROME = '/home/zhijuhuang/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto('http://127.0.0.1:5188/tasks', { waitUntil: 'networkidle2' });

// 登录（后端默认开启登录门槛）
await page.evaluate(() => localStorage.setItem('theme', 'light'));
// …按登录页实际结构填邮箱 / 验证码，提交…
// 切到表格视图（TaskBoard 的「表格」按钮）：<button title="表格">
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('header button')].find((b) => b.title === '表格');
  btn?.click();
});
await new Promise((r) => setTimeout(r, 400));
```

- [ ] **Step 2: 判据 1 —— 点击展开/收起，两条行出现与消失**

```js
const probe = () => page.evaluate(() => {
  const header = document.querySelector('header');
  const table = document.querySelector('table');
  return {
    // TaskFilterBar 独有的特征：两个 <input type="date">（从 / 至）。比按文案找稳。
    filterBar: document.querySelectorAll('input[type="date"]').length > 0,
    statusRow: !!document.querySelector('[data-testid="status-filter"]'),
    ariaExpanded: header.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'),
    // 表格上沿相对视口的位置 —— 直接量"表格上方占了多少纵向空间"。
    tableTop: table ? Math.round(table.getBoundingClientRect().top) : null,
  };
});

const collapsed = await probe();     // 首次进页面：应为收起
await page.evaluate(() => document.querySelector('header button[aria-expanded]')?.click());
await new Promise((r) => setTimeout(r, 300));
const expanded = await probe();
```

预期：`collapsed.statusRow === false`、`collapsed.filterBar === false`、`collapsed.ariaExpanded === 'false'`；`expanded.statusRow === true`、`expanded.filterBar === true`、`expanded.ariaExpanded === 'true'`；**`expanded.tableTop > collapsed.tableTop`**（展开后表格被推下去了）。

> 注意：`header button[aria-expanded]` 能唯一定位到筛选按钮 —— 视图切换器用的是 `aria-pressed`，header 里只有这一个 `aria-expanded`。

- [ ] **Step 3: 判据 2 —— 刷新保持**

收起状态刷新 → 仍收起；展开状态刷新 → 仍展开。用 `page.evaluate(() => localStorage.getItem('taskFiltersOpen'))` 交叉验证（应为 `"false"` / `"true"`）。

- [ ] **Step 4: 判据 3 —— 圆点随筛选状态出现与消失**

在**收起**状态下，先展开、把状态 pill 改成只剩「进行中」（点其它 pill 取消），再收起，然后：

```js
const dot = await page.evaluate(() => {
  const btn = document.querySelector('header button[aria-expanded]');
  return {
    title: btn?.title,
    hasDot: !![...btn.querySelectorAll('span')]
      .find((s) => s.className.includes('rounded-full') && s.className.includes('bg-primary')),
  };
});
```

预期：`hasDot === true`，且 `title` 是「展开筛选（当前有筛选条件生效，列表可能只显示部分任务）」。

展开、点「全部」pill，再收起 → `hasDot === false`、`title === '展开筛选'`。

- [ ] **判据 4 —— 看板视图下圆点不因状态 pill 而亮**

切到看板视图（`title="看板"`）。预期：按钮仍在（不是定时视图），且**圆点不亮** —— 因为看板不消费状态 pill。

- [ ] **判据 5 —— 省下的纵向高度**

记录 `header` 下沿到表格上沿的差值（收起 vs 展开），打印出来。预期收起时明显更小（两条行合计约 100px）。

- [ ] **判据 6 —— 1280 / 1024 下 header 不溢出**

在 1280 与 1024 两个宽度分别：

```js
const overflow = await page.evaluate(() => {
  const h = document.querySelector('header');
  return { scrollWidth: h.scrollWidth, clientWidth: h.clientWidth };
});
```

预期：两个宽度下 `scrollWidth <= clientWidth`。

- [ ] **判据 7 —— 移动端 375px**

`page.setViewport({ width: 375, height: 812 })`。预期：按钮在（看板视图），图标可见、「筛选」两字隐藏；点击后能展开控件区，控件区竖排。

- [ ] **判据 8 —— 定时视图下按钮不出现**

切到定时视图（`title="定时任务"`）。预期：`await page.$('header button[aria-expanded]')` 返回 `null` —— 筛选按钮在定时视图下不渲染。

- [ ] **判据 9 —— 深色模式**

深色要用**不带引号**的值写 localStorage，因为 `ThemeContext` 读的是 `localStorage.getItem('theme')` 直接和 `'dark'` 比：

```js
await page.evaluate(() => localStorage.setItem('theme', 'dark'));
await page.reload({ waitUntil: 'networkidle2' });
```

然后重跑判据 1 与 4，并截图。预期：按钮激活态与圆点在深色下可辨；折叠行为一致。

- [ ] **Step 5: 把实测数字与截图贴进最终汇报**

不要只写"通过"。写清楚每个判据的实测值（尤其判据 5 的 px 差、判据 6 的 overflow 数值），以及任何没达成的项。

---

## Task 7: 收尾提交与合并

**Files:** 无

- [ ] **Step 1: 若 Task 0 走了"不干净"分支，先重新判定**

```bash
cd /mnt/b/workdir/github/lovdex && git status --short && git log --oneline -1
```

若 `backend/` 下的在途改动已经提交、工作区仅剩本次改动的文件：

```bash
cd /mnt/b/workdir/github/lovdex && git checkout -b feat/task-filter-collapse
```

若仍不干净：**停下来问用户**，不要切分支，也不要代为暂存（`git stash`）别人的改动。

- [ ] **Step 2: 提交（仅当前面跳过了 per-task 提交）**

```bash
cd /mnt/b/workdir/github/lovdex
git add docs/superpowers/specs/2026-09-17-task-filter-collapse-design.md \
        docs/superpowers/plans/2026-09-17-task-filter-collapse.md \
        web/src/components/tasks/taskFilter.ts \
        web/src/components/tasks/taskFilter.test.ts \
        web/src/components/tasks/TaskFilterBar.tsx \
        web/src/components/tasks/TaskFilterBar.test.tsx \
        web/src/components/tasks/TaskTableView.tsx \
        web/src/components/tasks/TaskTableView.test.tsx \
        web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): collapse the two filter rows behind a header toggle"
```

**注意**：`.gitignore` 之外的无关未跟踪文件（如 `docs/feature-requirements-project-delete-chat-copy.md`、`docs/superpowers/specs/2026-09-14-task-panel-table-design.md`）**不要 `git add`** —— 它们不是本次工作的一部分。

- [ ] **Step 3: 提交信息里不要加 `Co-Authored-By` 署名行**（用户明确要求）。

- [ ] **Step 4: 合入 main 并双推**（先向用户确认再执行）

本仓库的惯例是 `feat/*` 分支 ff 合入 `main`，两边都推：

```bash
cd /mnt/b/workdir/github/lovdex
git checkout main && git merge --ff-only feat/task-filter-collapse && git push origin main
git push -u origin feat/task-filter-collapse
```

保留 `feat/task-filter-collapse` 分支不删——仓库里既有的 `feat/*` 分支都留着。

---

## 自查记录

**Spec 覆盖：**

| Spec 章节 | 落到哪个 Task |
|---|---|
| §2 目标行为（按钮、同时控两条、默认收起+记住、全端统一） | Task 2 / 3 / 4；浏览器判据 1-3、7 |
| §2.1 不做 | 无对应改动（符合预期） |
| §3 方案 A | Task 3 (上提) + Task 4 (受控接线) |
| §4.1 按钮（位置 / 定时视图不渲染 / 移动端只图标 / 圆点 / title 三态 / aria） | Task 4 Step 4；浏览器判据 1、4、7、8 |
| §4.2 折叠范围与状态（key `taskFiltersOpen`、默认 false、取值不动、`pt-3`） | Task 3 Step 5(f)、Task 4 Step 2；浏览器判据 2、5 |
| §4.3 数据流 + prop 签名 + 看板边界 | Task 3 Step 5(a)(b)、Task 4 Step 2/3/5；浏览器判据 4 |
| §4.4 `isTaskFilterActive` | Task 1 |
| §4.5 `TaskFilterBar` 改受控、删触发行、删两个死函数 | Task 2 |
| §5.1 自动化验收 | Task 5 |
| §5.2 浏览器验收 9 条 | Task 6 Step 2-4（判据 1-9） |
| §6 影响文件 | 文件结构表逐项对应 |

**类型一致性**：`isTaskFilterActive(filter: TaskFilter, statusFilter: TaskStatus[])` 在 Task 1 定义，Task 4 Step 3 按同一签名调用。`showStatusFilter?: boolean`（默认 `true`）在 Task 3 定义，Task 4 Step 5 传 `filtersOpen`。`open: boolean`（必填）在 Task 2 定义，Task 4 Step 5 传 `filtersOpen`。`statusFilter` / `onStatusFilterChange`（必填）在 Task 3 定义，Task 4 Step 5 传 `statusFilter` / `setStatusFilter`。localStorage key 三处一致：`taskFiltersOpen`、`taskTableStatusFilter`（未变）。

**占位符扫描**：无 TBD / TODO；每个改码步骤都给了完整代码；每个命令都给了预期输出。唯一一处"看情况"是 Task 0 的分支判定与 Task 7 Step 1 的复查，两者都写明了判定条件与两侧的确定动作。
