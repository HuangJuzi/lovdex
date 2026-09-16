# Task Inbox（「需要你处理」收件箱段）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任务页顶部加一段「需要你处理」聚合区，把需要用户介入的信号（等你批准 / 执行失败 / 待你验收 / 已逾期等）收到一处，聚合条上直给动作按钮，不必先点进任务。

**Architecture:** 纯前端改动。一个纯函数 `attentionItems(tasks, now)` 派生「需处理」列表（`sub_status` 命中 8 个需要介入的值，或 deadline 已逾期且未完成/归档）；一个 `TaskInboxPanel` 组件把每条渲染成「信号徽标 + 标题 + 项目 + 动作按钮」，动作复用现有 handler（`runTask` / `updateStatus` / 会话跳转 / 任务跳转）；在 `TaskBoard` 顶部（筛选栏之后、看板/表格之前）接入，看板与表格共用、移动端同段。有项才渲染，清空自动消失。不加新 API。

**Tech Stack:** React 18 + Tailwind（web）、node:test + renderToStaticMarkup（前端 SSR 静态测试，无 DOM）。

**Spec:** `docs/superpowers/specs/2026-09-16-task-inbox-design.md`

**测试命令（前端）：**
- 单文件：`env -u TSX_TSCONFIG_PATH npx tsx --test src/<path>.test.ts`（.test.tsx 同理，在 `web/` 下）
- 环境 gotcha：shell 全局导出了 `TSX_TSCONFIG_PATH=server/tsconfig.json`，前端跑测试必须 `env -u TSX_TSCONFIG_PATH`。
- typecheck：`cd web && npm run typecheck`（baseline 已确认 0 errors）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `web/src/components/tasks/taskInbox.ts` | `attentionItems` 纯函数 + `AttentionItem`/`AttentionAction`/`AttentionTone` 类型 | 新建 |
| `web/src/components/tasks/taskInbox.test.ts` | 纯函数测试（信号命中/动作映射/逾期边界） | 新建 |
| `web/src/components/tasks/TaskInboxPanel.tsx` | 聚合段渲染（信号徽标 + 标题 + 项目 + 动作按钮） | 新建 |
| `web/src/components/tasks/TaskInboxPanel.test.tsx` | 组件测试（有项渲染/空不渲染/动作按钮文案） | 新建 |
| `web/src/components/tasks/TaskBoard.tsx` | 顶部接入 `TaskInboxPanel` | 修改 |

---

### Task 0: 环境自检（确认分支）

**Files:** 无

> 仓库惯例：实现应在 `feat/*` 分支上做，含 spec/计划文档后在 main 上 ff 合入。

- [ ] **Step 1: 检查当前分支并新建 feature 分支**

Run: `git branch --show-current`
Expected: `main`（若已在 feature 分支则跳过）
Action:

```bash
git checkout -b feat/task-inbox
```

---

### Task 1: `taskInbox` 纯函数（TDD）

**Files:**
- Create: `web/src/components/tasks/taskInbox.ts`
- Test: `web/src/components/tasks/taskInbox.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/taskInbox.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { attentionItems } from './taskInbox';

const NOW = new Date('2026-09-16T12:00:00');

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
  context_summary: null,
  source_schedule_id: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

test('ignores tasks that need no attention', () => {
  assert.equal(attentionItems([mkTask({ task_id: 't1' })], NOW).length, 0);
  assert.equal(attentionItems([mkTask({ task_id: 'r1', status: 'in_progress', sub_status: 'running' })], NOW).length, 0);
  assert.equal(attentionItems([mkTask({ task_id: 'd1', status: 'done', sub_status: 'done' })], NOW).length, 0);
});

test('maps each action sub_status to its action', () => {
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', sub_status: 'failed' })], NOW)[0].action, 'retry');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_review', sub_status: 'pending_acceptance' })], NOW)[0].action, 'accept');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'waiting_approval' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'waiting_answer' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'waiting_plan' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_review', session_id: 's1', sub_status: 'needs_review' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'blocked' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'only_plan' })], NOW)[0].action, 'openSession');
});

test('waiting signal without a session falls back to openTask', () => {
  const [item] = attentionItems([mkTask({ task_id: 'w1', status: 'in_progress', sub_status: 'waiting_approval' })], NOW);
  assert.equal(item.action, 'openTask');
});

test('overdue todo task becomes a start item', () => {
  const [item] = attentionItems([mkTask({ task_id: 'o1', status: 'todo', deadline: '2026-09-15' })], NOW);
  assert.equal(item.signal, 'overdue');
  assert.equal(item.label, '已逾期 1 天');
  assert.equal(item.action, 'start');
});

test('overdue non-todo task with a session becomes an openSession item', () => {
  const [item] = attentionItems([mkTask({ task_id: 'o2', status: 'in_progress', deadline: '2026-09-15', session_id: 's1' })], NOW);
  assert.equal(item.action, 'openSession');
});

test('overdue done/archived tasks are ignored', () => {
  assert.equal(attentionItems([mkTask({ task_id: 'd1', status: 'done', deadline: '2026-09-15' })], NOW).length, 0);
  assert.equal(attentionItems([mkTask({ task_id: 'a1', status: 'archived', deadline: '2026-09-15' })], NOW).length, 0);
});

test('deadline today is not overdue', () => {
  assert.equal(attentionItems([mkTask({ task_id: 't1', deadline: '2026-09-16' })], NOW).length, 0);
});

test('failed + overdue counts once, preferring the sub_status signal', () => {
  const items = attentionItems([mkTask({ task_id: 'f1', status: 'in_progress', sub_status: 'failed', deadline: '2026-09-10' })], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].signal, 'failed');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskInbox.test.ts`
Expected: FAIL（`Cannot find module './taskInbox'`）

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/taskInbox.ts`：

```ts
import type { SubStatus, Task } from '../../types/app';

import { canOpenSession } from './taskActions';
import { deadlineInfo } from './taskDeadline';
import { SUB_STATUS_META } from './taskStatus';

export type AttentionAction = 'retry' | 'start' | 'accept' | 'openSession' | 'openTask';
export type AttentionTone = 'wait' | 'fail' | 'accept' | 'plan' | 'late';

export type AttentionItem = {
  task: Task;
  signal: SubStatus | 'overdue';
  label: string;
  tone: AttentionTone;
  action: AttentionAction;
};

/** 需要用户介入的 sub_status → 配色族。动作在 attentionItems 里按会话状态细化。 */
const SUB_SIGNAL_TONE: Partial<Record<SubStatus, AttentionTone>> = {
  failed: 'fail',
  waiting_answer: 'wait',
  waiting_plan: 'wait',
  waiting_approval: 'wait',
  pending_acceptance: 'accept',
  needs_review: 'wait',
  blocked: 'fail',
  only_plan: 'plan',
};

function actionFor(signal: SubStatus, task: Task): AttentionAction {
  switch (signal) {
    case 'failed':
      return 'retry';
    case 'pending_acceptance':
      return 'accept';
    default:
      // waiting_approval / waiting_answer / waiting_plan / needs_review / blocked / only_plan
      return canOpenSession(task) ? 'openSession' : 'openTask';
  }
}

export function attentionItems(tasks: Task[], now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of tasks) {
    const sub = task.sub_status;
    const tone = sub ? SUB_SIGNAL_TONE[sub] : undefined;
    if (sub && tone) {
      items.push({ task, signal: sub, label: SUB_STATUS_META[sub].label, tone, action: actionFor(sub, task) });
      continue;
    }
    // 纯逾期：无子状态信号，但 deadline 已过且未完成/归档。
    if (task.deadline && task.status !== 'done' && task.status !== 'archived') {
      const info = deadlineInfo(task.deadline, now);
      if (info.overdue) {
        items.push({
          task,
          signal: 'overdue',
          label: info.label,
          tone: 'late',
          action: task.status === 'todo' ? 'start' : canOpenSession(task) ? 'openSession' : 'openTask',
        });
      }
    }
  }
  return items;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskInbox.test.ts`
Expected: PASS（8 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add web/src/components/tasks/taskInbox.ts web/src/components/tasks/taskInbox.test.ts
git commit -m "feat(tasks): add attentionItems helper for needs-attention inbox"
```

---

### Task 2: `TaskInboxPanel` 组件（TDD）

**Files:**
- Create: `web/src/components/tasks/TaskInboxPanel.tsx`
- Test: `web/src/components/tasks/TaskInboxPanel.test.tsx`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/TaskInboxPanel.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Task } from '../../types/app';

import { TaskInboxPanel } from './TaskInboxPanel';

const NOW = new Date('2026-09-16T12:00:00');

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
  context_summary: null,
  source_schedule_id: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

test('renders nothing when no attention items', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, { tasks: [mkTask({ task_id: 't1' })], now: NOW }),
  );
  assert.equal(html, '');
});

test('renders header, title, signal, and action button per item', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [
        mkTask({ task_id: 'a1', title: '等待批准的任务', status: 'in_progress', sub_status: 'waiting_approval', session_id: 's1' }),
        mkTask({ task_id: 'f1', title: '失败的任务', status: 'in_progress', sub_status: 'failed' }),
      ],
      now: NOW,
      onOpenSession: () => {},
      onRetry: () => {},
    }),
  );
  assert.match(html, /data-testid="task-inbox"/);
  assert.match(html, /需要你处理/);
  assert.match(html, /等待批准的任务/);
  assert.match(html, /等你批准/);
  assert.match(html, /打开会话/);
  assert.match(html, /失败的任务/);
  assert.match(html, /↻ 重试/);
});

test('falls back to 查看 for a waiting signal without session', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'w1', status: 'in_progress', sub_status: 'waiting_approval' })],
      now: NOW,
      onOpenSession: () => {},
      onOpenTask: () => {},
    }),
  );
  assert.match(html, /查看/);
  assert.doesNotMatch(html, /打开会话/);
});

test('renders overdue todo with start action', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'o1', status: 'todo', deadline: '2026-09-15' })],
      now: NOW,
      onStart: () => {},
    }),
  );
  assert.match(html, /已逾期 1 天/);
  assert.match(html, /▶ 开始执行/);
});

test('omits the action button when the matching handler is not provided', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'f1', status: 'in_progress', sub_status: 'failed' })],
      now: NOW,
    }),
  );
  assert.match(html, /需要你处理/);
  assert.doesNotMatch(html, /↻ 重试/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx`
Expected: FAIL（`Cannot find module './TaskInboxPanel'`）

- [ ] **Step 3: 写实现**

创建 `web/src/components/tasks/TaskInboxPanel.tsx`：

```tsx
import { useMemo, type CSSProperties } from 'react';

import type { Task } from '../../types/app';

import type { TaskProjectOption } from './TaskCard';
import { attentionItems, type AttentionAction, type AttentionTone } from './taskInbox';

type TaskInboxPanelProps = {
  tasks: Task[];
  now: Date;
  projectOptions?: TaskProjectOption[];
  onRetry?: (task: Task) => void;
  onStart?: (task: Task) => void;
  onAccept?: (task: Task) => void;
  onOpenSession?: (task: Task) => void;
  onOpenTask?: (task: Task) => void;
};

const TONE_STYLE: Record<AttentionTone, CSSProperties> = {
  wait:   { color: '#92400e', backgroundColor: '#fef3c7', borderColor: '#fde68a' },
  fail:   { color: '#991b1b', backgroundColor: '#fee2e2', borderColor: '#fecaca' },
  accept: { color: '#7e22ce', backgroundColor: '#f3e8ff', borderColor: '#e9d5ff' },
  plan:   { color: '#1e40af', backgroundColor: '#dbeafe', borderColor: '#bfdbfe' },
  late:   { color: '#991b1b', backgroundColor: '#fee2e2', borderColor: '#fecaca' },
};

const ACTION_META: Record<AttentionAction, { label: string; className: string }> = {
  retry:       { label: '↻ 重试', className: 'bg-primary/10 text-primary hover:bg-primary/20' },
  start:       { label: '▶ 开始执行', className: 'bg-primary/10 text-primary hover:bg-primary/20' },
  accept:      { label: '✓ 标记完成', className: 'bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400' },
  openSession: { label: '打开会话', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
  openTask:    { label: '查看', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
};

function projectLabel(task: Task, projectOptions: TaskProjectOption[]): string {
  if (task.is_operator === 1) return '🤖 Lovdex助手';
  return projectOptions.find((o) => o.value === task.project_path)?.label ?? task.project_path;
}

export function TaskInboxPanel({
  tasks, now, projectOptions = [], onRetry, onStart, onAccept, onOpenSession, onOpenTask,
}: TaskInboxPanelProps) {
  const items = useMemo(() => attentionItems(tasks, now), [tasks, now]);
  if (items.length === 0) return null;

  const handlers: Record<AttentionAction, ((task: Task) => void) | undefined> = {
    retry: onRetry,
    start: onStart,
    accept: onAccept,
    openSession: onOpenSession,
    openTask: onOpenTask,
  };

  return (
    <div data-testid="task-inbox" className="flex flex-shrink-0 flex-col border-b border-border/60 bg-card">
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
        <span className="text-sm font-semibold text-foreground">需要你处理</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{items.length}</span>
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {items.map((item) => {
          const handler = handlers[item.action];
          return (
            <div key={item.task.task_id} className="flex items-center gap-2.5 px-3 py-2 sm:px-4">
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold"
                style={TONE_STYLE[item.tone]}
              >
                {item.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
                {item.task.title}
                <span className="ml-1.5 text-[11px] text-muted-foreground">{item.task.task_id}</span>
              </span>
              <span className="hidden shrink-0 max-w-40 truncate text-xs text-muted-foreground sm:inline">
                {projectLabel(item.task, projectOptions)}
              </span>
              {handler && (
                <button
                  type="button"
                  onClick={() => handler(item.task)}
                  className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${ACTION_META[item.action].className}`}
                >
                  {ACTION_META[item.action].label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add web/src/components/tasks/TaskInboxPanel.tsx web/src/components/tasks/TaskInboxPanel.test.tsx
git commit -m "feat(tasks): add TaskInboxPanel needs-attention section"
```

---

### Task 3: 接入 `TaskBoard` 顶部

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 加 import**

`TaskBoard.tsx` 的 import 区，`import { TaskTableView } from './TaskTableView';`（行 44）之后加一行：

```ts
import { TaskInboxPanel } from './TaskInboxPanel';
```

- [ ] **Step 2: 在筛选栏之后、视图之前插入组件**

找到唯一锚点行 `          {effectiveView === 'table' ? (`，把它替换为：

```tsx
          <TaskInboxPanel
            tasks={filteredTasks}
            now={now}
            projectOptions={projectOptions}
            onRetry={runTask}
            onStart={runTask}
            onAccept={(task) => updateStatus(task, 'done')}
            onOpenSession={(task) => task.session_id && navigate(`/session/${task.session_id}`)}
            onOpenTask={(task) => navigate(`/task/${task.task_id}`)}
          />
          {effectiveView === 'table' ? (
```

（`runTask` / `updateStatus` / `navigate` / `filteredTasks` / `now` / `projectOptions` 都已在该组件作用域内定义。）

- [ ] **Step 3: typecheck 确认**

Run: `cd web && npm run typecheck`
Expected: 0 errors

- [ ] **Step 4: 跑 tasks 目录既有测试确认不回归**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskInbox.test.ts src/components/tasks/TaskInboxPanel.test.tsx src/components/tasks/TaskCard.test.tsx src/components/tasks/TaskTableView.test.tsx 2>&1 | tail -8`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): surface needs-attention inbox atop task board"
```

---

### Task 4: 全量回归 + 收尾

**Files:** 无（验证 + 文档）

- [ ] **Step 1: web typecheck**

Run: `cd web && npm run typecheck`
Expected: 0 errors

- [ ] **Step 2: tasks 目录全量测试**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/*.test.ts src/components/tasks/*.test.tsx 2>&1 | tail -12`
Expected: 全 PASS（若 glob 展开失败，逐个跑 `src/components/tasks/` 下受影响的 `.test.ts`/`.test.tsx`）

- [ ] **Step 3: lint 改动文件（确认无新增 error）**

Run: `cd web && npx eslint src/components/tasks/taskInbox.ts src/components/tasks/TaskInboxPanel.tsx src/components/tasks/TaskBoard.tsx`
Expected: 无新增 error（存量 baseline 不算）

- [ ] **Step 4: 手工验收**

启动 dev（`cd web && npm run dev`），构造或等待一条 `sub_status` 为 `waiting_approval` / `failed` / `pending_acceptance` / 逾期的任务：
1. 顶部出现「需要你处理」段，每条含信号徽标 + 标题 + 动作按钮。
2. 点「重试」→ 走现有 `runTask`；点「标记完成」→ 状态变 done；点「打开会话」→ 跳对应会话。
3. 全部处理完 → 段自动消失。
4. 手机 &lt;640px → 看板顶部同样出现该段（同一组件）。

- [ ] **Step 5: 收尾 —— 更新 spec 状态**

`docs/superpowers/specs/2026-09-16-task-inbox-design.md` 顶部「状态」行改为「已实现 <commit>」。

- [ ] **Step 6: Commit 收尾**

```bash
git add docs/superpowers/specs/2026-09-16-task-inbox-design.md
git commit -m "docs(tasks): mark task inbox spec implemented"
```

---

## Self-Review

### Spec 覆盖

- [x] 纯函数 `attentionItems` + 类型 → Task 1
- [x] 信号集合（8 个 sub_status + 已逾期，`running`/`done` 不命中）→ Task 1 测试
- [x] 优先级：sub_status 信号 > 已逾期（不重复计）→ Task 1 测试 `failed + overdue counts once`
- [x] 动作映射（retry/start/accept/openSession/openTask，含 canOpenSession 兜底）→ Task 1 + Task 2
- [x] `only_plan → openSession`（不是 start）→ Task 1 `SUB_SIGNAL_TONE` + `actionFor` default 分支
- [x] 组件渲染 + 空态不渲染 → Task 2 测试
- [x] 接入 `TaskBoard` 顶部（filteredTasks / 看板表格共用 / 移动端同段）→ Task 3
- [x] 错误处理（非法 deadline 不逾期不抛错）→ 复用 `deadlineInfo`（内部已兜底，Task 1 测试 `deadline today`/未显式测非法格式，`deadlineInfo` 已有回归覆盖）
- [x] 测试清单 §8.1 / §8.2 → Task 1 / Task 2

### 占位符扫描

- 无 TBD / TODO / 「类似 Task N」——每个步骤含完整代码与命令。

### 类型一致性

- `AttentionItem.signal: SubStatus | 'overdue'`、`tone: 'wait'|'fail'|'accept'|'plan'|'late'`、`action` 枚举在 `taskInbox.ts` 定义，`TaskInboxPanel.tsx` 只 import 类型，一致。
- `TaskProjectOption` 从 `./TaskCard` 导出（`ScheduledTasksView.tsx` 同款 import），一致。
- `TaskBoard` 的 `onAccept={(task) => updateStatus(task, 'done')}`：`updateStatus(task, status)` 签名 `(task: Task, status: Task['status']) => Promise<void>`，赋给 `(task: Task) => void` 合法。
- `onOpenSession={(task) => task.session_id && navigate(...)}` 返回 `false | void`，赋给 `(task) => void` 合法（`TaskBoard` 已对 `TaskTableView` 用同款写法）。
