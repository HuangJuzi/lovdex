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
