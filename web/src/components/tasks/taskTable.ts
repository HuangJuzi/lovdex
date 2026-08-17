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

/** 按值排序的 key：title / project 走 localeCompare，不在此列。 */
type ValueSortKey = Exclude<TaskSortKey, 'title' | 'project'>;

function sortValue(task: Task, key: ValueSortKey): string | number {
  switch (key) {
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

/** 单一 key 的比较：title / project 用 localeCompare（中文/大小写符合用户预期），其余按值比大小。 */
function compareByKey(a: Task, b: Task, key: TaskSortKey): number {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'project':
      return a.project_path.localeCompare(b.project_path);
    default: {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      return va < vb ? -1 : va > vb ? 1 : 0;
    }
  }
}

/** 组内排序：按 key 升/降序，等值回退到「创建时间 desc」再按 task_id 保证稳定。不修改入参。 */
export function sortTasks(tasks: Task[], key: TaskSortKey, dir: TaskSortDir): Task[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const cmp = compareByKey(a, b, key);
    if (cmp !== 0) return cmp * sign;
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    return tb - ta || a.task_id.localeCompare(b.task_id);
  });
}
