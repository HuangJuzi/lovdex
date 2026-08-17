import type { SubStatus, Task, TaskEngine, TaskPriority, TaskLabel, TaskStatus } from '../../types/app';

import { taskTimeLabel } from './taskTimestamp';

export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: '待办', color: '#fbbf24' },
  in_progress: { label: '进行中', color: '#60a5fa' },
  in_review: { label: '评审', color: '#a78bfa' },
  done: { label: '完成', color: '#34d399' },
};

export const SUB_STATUS_ORDER: SubStatus[] = [
  'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
  'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
];

export const SUB_STATUS_META: Record<SubStatus, { label: string; color: string }> = {
  running: { label: '会话运行中', color: '#60a5fa' },
  failed: { label: '执行失败', color: '#ef4444' },
  waiting_answer: { label: '等你回答', color: '#f59e0b' },
  waiting_plan: { label: '等你确认计划', color: '#6366f1' },
  waiting_approval: { label: '等你批准', color: '#f59e0b' },
  pending_acceptance: { label: '待你验收', color: '#a855f7' },
  done: { label: '已完成，待评审', color: '#34d399' },
  only_plan: { label: '计划待执行', color: '#3b82f6' },
  needs_review: { label: '待你决策', color: '#eab308' },
  blocked: { label: '需协助', color: '#ef4444' },
};

function statusSortTime(task: Task): number {
  const ms = Date.parse(taskTimeLabel(task).iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const groups = Object.fromEntries(STATUS_ORDER.map((s) => [s, [] as Task[]])) as Record<TaskStatus, Task[]>;
  for (const t of tasks) {
    if (groups[t.status]) groups[t.status].push(t);
  }
  for (const status of STATUS_ORDER) {
    groups[status].sort((a, b) => statusSortTime(b) - statusSortTime(a));
  }
  return groups;
}

/** 切换某个看板列在表格状态筛选中的选中与否；返回新数组（不修改入参），按 STATUS_ORDER 排序。 */
export function toggleStatus(selected: TaskStatus[], status: TaskStatus): TaskStatus[] {
  const next = selected.includes(status)
    ? selected.filter((s) => s !== status)
    : [...selected, status];
  return STATUS_ORDER.filter((s) => next.includes(s));
}

export function taskSessionState(t: Task): 'none' | 'running' | 'review' | 'done' {
  if (!t.session_id) return 'none';
  switch (t.status) {
    case 'in_progress': return 'running';
    case 'in_review': return 'review';
    case 'done': return 'done';
    default: return 'none';
  }
}

export const PRIORITY_ORDER: TaskPriority[] = ['P0', 'P1', 'P2', 'P3'];

export const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  P0: { label: 'P0 紧急', color: '#ef4444' },
  P1: { label: 'P1 高', color: '#ea580c' },
  P2: { label: 'P2 中', color: '#3b82f6' },
  P3: { label: 'P3 低', color: '#6b7280' },
};

export const LABEL_ORDER: TaskLabel[] = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder'];

export const LABEL_META: Record<TaskLabel, { label: string; color: string }> = {
  bug: { label: 'BUG', color: '#ef4444' },
  feature: { label: '新特性', color: '#16a34a' },
  optimization: { label: '优化', color: '#3b82f6' },
  refactor: { label: '重构', color: '#a855f7' },
  docs: { label: '文档', color: '#0891b2' },
  other: { label: '其他', color: '#6b7280' },
  reminder: { label: '提醒', color: '#f59e0b' },
};

/** Executor 引擎徽标展示（任务卡 / 表格行共用文案与配色）。 */
export const EXECUTOR_META: Record<TaskEngine, { label: string; badge: string }> = {
  claude: { label: '◈ Claude', badge: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  codex: { label: '◈ Codex', badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  opencode: { label: '◈ OpenCode', badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  qoder: { label: '◈ Qoder', badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
};
