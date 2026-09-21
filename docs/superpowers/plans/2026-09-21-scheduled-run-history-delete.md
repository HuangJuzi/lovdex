# 运行记录逐条删除与批量删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「定时任务 → 运行记录」列表支持逐条删除与勾选批量删除，每条都走单个删除接口的完整语义（运行中被拒、成功的连带硬删关联会话）。

**Architecture:** 纯前端，**零后端改动**。批量删除在前端循环调用 `api.tasks.remove(id)`（`DELETE /api/tasks/:taskId`），从而拿到 `deleteTask` 的完整语义；**不能**复用 `POST /api/tasks/batch-delete` —— 那个接口既不守卫运行中、也不清关联会话（详见 spec §1 与 §7）。删除的选择/判定逻辑抽成无组件的纯函数模块 `runHistoryDelete.ts`，可在无 DOM 的测试环境里单测；视图保持展示层，通过 `onDelete` 回调把实际请求交给面板。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind。测试是 `node:test` + `node:assert/strict`，组件用 `react-dom/server` 的 `renderToStaticMarkup` 做静态标记冒烟 —— **没有 DOM**，effect 与交互都不执行，所以逻辑必须抽成纯函数才能测。

**Spec:** `docs/superpowers/specs/2026-09-21-scheduled-run-history-delete-design.md`

---

## 环境准备（每个任务开始前都要做）

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH          # 全局 export 的 server/tsconfig.json 会让 npx tsx 读错配置
```

**基线数字（2026-09-21 实测，改动前）：**

| 检查 | 基线 |
|---|---|
| `npm run typecheck` | **0 个错误** |
| `npx eslint src/components/tasks/ScheduledRunHistoryView.tsx` | 3 problems（3 条 `react-refresh/only-export-components`） |
| `npx eslint src/components/tasks/ScheduledRunHistoryView.test.tsx` | 0 problems |
| `npx eslint src/components/tasks/ScheduledTasksPanel.tsx` | 1 problem（`import-x/order`） |
| `npx eslint src/components/tasks/TaskBoard.tsx` | 0 problems |
| `ScheduledRunHistoryView.test.tsx` | 12 pass |

**读数字要看 eslint 的汇总行，别用 `grep -c` 数行** —— 末尾的「0 errors and 1 warning potentially fixable」也含 `warning` 字样，会数错：

```bash
npx eslint <file> 2>&1 | grep -E '^✖'
```

**验收判据是「这几个文件的数字不增加」，不是「仓库总数为 0」** —— 仓库里有另一个 session 在并发改文件。

**新增文件不该带 `react-refresh` 警告**：`runHistoryDelete.ts` 是无组件的纯 `.ts` 模块，那条规则不会命中它。这正是把它单独成文件的原因之一（见 spec §3.1）。

**提交注意：** 工作区被两个 session 共用，另一个 session 也在往 main 上提交。提交一律用**单条原子命令带 pathspec**，别用 `git commit --amend`、别 rebase、别 `git add -A`：

```bash
git add <file> && git commit -m "<msg>" -- <file>
```

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/components/tasks/runHistoryDelete.ts` | 新建 | `DeleteOutcome` 类型 + 三个纯函数：`selectableRuns` / `toggleSelectAll` / `deleteOutcomeMessage` |
| `web/src/components/tasks/runHistoryDelete.test.ts` | 新建 | 上面三个纯函数的单测 |
| `web/src/components/tasks/ScheduledRunHistoryView.tsx` | 改 | 加勾选列 / 勾选框 / 每行删除按钮 / 结果条 / 批量操作条；新增 `onDelete` prop |
| `web/src/components/tasks/ScheduledRunHistoryView.test.tsx` | 改 | `render` 助手加 `onDelete`；新增 3 条静态标记断言 |
| `web/src/components/tasks/ScheduledTasksPanel.tsx` | 改 | 实现 `deleteRuns`（循环调单个删除接口 + 逐条收集结果）；新增 `onRunsDeleted` prop |
| `web/src/components/tasks/TaskBoard.tsx` | 改 | 传 `onRunsDeleted={(ids) => ids.forEach(remove)}` 做本地列表兜底清理 |

**不改**：后端任何文件、`web/src/types/app.ts`、`web/src/utils/api.js`、`ScheduledTasksView.tsx`、`ScheduledTabBar.tsx`、`TaskTableView.tsx`（不复用它：它的 sort / selection / 状态 pill 状态全绑在 `useLocalStorage` 上，第二实例会撞 key）。

---

## Task 1: `runHistoryDelete.ts` —— 类型 + 三个纯函数

**Files:**
- Create: `web/src/components/tasks/runHistoryDelete.ts`
- Test: `web/src/components/tasks/runHistoryDelete.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/runHistoryDelete.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import {
  deleteOutcomeMessage,
  selectableRuns,
  toggleSelectAll,
  type DeleteOutcome,
} from './runHistoryDelete';

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

function task(taskId: string, status: Task['status']): Task {
  return { ...baseTask, task_id: taskId, status };
}

const failedRun = (taskId: string): DeleteOutcome['failed'][number] => ({ taskId, reason: 'x', running: true });
const failedOther = (taskId: string): DeleteOutcome['failed'][number] => ({ taskId, reason: 'y', running: false });

test('selectableRuns 滤掉运行中的运行', () => {
  const runs = [task('a', 'done'), task('b', 'in_progress'), task('c', 'archived')];
  assert.deepEqual(selectableRuns(runs).map((t) => t.task_id), ['a', 'c']);
});

test('selectableRuns 保留所有非运行中状态', () => {
  const runs = (['todo', 'in_review', 'done', 'archived'] as const).map((s) => task(s, s));
  assert.deepEqual(selectableRuns(runs).map((t) => t.status), ['todo', 'in_review', 'done', 'archived']);
});

test('selectableRuns 空数组还是空数组', () => {
  assert.deepEqual(selectableRuns([]), []);
});

test('toggleSelectAll 未全选时全选', () => {
  assert.deepEqual([...toggleSelectAll(new Set(['a']), ['a', 'b'])].sort(), ['a', 'b']);
});

test('toggleSelectAll 已全选时清空', () => {
  assert.equal(toggleSelectAll(new Set(['a', 'b']), ['a', 'b']).size, 0);
});

test('toggleSelectAll 只装传入的可选 id', () => {
  assert.deepEqual([...toggleSelectAll(new Set(), ['a'])], ['a']);
});

test('toggleSelectAll 没有可选项时返回空集', () => {
  assert.equal(toggleSelectAll(new Set(['a']), []).size, 0);
});

// deleteOutcomeMessage：spec §3.1 真值表的八条分支
test('deleteOutcomeMessage：什么都没发生 → null', () => {
  assert.equal(deleteOutcomeMessage({ deleted: [], failed: [] }), null);
});

test('deleteOutcomeMessage：全成功', () => {
  assert.equal(deleteOutcomeMessage({ deleted: ['a', 'b'], failed: [] }), '已删除 2 条');
});

test('deleteOutcomeMessage：成功 + 全部因运行中失败', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: ['a'], failed: [failedRun('b')] }),
    '已删除 1 条，1 条因运行中未能删除',
  );
});

test('deleteOutcomeMessage：一条没删掉且全因运行中 → 带可操作提示', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: [], failed: [failedRun('a')] }),
    '1 条未能删除：运行中的运行需先停止',
  );
});

test('deleteOutcomeMessage：成功 + 运行中与其它失败混合', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: ['a'], failed: [failedRun('b'), failedOther('c')] }),
    '已删除 1 条，1 条因运行中未能删除，1 条删除失败',
  );
});

test('deleteOutcomeMessage：成功 + 只有其它失败', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: ['a'], failed: [failedOther('b')] }),
    '已删除 1 条，1 条删除失败',
  );
});

test('deleteOutcomeMessage：没删掉 + 运行中与其它失败混合', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: [], failed: [failedRun('a'), failedOther('b')] }),
    '1 条因运行中未能删除，1 条删除失败',
  );
});

test('deleteOutcomeMessage：没删掉 + 只有其它失败', () => {
  assert.equal(deleteOutcomeMessage({ deleted: [], failed: [failedOther('a')] }), '1 条删除失败');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --test src/components/tasks/runHistoryDelete.test.ts
```

Expected: FAIL —— `Cannot find module './runHistoryDelete'`。

- [ ] **Step 3: 写实现**

创建 `web/src/components/tasks/runHistoryDelete.ts`：

```ts
import type { Task } from '../../types/app';

/**
 * 删除结果。`running` 单独标记「因运行中被拒」—— 后端 `deleteTask` 对运行中的任务
 * （或会话仍在流式输出的）抛 409 `SESSION_RUNNING`，结果文案要能把它与普通失败分开说。
 */
export type DeleteOutcome = {
  deleted: string[];
  failed: { taskId: string; reason: string; running: boolean }[];
};

/**
 * 可删除的运行。运行中的删不掉（后端 409），从源头不给勾 —— 免得用户白选一轮再被拒。
 * 其余状态（含 archived）都能删：这是一份历史，要删的就是跑完的那些。
 */
export function selectableRuns(runs: Task[]): Task[] {
  return runs.filter((t) => t.status !== 'in_progress');
}

/**
 * 表头全选：只作用于可选行；全部已选则清空。与 `TaskBoard.tsx` 里的同名内联逻辑一致，
 * 抽出来是为了能在无 DOM 的测试环境里测。
 */
export function toggleSelectAll(prev: Set<string>, selectableIds: string[]): Set<string> {
  if (selectableIds.length > 0 && selectableIds.every((id) => prev.has(id))) return new Set();
  return new Set(selectableIds);
}

/**
 * 结果条文案；`null` 表示没有结果条要显示。
 *
 * 三段各自计数后按序拼：已删除 → 因运行中失败 → 其它失败。唯一例外是一条都没删掉、
 * 且失败全部因运行中时，换成一句可操作的原因（用户能自己去停止那个运行）。
 */
export function deleteOutcomeMessage({ deleted, failed }: DeleteOutcome): string | null {
  if (deleted.length === 0 && failed.length === 0) return null;

  const running = failed.filter((f) => f.running).length;
  const other = failed.length - running;

  if (deleted.length === 0 && other === 0) {
    return `${running} 条未能删除：运行中的运行需先停止`;
  }

  const parts: string[] = [];
  if (deleted.length > 0) parts.push(`已删除 ${deleted.length} 条`);
  if (running > 0) parts.push(`${running} 条因运行中未能删除`);
  if (other > 0) parts.push(`${other} 条删除失败`);
  return parts.join('，');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --test src/components/tasks/runHistoryDelete.test.ts
```

Expected: PASS —— **15 个 test 全绿**。

- [ ] **Step 5: typecheck + lint**

```bash
npm run typecheck
npx eslint src/components/tasks/runHistoryDelete.ts src/components/tasks/runHistoryDelete.test.ts 2>&1 | grep -E '^✖'
```

Expected: typecheck 0 错误；eslint **0 problems**（纯 `.ts` 模块不触发 `react-refresh` 规则 —— 这正是它单独成文件的原因）。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/tasks/runHistoryDelete.ts web/src/components/tasks/runHistoryDelete.test.ts && git commit -m "feat(scheduled-tasks): add run-history delete helpers" -- web/src/components/tasks/runHistoryDelete.ts web/src/components/tasks/runHistoryDelete.test.ts
```

---

## Task 2: 接线（视图勾选/删除 UI + 面板实现 + 页面兜底）

**Files:**
- Modify: `web/src/components/tasks/ScheduledRunHistoryView.tsx`
- Modify: `web/src/components/tasks/ScheduledRunHistoryView.test.tsx`
- Modify: `web/src/components/tasks/ScheduledTasksPanel.tsx`
- Modify: `web/src/components/tasks/TaskBoard.tsx`

> **为什么四处合并成一个任务、一次提交：** 视图的新 prop `onDelete` 是必填的，视图改完而面板没传，typecheck 立刻不过；面板的新 prop `onRunsDeleted` 同理。分次提交会在共用工作区里留一个红提交（另一个 session 可能正在同一个工作区里跑检查）。四处一起改完再提交，每个提交都是绿的。

- [ ] **Step 1: 改 `ScheduledRunHistoryView.tsx`**

把整个文件替换成下面内容。相比原来，改动是：加 `useState`/`useEffect`/`X` 的 import、加 `runHistoryDelete` 的 import、props 加 `onDelete`、把 `OpenActions` 换成 `RowActions`（多一个删除按钮）、组件体加选择状态与删除流程、桌面表格加勾选列、移动卡片加勾选框、列表上方加结果条与批量操作条。

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';

import type { ScheduledTask, Task } from '../../types/app';

import { projectLabel } from './projectLabel';
import { deleteOutcomeMessage, selectableRuns, toggleSelectAll, type DeleteOutcome } from './runHistoryDelete';
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
  /** 调度列表的就绪状态。未就绪时「所属调度」列显示状态占位而不是「已删除的调度」。 */
  scheduleLookup?: ScheduleLookup;
  projectOptions: TaskProjectOption[];
  /** 删除指定的运行。返回逐条结果，供结果条展示。 */
  onDelete: (taskIds: string[]) => Promise<DeleteOutcome>;
};

const DELETED_SCHEDULE_LABEL = '已删除的调度';
const UNKNOWN_SCHEDULE_LABEL = '调度加载中';
const SCHEDULE_LOOKUP_FAILED_LABEL = '调度列表不可用';

/** 调度列表的就绪状态。未就绪时不能把每行都断言成「已删除」。 */
export type ScheduleLookup = 'loading' | 'error' | 'ready';

/** 定时来源过滤。删调度不会删它跑出来的任务，所以过滤条件只看任务自身的字段。 */
export function runsOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.source_schedule_id);
}

/** 「所属调度」列：调度被删掉后任务行仍在，回退成占位文案。 */
export function scheduleTitleOf(
  scheduleId: string | null,
  schedules: ScheduledTask[],
  lookup: ScheduleLookup = 'ready',
): string {
  if (lookup === 'loading') return UNKNOWN_SCHEDULE_LABEL;
  if (lookup === 'error') return SCHEDULE_LOOKUP_FAILED_LABEL;
  if (!scheduleId) return DELETED_SCHEDULE_LABEL;
  return schedules.find((s) => s.schedule_id === scheduleId)?.title ?? DELETED_SCHEDULE_LABEL;
}

/**
 * 触发时间倒序。调度触发时先建任务行、再起运行，所以 `created_at` 就是这次调度的
 * 触发时间（`started_at` 在未启动/仅提醒的任务上是 NULL）。后端时间戳是定长裸 UTC
 * （`YYYY-MM-DD HH:MM:SS`），字典序即时序，所以直接比字符串，不用 `Date`
 * （对齐 taskTimestamp.ts 的约定）。
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

function RowActions({
  task,
  canDelete,
  deleting,
  onDelete,
}: {
  task: Task;
  canDelete: boolean;
  deleting: boolean;
  onDelete: (taskIds: string[]) => void;
}) {
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
      <button
        type="button"
        disabled={!canDelete || deleting}
        title={canDelete ? '删除' : '运行中，先停止再删除'}
        aria-label="删除"
        onClick={() => onDelete([task.task_id])}
        className="whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        删除
      </button>
    </div>
  );
}

/**
 * 定时任务的运行记录：这个调度跑出来的那些任务。可勾选批量删除，也可逐条删除；
 * 不做排序，也不套用任务页的筛选栏（定时视图本来就没有筛选栏）。
 *
 * 删除走 `onDelete` 回调而不是自己发请求 —— 视图保持展示层，请求与刷新留给面板，
 * 这样它仍能被 `renderToStaticMarkup` 静态测试。
 */
export function ScheduledRunHistoryView({
  runs,
  schedules,
  scheduleLookup = 'ready',
  projectOptions,
  onDelete,
}: ScheduledRunHistoryViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [outcome, setOutcome] = useState<DeleteOutcome | null>(null);

  // 已删/已被别处删掉的 id 从选择里剪掉，避免幽灵勾选（对齐 TaskBoard 的做法）。
  useEffect(() => {
    const ids = new Set(runs.map((t) => t.task_id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [runs]);

  if (runs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <div className="text-sm text-muted-foreground">暂无运行记录</div>
      </div>
    );
  }

  const ordered = sortRunsByTriggeredDesc(runs);
  const selectableIds = selectableRuns(runs).map((t) => t.task_id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const outcomeText = outcome ? deleteOutcomeMessage(outcome) : null;

  async function runDelete(taskIds: string[]) {
    if (taskIds.length === 0 || deleting) return;
    const ok = window.confirm(
      taskIds.length === 1
        ? '确定删除该运行记录？其关联会话也会一并删除，此操作不可恢复。'
        : `确定删除选中的 ${taskIds.length} 条运行记录？其关联会话也会一并删除，此操作不可恢复。`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const result = await onDelete(taskIds);
      setOutcome(result);
      // 全失败时保留选中集，让用户能直接重试；有成功的就清空。
      if (result.deleted.length > 0) setSelected(new Set());
    } finally {
      setDeleting(false);
    }
  }

  function toggleOne(taskId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 结果条在上、操作条在下：前者说「上次删了什么」，后者说「现在选了什么」。 */}
      {outcomeText && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 sm:px-4">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{outcomeText}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setOutcome(null)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 sm:px-4">
          <span className="text-sm font-medium">已选 {selected.size} 项</span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            取消选择
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void runDelete([...selected])}
            className="ml-auto rounded-lg bg-destructive/10 px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50"
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        </div>
      )}

      {/* Desktop table (≥1024px)；移动/平板用下方卡片。 */}
      <div className="hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block">
        <table className="w-full min-w-[900px] border-separate text-sm" style={{ borderSpacing: '0 7px' }}>
          <thead>
            <tr>
              <th className="px-2 pb-1">
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={allSelected}
                  disabled={selectableIds.length === 0}
                  onChange={() => setSelected((prev) => toggleSelectAll(prev, selectableIds))}
                  className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
              </th>
              {['标题', '所属调度', '项目', '状态', '触发时间', '操作'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 pb-1 text-left text-xs font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((task) => {
              // 运行中的删不掉（后端 409），勾选框与删除按钮都从源头挡住。
              const canDelete = task.status !== 'in_progress';
              return (
                <tr key={task.task_id} className="bg-card shadow-sm">
                  <td className="rounded-l-lg bg-card px-2 py-3">
                    {canDelete && (
                      <input
                        type="checkbox"
                        aria-label="选择运行"
                        checked={selected.has(task.task_id)}
                        onChange={() => toggleOne(task.task_id)}
                        className="h-4 w-4 cursor-pointer accent-primary"
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold text-card-foreground [overflow-wrap:anywhere]">{task.title}</td>
                  {/* 调度名与项目名都可能是不可断的长 token（项目名会回退成完整路径），
                      截断 + title 兜底，避免把表推出横向滚动（沿用 ScheduledTasksView 的同类处理）。 */}
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <span className="block max-w-40 truncate" title={scheduleTitleOf(task.source_schedule_id, schedules, scheduleLookup)}>
                      {scheduleTitleOf(task.source_schedule_id, schedules, scheduleLookup)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <span className="block max-w-40 truncate" title={projectLabel(task, projectOptions)}>
                      {projectLabel(task, projectOptions)}
                    </span>
                  </td>
                  <td className="px-4 py-3"><StatusCell task={task} /></td>
                  <td className="px-4 py-3 font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</td>
                  <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                    <RowActions task={task} canDelete={canDelete} deleting={deleting} onDelete={(ids) => void runDelete(ids)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile/tablet cards (<1024px) */}
      <div className="grid min-h-0 w-full flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:hidden">
        {ordered.map((task) => {
          const canDelete = task.status !== 'in_progress';
          return (
            <div key={task.task_id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm">
              <div className="flex items-start gap-2">
                {canDelete && (
                  <input
                    type="checkbox"
                    aria-label="选择运行"
                    checked={selected.has(task.task_id)}
                    onChange={() => toggleOne(task.task_id)}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-primary"
                  />
                )}
                <span className="line-clamp-2 overflow-hidden text-sm font-semibold text-card-foreground">{task.title}</span>
              </div>
              <span className="truncate text-xs text-muted-foreground">{scheduleTitleOf(task.source_schedule_id, schedules, scheduleLookup)}</span>
              <div className="self-start"><StatusCell task={task} /></div>
              <span className="font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</span>
              <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
                <RowActions task={task} canDelete={canDelete} deleting={deleting} onDelete={(ids) => void runDelete(ids)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 改 `ScheduledTasksPanel.tsx`**

**2a. import 区**加一行（放在 `ScheduledRunHistoryView` 那行之前，保持字母序）：

```tsx
import type { DeleteOutcome } from './runHistoryDelete';
```

只引类型 —— 本文件用不到 `deleteOutcomeMessage`（那是视图的事）。

**2b. props 类型**加一项：

```tsx
export type ScheduledTasksPanelProps = {
  projectOptions: TaskProjectOption[];
  /** 任务页的全量任务列表（TaskBoard 的 useTasks），运行记录从这里过滤出来。 */
  tasks: Task[];
  tab: ScheduledTab;
  onTabChange: (next: ScheduledTab) => void;
  /** 删除成功后回调，供页面把行从本地列表里摘掉（WS 不可靠时的兜底）。 */
  onRunsDeleted: (taskIds: string[]) => void;
};
```

组件签名解构里也加 `onRunsDeleted`：

```tsx
  function ScheduledTasksPanel({ projectOptions, tasks, tab, onTabChange, onRunsDeleted }, ref) {
```

**2c. 在 `runs` 那个 `useMemo` 之后**加删除实现：

```tsx
  /**
   * 删除运行记录。**逐条**调单个删除接口，而不是 `api.tasks.removeMany` ——
   * 批量接口既不守卫运行中、也不清关联会话（会留下孤儿会话），单个接口才是完整语义。
   * 逐条收集结果，好让 UI 把「哪几条因运行中被拒」如实报出来。
   */
  async function deleteRuns(taskIds: string[]): Promise<DeleteOutcome> {
    const deleted: string[] = [];
    const failed: DeleteOutcome['failed'] = [];
    for (const taskId of taskIds) {
      try {
        const res = await api.tasks.remove(taskId);
        if (res.ok) {
          deleted.push(taskId);
          continue;
        }
        const err = await res.json().catch(() => null);
        const reason = err?.error?.message ?? `HTTP ${res.status}`;
        console.error('delete run failed', taskId, reason);
        failed.push({ taskId, reason, running: err?.error?.code === 'SESSION_RUNNING' });
      } catch (e) {
        console.error('delete run failed', taskId, e);
        failed.push({ taskId, reason: e instanceof Error ? e.message : '网络错误', running: false });
      }
    }
    if (deleted.length > 0) onRunsDeleted(deleted);
    return { deleted, failed };
  }
```

**2d. 运行记录分支**把 `onDelete` 传下去：

```tsx
    body = (
      <ScheduledRunHistoryView
        runs={runs}
        schedules={schedules}
        scheduleLookup={scheduleLookup}
        projectOptions={projectOptions}
        onDelete={deleteRuns}
      />
    );
```

- [ ] **Step 3: 改 `TaskBoard.tsx`**

把 `<ScheduledTasksPanel ... />` 那处加一个 prop：

```tsx
            <ScheduledTasksPanel
              ref={scheduledPanelRef}
              projectOptions={projectOptions}
              tasks={tasks}
              tab={scheduledTab}
              onTabChange={setScheduledTab}
              onRunsDeleted={(ids) => ids.forEach(remove)}
            />
```

（`remove` 是 `TaskBoard.tsx` 里 `useTasks` 解构出来的本地移除函数，与 `deleteSelected` 里 `ids.forEach((id) => remove(id))` 的兜底写法一致。**这条不能省**：`task_deleted` WS 事件正常会自己摘掉行，但 E2E 实测到控制台每次都报 `WebSocket error`，只靠 WS 不可靠。）

- [ ] **Step 4: 改 `ScheduledRunHistoryView.test.tsx` 的 render 助手**

`render` 助手要补上必填的 `onDelete`，并新增 3 条静态标记断言。

**4a.** 把 `render` 改成（其余不动）：

```tsx
function render(runs: Task[], schedules: ScheduledTask[] = [baseSchedule], scheduleLookup?: ScheduleLookup) {
  return renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled&tab=runs">
      <ScheduledRunHistoryView
        runs={runs}
        schedules={schedules}
        scheduleLookup={scheduleLookup}
        projectOptions={projectOptions}
        onDelete={async () => ({ deleted: [], failed: [] })}
      />
    </StaticRouter>,
  );
}
```

**4b.** 文件末尾追加三条：

```tsx
test('运行中的行不给勾选框', () => {
  const html = render([
    { ...baseTask, task_id: 'done-1', status: 'done' },
    { ...baseTask, task_id: 'run-1', status: 'in_progress' },
    { ...baseTask, task_id: 'done-2', status: 'done' },
  ]);
  // 每行在桌面表格与移动卡片各渲染一次勾选框，所以是「可选行数 × 2」
  assert.equal((html.match(/aria-label="选择运行"/g) ?? []).length, 4);
});

test('运行中的行删除按钮置灰并说明原因', () => {
  const html = render([{ ...baseTask, status: 'in_progress' }]);
  assert.match(html, /disabled="" title="运行中，先停止再删除"/);
});

test('没有可选行时全选框置灰', () => {
  const html = render([{ ...baseTask, status: 'in_progress' }]);
  assert.match(html, /aria-label="全选" disabled=""/);
});
```

> 断言依据（2026-09-21 实测 React 静态标记）：`disabled` 渲染成 `disabled=""`，`disabled={false}` 整个属性不渲染；`checked` 渲染成 `checked=""` 且排在 `class` **之后**。上面三条只依赖 `disabled` 的形态，不依赖属性顺序。

- [ ] **Step 5: typecheck 必须 0 错误**

```bash
npm run typecheck
```

Expected: PASS —— 0 个错误。（改到一半时这里会报「缺 `onDelete` / `onRunsDeleted`」的错，四处都改完就消失 —— 所以这四处必须一起改完再提交。）

- [ ] **Step 6: lint 四个文件**

```bash
npx eslint src/components/tasks/ScheduledRunHistoryView.tsx src/components/tasks/ScheduledRunHistoryView.test.tsx src/components/tasks/ScheduledTasksPanel.tsx src/components/tasks/TaskBoard.tsx 2>&1 | grep -E '^✖'
```

Expected（与基线比**零新增**）：视图 **3 problems**、视图测试 **0**、面板 **1 problem**、TaskBoard **0 problems**。视图那 3 条是既有的 `react-refresh` 警告，新增的逻辑都在 `runHistoryDelete.ts` 里，不会让它变多。若 `--fix` 能清的告警（如 `tailwindcss/classnames-order`）出现，先跑 `npx eslint --fix <这几个文件>`，再确认 `git diff` 只有类名顺序/import 空行的机械改动。

- [ ] **Step 7: 跑全部相关测试**

```bash
npx tsx --test src/components/tasks/runHistoryDelete.test.ts
npx tsx --test src/components/tasks/ScheduledRunHistoryView.test.tsx
npx tsx --test src/components/tasks/ScheduledTabBar.test.tsx
npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
npx tsx --test src/components/tasks/TaskCard.test.tsx
npx tsx --test src/components/tasks/TaskTableView.test.tsx
npx tsx --test src/components/tasks/TaskFilterBar.test.tsx
npx tsx --test src/components/tasks/taskFilter.test.ts
```

Expected: 全绿。合计应为 **15 + 15 + 4 + 7 + 13 + 18 + 4 + 35 = 111 pass / 0 fail**（`ScheduledRunHistoryView.test.tsx` 从 12 涨到 15）。

**加勾选列会改变桌面表格的列序**，若现有断言依赖列位置而变红，按新列序更新断言（**不要**为了迁就断言去改实现）。

- [ ] **Step 8: 提交**

```bash
git add web/src/components/tasks/ScheduledRunHistoryView.tsx web/src/components/tasks/ScheduledRunHistoryView.test.tsx web/src/components/tasks/ScheduledTasksPanel.tsx web/src/components/tasks/TaskBoard.tsx && git commit -m "feat(scheduled-tasks): delete run-history entries one by one or in bulk" -- web/src/components/tasks/ScheduledRunHistoryView.tsx web/src/components/tasks/ScheduledRunHistoryView.test.tsx web/src/components/tasks/ScheduledTasksPanel.tsx web/src/components/tasks/TaskBoard.tsx
```

---

## Task 3: 全量验收

**Files:** 无（只跑检查与手工验证）

- [ ] **Step 1: typecheck 与 lint 全量复核**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npm run typecheck
npx eslint src/components/tasks/ScheduledRunHistoryView.tsx src/components/tasks/ScheduledRunHistoryView.test.tsx src/components/tasks/ScheduledTasksPanel.tsx src/components/tasks/TaskBoard.tsx src/components/tasks/runHistoryDelete.ts src/components/tasks/runHistoryDelete.test.ts 2>&1 | grep -E '^✖'
```

Expected: typecheck **0 错误**；eslint 逐个文件与基线比**零新增**（视图 3 / 视图测试 0 / 面板 1 / TaskBoard 0 / 两个新文件 0）。

- [ ] **Step 2: 跑本次涉及的全部测试文件**

同 Task 2 Step 7 的命令，Expected **111 pass / 0 fail**。

- [ ] **Step 3: 确认后端零改动**

```bash
cd /mnt/b/workdir/github/lovdex && git log --oneline -3
```

再对本次的两个提交逐个确认 `git show --stat <sha>` 里**没有 `backend/` 文件**。

- [ ] **Step 4: 手工 E2E（浏览器，走 `:5188` → 后端 `:3188` 的 live dev server）**

先确认 vite 在跑：`ss -lntp | grep 5188`。用 puppeteer-core + 缓存 chromium（`~/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome`），**断言走 DOM / computed style，不靠截图**。登录走 `POST http://localhost:3188/api/auth/login`（`zhiju.huang@sophgo.com` / `888888`），拿到 token 后 `localStorage.setItem('auth-token', token)`。

实测数据参考：`tasks` 249 行，`source_schedule_id` 非空 6 行，其中 1 行 `in_progress`、3 行指向已删除的调度。

逐条走：

1. 开 `/tasks?view=scheduled&tab=runs`，确认 `in_progress` 那行**没有**勾选框（数 `aria-label="选择运行"` 的个数 = 5 行可选 × 2 渲染 = 10），且它的「删除」按钮是 `disabled`。
2. 勾选 1 条已完成的行 → 点「删除」→ `page.on('dialog')` 捕获 `window.confirm`，断言文案含「关联会话也会一并删除」→ `dialog.accept()` → 等该行消失、结果条出现「已删除 1 条」。
3. 勾选 2 条 → 批量删除 → 两行都消失、结果条「已删除 2 条」。
4. **刷新页面**，被删的运行确实不在了（证明不是只从 DOM 移除）。
5. **验证连带删会话**（本次唯一能证明「语义正确」而非「看起来对」的检查）：删除前记下某条运行的 `session_id`，删除后直接查库确认 `sessions` 表里那行已消失：
   ```bash
   sqlite3 "file:$HOME/.lovdex/data/new-auth.db?mode=ro" -cmd ".timeout 5000" "SELECT COUNT(*) FROM sessions WHERE session_id='<被删的 session_id>';"
   ```
   Expected: `0`。
6. 全选 → 只选中可选行（`已选 5 项`，不含那 1 条运行中的）。
7. 窄屏（900px）下卡片上也有勾选框，且能完成一次批量删除。

- [ ] **Step 5: 记录验收结果**

把 E2E 的实际结果（尤其第 4、5 条）追加到 spec 文档末尾，然后提交：

```bash
git add docs/superpowers/specs/2026-09-21-scheduled-run-history-delete-design.md && git commit -m "docs(scheduled-tasks): record the delete E2E results" -- docs/superpowers/specs/2026-09-21-scheduled-run-history-delete-design.md
```

---

## 附：本功能依赖的关键事实（实现时不要重新推导）

| 事实 | 出处 |
|---|---|
| 单个删除：运行中 → 409 `SESSION_RUNNING`；成功 → 硬删关联会话 | `backend/server/modules/tasks/services/tasks.service.ts:604-633` |
| 批量删除：**无守卫、不清会话**（孤儿会话） | 同文件 `:635-643` |
| 错误响应体形状 `{ error: { code, message, details } }` | `backend/server/index.js:1993-2002` |
| 前端单个/批量删除 API | `web/src/utils/api.js:360` / `:361` |
| `useTasks` 的本地移除函数 | `web/src/hooks/useTasks.ts:67` |
| 勾选框样式参照 | `web/src/components/tasks/TaskTableView.tsx:200-212`（表头）、`:320-329`（行） |
| 批量操作条参照 | `web/src/components/tasks/TaskBoard.tsx:459-476` |
