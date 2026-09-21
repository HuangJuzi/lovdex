# 定时任务页「运行记录」子标签 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有的 `?view=scheduled` 定时任务页里加一层「调度 / 运行记录」子标签，让定时任务跑出来的任务（`tasks.source_schedule_id` 非空）有一个独立的查看入口。

**Architecture:** 纯前端改动，**零后端改动、零新增请求**。`TaskBoardPage` 已有的 `useTasks({}, subscribe)` 就是全量任务（含 archived）且带 ws 实时更新，按 `source_schedule_id` 过滤即得运行记录；调度名映射复用面板里 `useScheduledTasks` 已拉到的列表。子标签的 state 上提到 `TaskBoardPage`（URL 播种只能在页面层做，且 `useLocalStorage` 没有跨实例同步），面板只负责渲染。运行记录是一个纯展示组件 —— 所有数据走 props，不发请求，因此能被 `renderToStaticMarkup` 静态测试。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind。测试是 `node:test` + `node:assert/strict`，组件用 `react-dom/server` 的 `renderToStaticMarkup` 做静态标记冒烟 —— **没有 DOM**，effect 与交互都不执行，所以所有逻辑都要抽成纯函数才能测。

**Spec:** `docs/superpowers/specs/2026-09-21-scheduled-run-history-design.md`

---

## 环境准备（每个任务开始前都要做）

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH          # 全局 export 的 server/tsconfig.json 会让 npx tsx 读错配置
```

**基线数字（2026-09-21 实测，改动前）：**

| 检查 | 基线 |
|---|---|
| `npm run typecheck` | **0 个错误**（web 侧是干净的，验收判据是保持 0） |
| `npx eslint src/components/tasks/TaskBoard.tsx` | 0 problems |
| `npx eslint src/components/tasks/ScheduledTasksPanel.tsx` | 1 problem |
| `npx eslint src/components/tasks/ScheduledTasksView.tsx` | 2 problems |
| `npx eslint src/components/tasks/TaskDetail.tsx` | 8 problems |
| `npx eslint src/components/tasks/ScheduledTasksView.test.tsx` | 1 problem |

**读数字要看 eslint 的汇总行，别用 `grep -c` 数行** —— 末尾的「0 errors and 1 warning potentially fixable」也含 `warning` 字样，会数错：

```bash
npx eslint <file> 2>&1 | grep -E '^✖'
```

**验收判据是「这几个文件的数字不增加」，不是「仓库总数为 0」** —— 仓库里有另一个 session 在并发改文件，总数每次跑都不一样。

**预期会多 2 条警告**：新文件 `ScheduledTabBar.tsx` 与 `ScheduledRunHistoryView.tsx` 都会各带 1 条 `import-x/order`（该规则要求 import 分组之间空行，仓库里 `ScheduledTasksPanel.tsx:6`、`ScheduledTasksView.tsx:6` 的同类警告就是这么来的）。写的时候按下面代码块的空行分组写就不会触发。

**提交注意：** 工作区被两个 session 共用。提交一律用**单条原子命令带 pathspec**，别用 `git commit --amend`（HEAD 可能已经被对方移走了）：

```bash
git add <file> && git commit -m "<msg>" -- <file>
```

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/components/tasks/projectLabel.ts` | 新建 | `projectLabel()` 从 `ScheduledTasksView` 抽出，供调度列表与运行记录两个视图共用 |
| `web/src/components/tasks/projectLabel.test.ts` | 新建 | 上面这个纯函数的单测 |
| `web/src/components/tasks/ScheduledTabBar.tsx` | 新建 | 纯展示的「调度 / 运行记录」子标签条 + `ScheduledTab` 类型 |
| `web/src/components/tasks/ScheduledTabBar.test.tsx` | 新建 | 静态标记测试 |
| `web/src/components/tasks/ScheduledRunHistoryView.tsx` | 新建 | 运行记录视图（桌面表格 + 移动卡片）+ 三个纯函数 `runsOf` / `scheduleTitleOf` / `sortRunsByTriggeredDesc` |
| `web/src/components/tasks/ScheduledRunHistoryView.test.tsx` | 新建 | 上面纯函数与视图的静态标记测试 |
| `web/src/components/tasks/ScheduledTasksView.tsx` | 改 | 删掉静态标题行（让位给子标签条）；`projectLabel` 改为 import |
| `web/src/components/tasks/ScheduledTasksPanel.tsx` | 改 | 子标签条 + 按 tab 分流；hook 解构改名 `tasks` → `schedules`；新增 `tasks` / `tab` / `onTabChange` 三个 prop |
| `web/src/components/tasks/TaskBoard.tsx` | 改 | 新增 `scheduledTab` state + URL 播种；把 `tasks` / `tab` / `onTabChange` 传进面板 |
| `web/src/components/tasks/TaskDetail.tsx` | 改 | 「⏰ 定时」徽标深链补 `&tab=runs` |

**不改**：后端任何文件、`web/src/types/app.ts`、`TaskTableView.tsx`（它那套 sort / selection / 状态 pill 的 state 全绑在 `useLocalStorage` 上，复用到第二个位置会撞 key）、`taskFilter` / `TaskFilterBar`、助手工具。

---

## Task 1: 抽出 `projectLabel` 共享纯函数

调度列表和运行记录都要把 `project_path` 渲染成显示名，现在这段逻辑内联在 `ScheduledTasksView.tsx:21-25`。先抽出来，避免第二个视图复制一遍。

**Files:**
- Create: `web/src/components/tasks/projectLabel.ts`
- Create: `web/src/components/tasks/projectLabel.test.ts`
- Modify: `web/src/components/tasks/ScheduledTasksView.tsx:21-25`（删本地函数）、`web/src/components/tasks/ScheduledTasksView.tsx:1-8`（加 import）

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/projectLabel.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectLabel } from './projectLabel';

const options = [{ value: '/proj', label: 'proj' }];

test('is_operator=1 归一成助手标签', () => {
  assert.equal(projectLabel({ is_operator: 1, project_path: '/proj' }, options), '🤖 Lovdex助手');
});

test('无项目路径归一成助手标签', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: null }, options), '🤖 Lovdex助手');
});

test('命中 projectOptions 时用 label', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: '/proj' }, options), 'proj');
});

test('未命中 projectOptions 时回退完整路径', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: '/other' }, options), '/other');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --test src/components/tasks/projectLabel.test.ts
```

Expected: FAIL —— `Cannot find module './projectLabel'`（模块还不存在）。

- [ ] **Step 3: 写实现**

创建 `web/src/components/tasks/projectLabel.ts`：

```ts
import type { TaskProjectOption } from './TaskCard';

/**
 * 项目列的显示文案。`is_operator === 1`（Lovdex 助手任务）与「没有项目路径」
 * 都归一成助手标签；否则查 projectOptions，查不到就回退完整路径。
 *
 * 参数用结构化类型而不是 `Task` / `ScheduledTask`：调度列表和任务运行记录
 * 都要用，两者都有这两个字段（Task 的 `project_path` 是非空的 string，可以
 * 赋给 `string | null`）。
 */
export function projectLabel(
  item: { is_operator: number; project_path: string | null },
  projectOptions: TaskProjectOption[],
): string {
  if (item.is_operator === 1 || !item.project_path) return '🤖 Lovdex助手';
  const opt = projectOptions.find((o) => o.value === item.project_path);
  return opt?.label ?? item.project_path;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --test src/components/tasks/projectLabel.test.ts
```

Expected: PASS —— 4 个 test 全绿（`# pass 4`）。

- [ ] **Step 5: 让 `ScheduledTasksView` 改用共享函数**

在 `web/src/components/tasks/ScheduledTasksView.tsx` 中**删除**第 21-25 行这个本地函数：

```tsx
function projectLabel(task: ScheduledTask, projectOptions: TaskProjectOption[]): string {
  if (task.is_operator === 1 || !task.project_path) return '🤖 Lovdex助手';
  const opt = projectOptions.find((o) => o.value === task.project_path);
  return opt?.label ?? task.project_path;
}
```

并在 import 区（第 5-8 行那段）按字母序插入一行 —— `projectLabel` 排在 `taskTimestamp` 之前：

```tsx
import { projectLabel } from './projectLabel';
import { formatAbsoluteTime } from './taskTimestamp';
```

（`import type { TaskProjectOption } from './TaskCard';` 保留 —— props 类型还要用。）

- [ ] **Step 6: 跑回归，确认行为没变**

```bash
npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
npx tsx --test src/components/tasks/projectLabel.test.ts
```

Expected: 两个文件都全绿。`ScheduledTasksView.test.tsx` 里的 `assert.match(html, /proj/)` 就是在断言这个函数的输出，它绿了就说明抽取没改行为。

- [ ] **Step 7: typecheck + lint**

```bash
npm run typecheck
npx eslint src/components/tasks/ScheduledTasksView.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck 0 错误；eslint 仍是 **2 problems**（与基线一致，没多没少）。

- [ ] **Step 8: 提交**

```bash
git add web/src/components/tasks/projectLabel.ts web/src/components/tasks/projectLabel.test.ts web/src/components/tasks/ScheduledTasksView.tsx && git commit -m "refactor(tasks): extract projectLabel into a shared module" -- web/src/components/tasks/projectLabel.ts web/src/components/tasks/projectLabel.test.ts web/src/components/tasks/ScheduledTasksView.tsx
```

---

## Task 2: 运行记录视图 `ScheduledRunHistoryView`

新建运行记录视图。三个纯函数负责「过滤 / 调度名映射 / 排序」，全部导出以便单测（web 测试没有 DOM，逻辑必须离开组件才能测）；组件本体只做渲染。

**Files:**
- Create: `web/src/components/tasks/ScheduledRunHistoryView.tsx`
- Test: `web/src/components/tasks/ScheduledRunHistoryView.test.tsx`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/ScheduledRunHistoryView.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { ScheduledTask, Task } from '../../types/app';
import {
  ScheduledRunHistoryView,
  runsOf,
  scheduleTitleOf,
  sortRunsByTriggeredDesc,
} from './ScheduledRunHistoryView';

const baseTask: Task = {
  task_id: 't1',
  project_path: '/proj',
  title: '每日巡检',
  description: null,
  status: 'done',
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
  context_source_session_id: null,
  context_mode: 'none',
  context_status: null,
  context_raw: null,
  source_schedule_id: 's1',
  created_at: '2026-08-14T09:00:00.000Z',
  updated_at: '2026-08-14T09:00:00.000Z',
};

const baseSchedule: ScheduledTask = {
  schedule_id: 's1', title: '每天早上九点', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-15T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

const projectOptions = [{ value: '/proj', label: 'proj' }];

function render(runs: Task[], schedules: ScheduledTask[] = [baseSchedule]) {
  return renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled&tab=runs">
      <ScheduledRunHistoryView runs={runs} schedules={schedules} projectOptions={projectOptions} />
    </StaticRouter>,
  );
}

test('runsOf 只保留 source_schedule_id 非空的任务', () => {
  const manual = { ...baseTask, task_id: 't2', source_schedule_id: null };
  const runs = runsOf([baseTask, manual]);
  assert.deepEqual(runs.map((t) => t.task_id), ['t1']);
});

test('sortRunsByTriggeredDesc 按触发时间倒序，且不改原数组', () => {
  const older = { ...baseTask, task_id: 'old', created_at: '2026-08-13 09:00:00' };
  const newer = { ...baseTask, task_id: 'new', created_at: '2026-08-15 09:00:00' };
  const input = [older, newer];
  assert.deepEqual(sortRunsByTriggeredDesc(input).map((t) => t.task_id), ['new', 'old']);
  assert.deepEqual(input.map((t) => t.task_id), ['old', 'new']);
});

test('scheduleTitleOf 命中调度时返回标题，查不到回退占位文案', () => {
  assert.equal(scheduleTitleOf('s1', [baseSchedule]), '每天早上九点');
  assert.equal(scheduleTitleOf('gone', [baseSchedule]), '已删除的调度');
  assert.equal(scheduleTitleOf(null, [baseSchedule]), '已删除的调度');
});

test('渲染桌面表格与移动卡片，含运行记录特有的列', () => {
  const html = render([baseTask]);
  // 桌面表格（lg+ 显示）及其列头
  assert.match(html, /hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block/);
  assert.match(html, /所属调度/);
  assert.match(html, /触发时间/);
  // 移动/平板卡片（<lg 显示）
  assert.match(html, /lg:hidden/);
  // 内容：标题、调度名、项目名、状态
  assert.match(html, /每日巡检/);
  assert.match(html, /每天早上九点/);
  assert.match(html, /proj/);
  assert.match(html, /已完成/);
});

test('调度已删除时渲染占位文案', () => {
  const html = render([{ ...baseTask, source_schedule_id: 'gone' }]);
  assert.match(html, /已删除的调度/);
});

test('任务可跟进的会话才渲染「打开会话」', () => {
  const openable = render([{ ...baseTask, status: 'in_progress', session_id: 'sess-1' }]);
  assert.match(openable, /打开会话/);
  assert.match(openable, /href="\/session\/sess-1"/);

  // status=done 且没有 session：canOpenSession 为 false
  const closed = render([baseTask]);
  assert.doesNotMatch(closed, /打开会话/);
});

test('始终渲染「打开任务」链接', () => {
  const html = render([baseTask]);
  assert.match(html, /打开任务/);
  assert.match(html, /href="\/task\/t1"/);
});

test('空列表渲染空态', () => {
  const html = render([]);
  assert.match(html, /暂无运行记录/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --test src/components/tasks/ScheduledRunHistoryView.test.tsx
```

Expected: FAIL —— `Cannot find module './ScheduledRunHistoryView'`。

- [ ] **Step 3: 写纯函数与组件**

创建 `web/src/components/tasks/ScheduledRunHistoryView.tsx`：

```tsx
import { Link } from 'react-router-dom';

import type { ScheduledTask, Task } from '../../types/app';

import { projectLabel } from './projectLabel';
import { canOpenSession } from './taskActions';
import type { TaskProjectOption } from './TaskCard';
import { STATUS_META } from './taskStatus';
import { SubStatusBadge } from './SubStatusBadge';
import { formatAbsoluteTime } from './taskTimestamp';

export type ScheduledRunHistoryViewProps = {
  /** 已过滤的运行记录（`source_schedule_id` 非空）。 */
  runs: Task[];
  /** 调度列表，用于 `schedule_id → title` 映射。 */
  schedules: ScheduledTask[];
  projectOptions: TaskProjectOption[];
};

const DELETED_SCHEDULE = '已删除的调度';

/** 定时来源过滤。删调度不会删它跑出来的任务，所以过滤条件只看任务自身的字段。 */
export function runsOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.source_schedule_id);
}

/** 「所属调度」列：调度被删掉后任务行仍在，回退成占位文案。 */
export function scheduleTitleOf(scheduleId: string | null, schedules: ScheduledTask[]): string {
  if (!scheduleId) return DELETED_SCHEDULE;
  return schedules.find((s) => s.schedule_id === scheduleId)?.title ?? DELETED_SCHEDULE;
}

/**
 * 触发时间倒序。后端时间戳是定长裸 UTC（`YYYY-MM-DD HH:MM:SS`），字典序即时序，
 * 所以直接比字符串，不用 `Date`（对齐 taskTimestamp.ts 的约定）。
 */
export function sortRunsByTriggeredDesc(runs: Task[]): Task[] {
  return [...runs].sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1));
}

function StatusCell({ task }: { task: Task }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: STATUS_META[task.status].color }} />
      <span className="text-xs text-muted-foreground">{STATUS_META[task.status].label}</span>
      <SubStatusBadge subStatus={task.sub_status} />
    </span>
  );
}

function OpenActions({ task }: { task: Task }) {
  return (
    <div className="inline-flex items-center gap-1">
      <Link
        className="whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold text-primary hover:bg-primary/10"
        to={`/task/${task.task_id}`}
      >
        打开任务
      </Link>
      {canOpenSession(task) && (
        <Link
          className="whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold text-info hover:bg-info/10"
          to={`/session/${task.session_id}`}
        >
          打开会话
        </Link>
      )}
    </div>
  );
}

/**
 * 定时任务的运行记录：这个调度跑出来的那些任务。只读查看 + 跳转，不做排序 / 多选 /
 * 批量删除，也不套用任务页的筛选栏（定时视图本来就没有筛选栏）。
 */
export function ScheduledRunHistoryView({ runs, schedules, projectOptions }: ScheduledRunHistoryViewProps) {
  if (runs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <div className="text-sm text-muted-foreground">暂无运行记录</div>
      </div>
    );
  }

  const ordered = sortRunsByTriggeredDesc(runs);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Desktop table (≥1024px)；移动/平板用下方卡片。 */}
      <div className="hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block">
        <table className="w-full min-w-[900px] border-separate text-sm" style={{ borderSpacing: '0 7px' }}>
          <thead>
            <tr>
              {['标题', '所属调度', '项目', '状态', '触发时间', '操作'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 pb-1 text-left text-xs font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((task) => (
              <tr key={task.task_id} className="bg-card shadow-sm">
                <td className="rounded-l-lg px-4 py-3 font-semibold text-card-foreground [overflow-wrap:anywhere]">{task.title}</td>
                {/* 调度名与项目名都可能是不含空格的完整路径，截断 + title 兜底，
                    避免把表推出横向滚动（沿用 ScheduledTasksView 的同类处理）。 */}
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <span className="block max-w-40 truncate" title={scheduleTitleOf(task.source_schedule_id, schedules)}>
                    {scheduleTitleOf(task.source_schedule_id, schedules)}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <span className="block max-w-40 truncate" title={projectLabel(task, projectOptions)}>
                    {projectLabel(task, projectOptions)}
                  </span>
                </td>
                <td className="px-4 py-3"><StatusCell task={task} /></td>
                <td className="px-4 py-3 font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</td>
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right"><OpenActions task={task} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile/tablet cards (<1024px) */}
      <div className="grid min-h-0 w-full auto-rows-min flex-1 grid-cols-1 gap-3 overflow-y-auto px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:hidden">
        {ordered.map((task) => (
          <div key={task.task_id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm">
            <span className="line-clamp-2 overflow-hidden text-sm font-semibold text-card-foreground">{task.title}</span>
            <span className="truncate text-xs text-muted-foreground">{scheduleTitleOf(task.source_schedule_id, schedules)}</span>
            <div className="self-start"><StatusCell task={task} /></div>
            <span className="font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</span>
            <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
              <OpenActions task={task} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --test src/components/tasks/ScheduledRunHistoryView.test.tsx
```

Expected: PASS —— 8 个 test 全绿。

若「已完成」断言失败，先确认 `taskStatus.ts:7` 的 `STATUS_META.done.label` 实际文案，以库里的为准改断言（别改实现）。

- [ ] **Step 5: typecheck + lint**

```bash
npm run typecheck
npx eslint src/components/tasks/ScheduledRunHistoryView.tsx src/components/tasks/ScheduledRunHistoryView.test.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck 0 错误；eslint 若报 `import-x/order`，按报错行在 import 分组之间补空行（上面代码块已按组分好，正常应报 0）。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/tasks/ScheduledRunHistoryView.tsx web/src/components/tasks/ScheduledRunHistoryView.test.tsx && git commit -m "feat(scheduled-tasks): add the run-history view" -- web/src/components/tasks/ScheduledRunHistoryView.tsx web/src/components/tasks/ScheduledRunHistoryView.test.tsx
```

---

## Task 3: 子标签条 `ScheduledTabBar`

单独成文件而不是内联进面板：它要能在没有 DOM 的测试环境里被静态断言，而 `ScheduledTasksPanel` 依赖 `useWebSocket` context，渲染不起来。

**Files:**
- Create: `web/src/components/tasks/ScheduledTabBar.tsx`
- Test: `web/src/components/tasks/ScheduledTabBar.test.tsx`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/ScheduledTabBar.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScheduledTabBar } from './ScheduledTabBar';

function render(tab: 'schedules' | 'runs') {
  return renderToStaticMarkup(<ScheduledTabBar tab={tab} onChange={() => {}} />);
}

test('渲染两个子标签', () => {
  const html = render('schedules');
  assert.match(html, /调度/);
  assert.match(html, /运行记录/);
});

test('当前子标签带 aria-pressed=true，另一个为 false', () => {
  const schedules = render('schedules');
  assert.equal((schedules.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((schedules.match(/aria-pressed="false"/g) ?? []).length, 1);

  const runs = render('runs');
  assert.equal((runs.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((runs.match(/aria-pressed="false"/g) ?? []).length, 1);
});

test('激活态与未激活态用不同的样式类', () => {
  const html = render('runs');
  assert.match(html, /bg-card text-card-foreground shadow-raised-sm/);
  assert.match(html, /text-muted-foreground hover:text-foreground/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --test src/components/tasks/ScheduledTabBar.test.tsx
```

Expected: FAIL —— `Cannot find module './ScheduledTabBar'`。

- [ ] **Step 3: 写实现**

创建 `web/src/components/tasks/ScheduledTabBar.tsx`：

```tsx
import { cn } from '../../lib/utils';

export type ScheduledTab = 'schedules' | 'runs';

const TABS: { value: ScheduledTab; label: string }[] = [
  { value: 'schedules', label: '调度' },
  { value: 'runs', label: '运行记录' },
];

/**
 * 定时任务页的子标签。视觉对齐任务页 header 的视图切换器（TaskBoard.tsx 的
 * 「看板 / 表格 / ⏰ 定时」）：同一个分段控件外壳 + 选中态实色胶囊。
 *
 * 它占的是 ScheduledTasksView 原来那行静态标题「⏰ 定时任务」的位置 —— 那行标题
 * 已被删掉，避免和子标签条叠成两行 chrome。
 */
export function ScheduledTabBar({ tab, onChange }: { tab: ScheduledTab; onChange: (next: ScheduledTab) => void }) {
  return (
    <div className="flex flex-shrink-0 items-center px-3 py-2 sm:px-4">
      <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
        {TABS.map(({ value, label }) => {
          const isActive = tab === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isActive}
              onClick={() => {
                if (!isActive) onChange(value);
              }}
              className={cn(
                'rounded-lg px-2.5 py-2 text-sm font-normal transition-all',
                isActive
                  ? 'bg-card text-card-foreground shadow-raised-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --test src/components/tasks/ScheduledTabBar.test.tsx
```

Expected: PASS —— 3 个 test 全绿。

- [ ] **Step 5: typecheck + lint**

```bash
npm run typecheck
npx eslint src/components/tasks/ScheduledTabBar.tsx src/components/tasks/ScheduledTabBar.test.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck 0 错误；eslint 0 problems。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/tasks/ScheduledTabBar.tsx web/src/components/tasks/ScheduledTabBar.test.tsx && git commit -m "feat(scheduled-tasks): add the schedules/runs sub-tab bar" -- web/src/components/tasks/ScheduledTabBar.tsx web/src/components/tasks/ScheduledTabBar.test.tsx
```

---

## Task 4: 接线（面板子标签分流 + 页面传参）

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksView.tsx`（删标题行）
- Modify: `web/src/components/tasks/ScheduledTasksPanel.tsx`
- Modify: `web/src/components/tasks/TaskBoard.tsx`

> **为什么这三处合并成一个任务、一次提交：** `ScheduledTasksPanel` 的新 prop 是必填的，改完面板 `TaskBoard.tsx` 立刻 typecheck 不过。分两次提交会在共用工作区里留一个红提交（另一个 session 可能正在同一个工作区里跑检查）。三处一起改完再提交，每个提交都是绿的。

- [ ] **Step 1: 删掉 `ScheduledTasksView` 的静态标题行**

在 `web/src/components/tasks/ScheduledTasksView.tsx` 的 `return` 里**删除**这 3 行（第 91-93 行）：

```tsx
      <div className="flex flex-shrink-0 items-center justify-between px-3 py-2 sm:px-4">
        <span className="text-sm font-semibold text-foreground">⏰ 定时任务</span>
      </div>
```

删完后 `return` 的第一层 `div`（`className="flex min-h-0 flex-1 flex-col"`）里直接就是桌面表格那个 div。**内边距由 `ScheduledTabBar` 沿用同一套 `px-3 py-2 sm:px-4`，纵向占位不变。**

- [ ] **Step 2: 改 `ScheduledTasksPanel`**

把 `web/src/components/tasks/ScheduledTasksPanel.tsx` 的 **import 区与组件签名/渲染**改成下面这样（`submit` / `remove` / `toggle` / `runNow` / `openNew` / `openEdit` 五个函数体**不动**）：

```tsx
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useScheduledTasks } from '../../hooks/useScheduledTasks';
import type { ScheduledTask, Task } from '../../types/app';
import { api } from '../../utils/api';
import { ScheduledRunHistoryView, runsOf } from './ScheduledRunHistoryView';
import { ScheduledTabBar, type ScheduledTab } from './ScheduledTabBar';
import { ScheduledTaskForm, toApiBody, type ScheduledTaskDraft } from './ScheduledTaskForm';
import { ScheduledTasksView } from './ScheduledTasksView';
import type { TaskProjectOption } from './TaskCard';

export type ScheduledTasksPanelHandle = {
  openNew: () => void;
};

export type ScheduledTasksPanelProps = {
  projectOptions: TaskProjectOption[];
  /** 任务页的全量任务列表（TaskBoard 的 useTasks），运行记录从这里过滤出来。 */
  tasks: Task[];
  tab: ScheduledTab;
  onTabChange: (next: ScheduledTab) => void;
};

export const ScheduledTasksPanel = forwardRef<ScheduledTasksPanelHandle, ScheduledTasksPanelProps>(
  function ScheduledTasksPanel({ projectOptions, tasks, tab, onTabChange }, ref) {
  const { subscribe } = useWebSocket();
  // 注意改名：hook 解构出来的字段本来就叫 `tasks`，但那是**调度**列表
  // （ScheduledTask[]），跟 props 里传进来的**任务**列表（Task[]）同名。
  const { tasks: schedules, loading, loadError, refresh } = useScheduledTasks({}, subscribe);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  // 连击守卫。用同步的 ref 而不是 submitting state：setState 要等下一轮渲染才生效，
  // 同一 tick 里（双击、Enter 连击）的第二次调用读到的还是旧值。标题留空时后端要等
  // 模型取名（最长 3s），这个窗口期足够双击两次。
  const submittingRef = useRef(false);

  const runs = useMemo(() => runsOf(tasks), [tasks]);

  const openNew = useCallback(() => { setEditing(null); setError(null); setFormKey((k) => k + 1); setFormOpen(true); }, []);
  // 供全局「新建任务」按钮在定时视图下直接唤起新建定时任务表单。
  useImperativeHandle(ref, () => ({ openNew }), [openNew]);
  const openEdit = (t: ScheduledTask) => { setEditing(t); setError(null); setFormKey((k) => k + 1); setFormOpen(true); };
```

（下面 `submit` / `remove` / `toggle` / `runNow` 四个函数原样保留。）

然后把原来的 `if (loading) ...` / `if (loadError) ...` 两段早返回**换成**下面这段 —— 加载与失败只挡「调度」子标签：运行记录不依赖调度请求，调度列表还在路上时它照样能看，只是「所属调度」列暂时全部回退成占位文案。

```tsx
  let body;
  if (tab === 'runs') {
    body = <ScheduledRunHistoryView runs={runs} schedules={schedules} projectOptions={projectOptions} />;
  } else if (loading) {
    body = <div className="px-3 text-sm text-muted-foreground sm:px-6">加载中…</div>;
  } else if (loadError) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <div className="text-sm text-muted-foreground">加载定时任务失败</div>
        <button className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90" onClick={() => void refresh()}>重试</button>
      </div>
    );
  } else {
    body = (
      <ScheduledTasksView
        tasks={schedules}
        projectOptions={projectOptions}
        onEdit={openEdit}
        onDelete={(t) => void remove(t)}
        onToggle={(t) => void toggle(t)}
        onRunNow={(t) => void runNow(t)}
      />
    );
  }

  return (
    <>
      <ScheduledTabBar tab={tab} onChange={onTabChange} />
      {body}
      <ScheduledTaskForm key={formKey} open={formOpen} initial={editing} projectOptions={projectOptions} submitting={submitting} error={error} onClose={() => { if (!submittingRef.current) setFormOpen(false); }} onSubmit={(d) => void submit(d)} />
    </>
  );
});
```

- [ ] **Step 3: 给 `TaskBoard` 加 state 与 import**

在 import 区（第 24 行 `ScheduledTasksPanel` 那行之后）加：

```tsx
import type { ScheduledTab } from './ScheduledTabBar';
```

在 `viewMode` 那个 `useLocalStorage`（第 36 行）之后加：

```tsx
  // 定时页的子标签（调度 / 运行记录）。与 viewMode 一样持久化；URL 上的
  // `?tab=runs` 优先，见下面的挂载 effect。
  const [scheduledTab, setScheduledTab] = useLocalStorage<ScheduledTab>('scheduledViewTab', 'schedules');
```

- [ ] **Step 4: 扩 URL 播种 effect**

把第 47-52 行那个 effect 改成：

```tsx
  // 侧边栏「定时任务」入口带 ?view=scheduled 进来时，启动选中定时视图；带上
  // ?tab=runs 时再落到运行记录子标签。URL 优先于 localStorage，但仅在挂载时读一次。
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('view') === 'scheduled') {
      setViewMode('scheduled');
      if (searchParams.get('tab') === 'runs') setScheduledTab('runs');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 5: 传参**

把第 411 行：

```tsx
            <ScheduledTasksPanel ref={scheduledPanelRef} projectOptions={projectOptions} />
```

改成：

```tsx
            <ScheduledTasksPanel
              ref={scheduledPanelRef}
              projectOptions={projectOptions}
              tasks={tasks}
              tab={scheduledTab}
              onTabChange={setScheduledTab}
            />
```

（`tasks` 是第 33 行 `useTasks` 返回的全量列表 —— 它没有 `projectPath` / `status` 参数，含 archived，且随 ws 事件实时更新，所以运行记录自动跟着刷新。**不要**传 `filteredTasks`：运行记录不套用任务筛选栏。）

- [ ] **Step 6: typecheck 必须回到 0**

```bash
npm run typecheck
```

Expected: PASS —— 0 个错误。（改完面板、`TaskBoard` 还没传新 prop 时这里会报三个缺 prop 的错误，Step 5 传完就消失。所以这三处必须一起改完再提交。）

- [ ] **Step 7: lint 三个文件**

```bash
npx eslint src/components/tasks/TaskBoard.tsx src/components/tasks/ScheduledTasksPanel.tsx src/components/tasks/ScheduledTasksView.tsx 2>&1 | grep -E '^✖'
```

Expected: TaskBoard **0 problems**、面板 **1 problem**、视图 **2 problems** —— 逐个与基线比零新增。删掉标题行不会减少视图的警告，那两条是 `import-x/order`（第 6 行）和移动卡片那行的 `tailwindcss/classnames-order`（原第 142 行，删 3 行后变成 139 行）。

- [ ] **Step 8: 跑现有测试**

```bash
npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
npx tsx --test src/components/tasks/ScheduledRunHistoryView.test.tsx
npx tsx --test src/components/tasks/TaskCard.test.tsx
npx tsx --test src/components/tasks/TaskTableView.test.tsx
npx tsx --test src/components/tasks/TaskFilterBar.test.tsx
npx tsx --test src/components/tasks/taskFilter.test.ts
```

Expected: 全绿。`ScheduledTasksView.test.tsx` 没有断言那行标题，预计无需改动；若它真的红了，就删掉对应的标题断言（而不是把标题加回来）。（`TaskBoard.tsx` 本身没有单测文件 —— 它依赖 `useWebSocket` context —— 本次改动由 Task 6 的手工 E2E 覆盖。）

- [ ] **Step 9: 提交**

```bash
git add web/src/components/tasks/ScheduledTasksPanel.tsx web/src/components/tasks/ScheduledTasksView.tsx web/src/components/tasks/TaskBoard.tsx && git commit -m "feat(scheduled-tasks): switch between schedules and run history" -- web/src/components/tasks/ScheduledTasksPanel.tsx web/src/components/tasks/ScheduledTasksView.tsx web/src/components/tasks/TaskBoard.tsx
```

---

## Task 5: 详情页徽标深链

`TaskDetail.tsx` 的「⏰ 定时」徽标现在跳 `/tasks?view=scheduled`（落在「调度」子标签）。这个徽标的语义是「本任务来自定时任务」，落到运行记录更贴。

**Files:**
- Modify: `web/src/components/tasks/TaskDetail.tsx:488`

- [ ] **Step 1: 改跳转目标**

把第 488 行：

```tsx
                onClick={() => navigate('/tasks?view=scheduled')}
```

改成：

```tsx
                onClick={() => navigate('/tasks?view=scheduled&tab=runs')}
```

- [ ] **Step 2: typecheck + lint**

```bash
npm run typecheck
npx eslint src/components/tasks/TaskDetail.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck 0 错误；eslint 仍是 **8 problems**（与基线一致）。

- [ ] **Step 3: 提交**

```bash
git add web/src/components/tasks/TaskDetail.tsx && git commit -m "feat(scheduled-tasks): point the task-detail badge at the run history" -- web/src/components/tasks/TaskDetail.tsx
```

---

## Task 6: 全量验收

**Files:** 无（只跑检查与手工验证）

- [ ] **Step 1: typecheck 与 lint 全量复核**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npm run typecheck
npx eslint src/components/tasks/TaskBoard.tsx src/components/tasks/ScheduledTasksPanel.tsx src/components/tasks/ScheduledTasksView.tsx src/components/tasks/TaskDetail.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck **0 错误**；eslint 逐个文件与基线比 **零新增**（TaskBoard 0 / Panel 1 / View 2 / TaskDetail 8）。

- [ ] **Step 2: 跑本次涉及的全部测试文件**

```bash
npx tsx --test src/components/tasks/projectLabel.test.ts
npx tsx --test src/components/tasks/ScheduledTabBar.test.tsx
npx tsx --test src/components/tasks/ScheduledRunHistoryView.test.tsx
npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
npx tsx --test src/components/tasks/TaskCard.test.tsx
npx tsx --test src/components/tasks/TaskTableView.test.tsx
```

Expected: 全绿。

- [ ] **Step 3: 确认后端零改动**

```bash
cd /mnt/b/workdir/github/lovdex && git diff --stat HEAD~6 -- backend/
```

Expected: 空输出（六个提交里没有 backend 改动）。

- [ ] **Step 4: 手工 E2E（浏览器，走 `:5188` → 后端 `:3188` 的 live dev server）**

先确认 vite 在跑：`ss -lntp | grep 5188`。然后逐条走：

1. 侧边栏点「定时任务」→ 定时页，默认落在**「调度」**子标签，显示那 1 条调度（表格列头含「下次触发」）。
2. 点「运行记录」→ 列出 6 条定时来源任务；列头含**「所属调度」**与**「触发时间」**，每行的调度名不是「已删除的调度」。
3. 切回「调度」，刷新页面 → 仍停在「调度」（localStorage 生效）；切到「运行记录」再刷新 → 停在「运行记录」。
4. 直接开 `http://<本机IP>:5188/tasks?view=scheduled&tab=runs` → 落在**运行记录**（URL 覆盖已存值）。注意用 IP 不用 localhost。
5. 在任务详情页（`/task/<某个 source_schedule_id 非空的任务>`）点「⏰ 定时」徽标 → 落到运行记录。
6. 回看板与表格：任务条数与改动前一致（本地库 249 条），定时来源的任务**仍在**看板/表格里（本次不改既有视图语义）。
7. 窄屏（<1024px，可用 DevTools 设备模拟）下运行记录渲染**卡片**而非表格，「打开任务」可点。
8. 「运行记录」子标签下点 header 的「新建任务」→ 弹出的仍是**新建定时任务**表单（不是普通任务表单）。

- [ ] **Step 5: 记录验收结果**

把 E2E 的实际结果（尤其第 4、6、8 条）追加到 spec 文档末尾的验收小节，然后提交：

```bash
git add docs/superpowers/specs/2026-09-21-scheduled-run-history-design.md && git commit -m "docs(scheduled-tasks): record the run-history E2E results" -- docs/superpowers/specs/2026-09-21-scheduled-run-history-design.md
```

---

## 附：URL 契约

| URL | 落点 |
|---|---|
| `/tasks` | 看板 |
| `/tasks?view=scheduled` | 定时页 · **调度**（默认子标签） |
| `/tasks?view=scheduled&tab=runs` | 定时页 · **运行记录** |

侧边栏「定时任务」入口（`SidebarScheduledEntry.tsx:18`）不变，仍落「调度」。
