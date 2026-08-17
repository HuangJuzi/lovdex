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
