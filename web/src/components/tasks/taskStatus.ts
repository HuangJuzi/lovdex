import type { SubStatus, Task, TaskEngine, TaskPriority, TaskLabel, TaskStatus } from '../../types/app';

import { taskTimeLabel } from './taskTimestamp';

export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'archived'];

export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: '待办', color: 'hsl(var(--warning))' },
  in_progress: { label: '进行中', color: 'hsl(var(--info))' },
  in_review: { label: '评审', color: 'hsl(var(--chart-6))' },
  done: { label: '完成', color: 'hsl(var(--success))' },
  archived: { label: '已归档', color: 'hsl(var(--muted-foreground))' },
};

export const SUB_STATUS_ORDER: SubStatus[] = [
  'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
  'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
];

export const SUB_STATUS_META: Record<SubStatus, { label: string; color: string }> = {
  running: { label: '会话运行中', color: 'hsl(var(--info))' },
  failed: { label: '执行失败', color: 'hsl(var(--destructive))' },
  waiting_answer: { label: '等你回答', color: 'hsl(var(--warning))' },
  waiting_plan: { label: '等你确认计划', color: 'hsl(var(--chart-4))' },
  waiting_approval: { label: '等你批准', color: 'hsl(var(--warning))' },
  pending_acceptance: { label: '待你验收', color: 'hsl(var(--chart-6))' },
  done: { label: '已完成，待评审', color: 'hsl(var(--success))' },
  only_plan: { label: '计划待执行', color: 'hsl(var(--info))' },
  needs_review: { label: '待你决策', color: 'hsl(var(--warning))' },
  blocked: { label: '需协助', color: 'hsl(var(--destructive))' },
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

export const PRIORITY_META: Record<TaskPriority, { label: string; color: string; bg: string }> = {
  P0: { label: 'P0 紧急', color: 'hsl(var(--destructive))', bg: 'hsl(var(--destructive) / 0.1)' },
  P1: { label: 'P1 高', color: 'hsl(var(--warning))', bg: 'hsl(var(--warning) / 0.1)' },
  P2: { label: 'P2 中', color: 'hsl(var(--info))', bg: 'hsl(var(--info) / 0.1)' },
  P3: { label: 'P3 低', color: 'hsl(var(--muted-foreground))', bg: 'hsl(var(--muted-foreground) / 0.1)' },
};

export const LABEL_ORDER: TaskLabel[] = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder'];

export const LABEL_META: Record<TaskLabel, { label: string; color: string; bg: string }> = {
  bug: { label: 'BUG', color: 'hsl(var(--destructive))', bg: 'hsl(var(--destructive) / 0.1)' },
  feature: { label: '新特性', color: 'hsl(var(--success))', bg: 'hsl(var(--success) / 0.1)' },
  optimization: { label: '优化', color: 'hsl(var(--info))', bg: 'hsl(var(--info) / 0.1)' },
  refactor: { label: '重构', color: 'hsl(var(--chart-6))', bg: 'hsl(var(--chart-6) / 0.1)' },
  docs: { label: '文档', color: 'hsl(var(--chart-1))', bg: 'hsl(var(--chart-1) / 0.1)' },
  other: { label: '其他', color: 'hsl(var(--muted-foreground))', bg: 'hsl(var(--muted-foreground) / 0.1)' },
  reminder: { label: '提醒', color: 'hsl(var(--warning))', bg: 'hsl(var(--warning) / 0.1)' },
};

/** Executor 引擎徽标展示（任务卡 / 表格行共用文案与配色）。 */
export const EXECUTOR_META: Record<TaskEngine, { label: string; badge: string }> = {
  claude: { label: '◈ Claude', badge: 'bg-success/10 text-success' },
  codex: { label: '◈ Codex', badge: 'bg-warning/10 text-warning' },
  opencode: { label: '◈ OpenCode', badge: 'bg-chart-6/10 text-chart-6' },
  qoder: { label: '◈ Qoder', badge: 'bg-info/10 text-info' },
};
