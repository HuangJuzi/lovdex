# 定时任务卡片视图（手机 Web 支持）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为定时任务列表增加手机 Web 适配——手机/平板宽度显示卡片，**桌面（≥1024px）保留原表格**。

**Architecture:** 只改 `ScheduledTasksView.tsx` 一个组件：**响应式双渲染**——原表格容器加 `hidden lg:block`，卡片网格容器加 `lg:hidden`（<1024px 显示卡片、≥1024px 显示表格），以及其测试。数据流不变——`ScheduledTasksPanel` 继续经 props 传 `tasks`/`projectOptions` 和四个回调；`scheduleLabel`/`projectLabel`/`formatAbsoluteTime` 全部复用。

> 注：早版计划把表格整体换成卡片，实施后用户确认桌面需保留表格，改为上述双渲染（commit 18089e3 前的实现已 amend）。

**Tech Stack:** React 18 + react-router-dom v6（Link）+ Tailwind CSS（语义色 token + `mobile-touch-target`），测试用 node:test + `renderToStaticMarkup`。

**测试命令**（必须在 `web/` 目录下运行，否则 react 会解析到 `~/.lovdex/lovdex-cli/node_modules` 旧副本导致渲染崩溃）：
```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```
**typecheck 命令**：
```bash
cd web && npx tsc --noEmit -p tsconfig.json
```

---

## 文件结构

- `web/src/components/tasks/ScheduledTasksView.tsx` — 改：原表格保留（套 `hidden lg:block`）+ 新增卡片网格（套 `lg:hidden`）；新增同文件子组件 `ScheduledTaskCard`、`FieldRow`、`ActionButton`、`statusBadge`。
- `web/src/components/tasks/ScheduledTasksView.test.tsx` — 改：正向断言覆盖双渲染 + 停用态 + 查看任务链接 + 徽标 + 空态（无互斥负向断言，表格列头含「自动执行」）。

---

### Task 1: 重写视图测试为卡片断言（红）

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksView.test.tsx`（整文件替换）

- [ ] **Step 1: 用下面的内容整体替换测试文件**

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { ScheduledTask } from '../../types/app';
import { ScheduledTasksView } from './ScheduledTasksView';

const baseTask: ScheduledTask = {
  schedule_id: 's1', title: '每日站会', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

const projectOptions = [{ value: '/proj', label: 'proj' }];
const noop = () => {};
const handlers = { onEdit: noop, onDelete: noop, onToggle: noop, onRunNow: noop };

function render(tasks: ScheduledTask[]) {
  return renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView tasks={tasks} projectOptions={projectOptions} {...handlers} />
    </StaticRouter>,
  );
}

test('renders task fields on the card', () => {
  const html = render([baseTask]);
  assert.match(html, /每日站会/);
  assert.match(html, /每天 09:00/);
  assert.match(html, /proj/);
  assert.match(html, /下次/);
});

test('shows 自动执行 badge for auto_run=1', () => {
  const html = render([baseTask]);
  assert.match(html, /自动执行/);
  assert.notMatch(html, /仅提醒/);
});

test('shows 仅提醒 badge for auto_run=0', () => {
  const html = render([{ ...baseTask, auto_run: 0 }]);
  assert.match(html, /仅提醒/);
  assert.notMatch(html, /自动执行/);
});

test('shows 已停用 badge and dimmed card when disabled', () => {
  const html = render([{ ...baseTask, enabled: 0 }]);
  assert.match(html, /已停用/);
  assert.match(html, /opacity-60/);
});

test('renders 查看任务 link when last_task_id exists', () => {
  const html = render([{ ...baseTask, last_task_id: 't9' }]);
  assert.match(html, /查看任务/);
  assert.match(html, /href="\/task\/t9"/);
});

test('shows — when no last task', () => {
  const html = render([baseTask]);
  assert.match(html, /—/);
});

test('renders empty state', () => {
  const html = render([]);
  assert.match(html, /暂无定时任务/);
});
```

> 说明：`下次` 时间用本地时区格式化，避免时区导致断言脆弱，只断言 label 存在；确切时间格式化已有 `taskTimestamp.ts` 自身逻辑覆盖。

- [ ] **Step 2: 运行测试，确认新断言失败**

Run:
```bash
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```
Expected: FAIL — 至少「查看任务 / href="/task/t9"」「已停用 / opacity-60」「仅提醒/自动执行 互斥」几个用例失败（当前实现是表格，没有这些元素）。

---

### Task 2: 实现卡片网格视图（绿）

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksView.tsx`（整文件替换）

- [ ] **Step 1: 用下面的内容整体替换组件文件**

```tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Pencil, Play, Power, Trash2 } from 'lucide-react';

import type { ScheduledTask } from '../../types/app';
import { scheduleLabel } from '../../utils/scheduleLabel';
import type { TaskProjectOption } from './TaskCard';
import { formatAbsoluteTime } from './taskTimestamp';

export type ScheduledTasksViewProps = {
  tasks: ScheduledTask[];
  projectOptions: TaskProjectOption[];
  onEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask) => void;
  onRunNow: (task: ScheduledTask) => void;
};

type ScheduledTaskCardProps = ScheduledTasksViewProps & { task: ScheduledTask };

function projectLabel(task: ScheduledTask, projectOptions: TaskProjectOption[]): string {
  if (task.is_operator === 1 || !task.project_path) return '🤖 Lovdex助手';
  const opt = projectOptions.find((o) => o.value === task.project_path);
  return opt?.label ?? task.project_path;
}

function statusBadge(task: ScheduledTask) {
  if (task.enabled === 0) {
    return <span className="rounded-full bg-muted px-2 py-0.5 font-semibold text-muted-foreground">⏸ 已停用</span>;
  }
  return task.auto_run === 1 ? (
    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-600 dark:text-emerald-400">✅ 自动执行</span>
  ) : (
    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-600 dark:text-amber-400">🔔 仅提醒</span>
  );
}

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>{label}</span>
      <span className="text-right font-medium text-card-foreground">{value}</span>
    </div>
  );
}

function ActionButton({ title, label, className, onClick, children }: {
  title: string; label: string; className: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button title={title} aria-label={label} onClick={onClick} className={`mobile-touch-target rounded-lg px-2 py-1 ${className}`}>{children}</button>
  );
}

function ScheduledTaskCard({ task, projectOptions, onEdit, onDelete, onToggle, onRunNow }: ScheduledTaskCardProps) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm ${task.enabled === 0 ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-card-foreground">{task.title}</span>
        {statusBadge(task)}
      </div>
      <FieldRow label="调度" value={<><CalendarClock className="mr-1 inline h-3 w-3" />{scheduleLabel(task)}</>} />
      <FieldRow label="项目" value={projectLabel(task, projectOptions)} />
      <FieldRow label="下次" value={<span className="font-mono text-[11px]">{formatAbsoluteTime(task.next_run_at)}</span>} />
      <FieldRow
        label="上次"
        value={task.last_task_id ? <Link className="text-primary underline" to={`/task/${task.last_task_id}`}>查看任务</Link> : '—'}
      />
      <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
        <ActionButton title="立即触发" label="立即触发" className="text-sky-600 hover:bg-sky-500/10" onClick={() => onRunNow(task)}><Play className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title={task.enabled === 1 ? '停用' : '启用'} label="启停" className="text-muted-foreground hover:bg-muted" onClick={() => onToggle(task)}><Power className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="编辑" label="编辑" className="text-muted-foreground hover:bg-muted" onClick={() => onEdit(task)}><Pencil className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="删除" label="删除" className="text-red-500 hover:bg-red-500/10" onClick={() => onDelete(task)}><Trash2 className="h-3.5 w-3.5" /></ActionButton>
      </div>
    </div>
  );
}

export function ScheduledTasksView({ tasks, projectOptions, onEdit, onDelete, onToggle, onRunNow }: ScheduledTasksViewProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <div className="text-sm text-muted-foreground">暂无定时任务</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between px-3 py-2 sm:px-4">
        <span className="text-sm font-semibold text-foreground">⏰ 定时任务</span>
      </div>
      <div className="grid min-h-0 w-full auto-rows-min flex-1 grid-cols-1 gap-3 overflow-y-auto px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:grid-cols-3">
        {tasks.map((task) => (
          <ScheduledTaskCard key={task.schedule_id} task={task} projectOptions={projectOptions} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onRunNow={onRunNow} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 运行测试，确认全部通过**

Run:
```bash
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```
Expected: 7 个用例全部 PASS（`# pass 7`）。

- [ ] **Step 3: 跑全量前端任务相关测试，确认没有其他组件依赖表格渲染**

Run:
```bash
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks
```
Expected: 该目录下所有测试通过。

- [ ] **Step 4: typecheck**

Run:
```bash
cd web && npx tsc --noEmit -p tsconfig.json
```
Expected: 不新增错误（如仓库有历史遗留错误，确保不含本任务涉及的文件）。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/tasks/ScheduledTasksView.tsx web/src/components/tasks/ScheduledTasksView.test.tsx
git commit -m "feat(tasks): scheduled tasks as responsive card grid

去掉 900px 横向滚动表格，改为响应式卡片（手机单列/sm 两列/lg 三列）；
新增停用态、状态徽标、「查看任务」链接及对应测试。"
```

---

### Task 3: 手动验证（浏览器）

**Files:** 无

- [ ] **Step 1: dev server 确认列表在手机宽度显示单列卡片**

Run `web` dev server（如未在跑：`cd web && npm run dev`），在手机/窄窗口打开任务页 → 定时任务视图，确认：
1. 卡片单列、无横向滚动；字段分行（调度/项目/下次/上次）清晰。
2. 自动执行 / 仅提醒 / 已停用（停用后整卡变淡）三种徽标正确。
3. 有 `last_task_id` 的卡片点「查看任务」跳到对应任务详情。
4. 桌面（≥1024px）3 列网格。