import type { ScheduledTask, Task } from '../../types/app';

import { hasOpenableSession } from './taskActions';

export type LastRunTarget =
  | { kind: 'session'; path: string }
  | { kind: 'task'; path: string }
  | { kind: 'none' };

/**
 * 「上次触发」单元格的跳转目标。`ScheduledTask` 上只有 `last_task_id`，没有
 * `session_id`，所以要靠 `taskById`（全量任务表）把它映射到那条运行开的会话：
 * - 会话还存在 → 跳会话（用户要的「直接跳转到对应的 session」）；
 * - 有 `last_task_id` 但无可用会话（没跑过/会话被清理/映射里找不到）→ 回退任务详情页，
 *   避免把用户送进 404；
 * - 从没跑过 → 什么都不渲染（`—`）。
 */
export function lastRunTarget(schedule: ScheduledTask, taskById: Map<string, Task>): LastRunTarget {
  if (!schedule.last_task_id) return { kind: 'none' };
  const task = taskById.get(schedule.last_task_id);
  if (task && hasOpenableSession(task)) {
    return { kind: 'session', path: `/session/${task.session_id}` };
  }
  return { kind: 'task', path: `/task/${schedule.last_task_id}` };
}
