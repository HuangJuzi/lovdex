import type { Task } from '../../types/app';

/** 会话仍存在（未被清理），点进去不会落到 404。与任务状态无关。 */
export function hasOpenableSession(task: Task): boolean {
  return Boolean(task.session_id && !task.session_deleted);
}

/** 是否显示「打开会话」：会话仍存在（未被清理）且任务处于可跟进状态（进行中/评审/带特定 sub_status）。 */
export function canOpenSession(task: Task): boolean {
  return (
    hasOpenableSession(task) &&
    (task.status === 'in_progress' ||
      task.status === 'in_review' ||
      ['only_plan', 'needs_review', 'blocked'].includes(task.sub_status ?? ''))
  );
}
