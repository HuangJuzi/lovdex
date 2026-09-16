import type { SubStatus, Task } from '../../types/app';

import { canOpenSession } from './taskActions';
import { deadlineInfo } from './taskDeadline';
import { SUB_STATUS_META } from './taskStatus';

export type AttentionAction = 'retry' | 'start' | 'accept' | 'openSession' | 'openTask';
export type AttentionTone = 'wait' | 'fail' | 'accept' | 'plan' | 'late';

export type AttentionItem = {
  task: Task;
  signal: SubStatus | 'overdue';
  label: string;
  tone: AttentionTone;
  action: AttentionAction;
};

/** 需要用户介入的 sub_status → 配色族。动作在 attentionItems 里按会话状态细化。 */
const SUB_SIGNAL_TONE: Partial<Record<SubStatus, AttentionTone>> = {
  failed: 'fail',
  waiting_answer: 'wait',
  waiting_plan: 'wait',
  waiting_approval: 'wait',
  pending_acceptance: 'accept',
  needs_review: 'wait',
  blocked: 'fail',
  only_plan: 'plan',
};

function actionFor(signal: SubStatus, task: Task): AttentionAction {
  switch (signal) {
    case 'failed':
      return 'retry';
    case 'pending_acceptance':
      return 'accept';
    default:
      // waiting_approval / waiting_answer / waiting_plan / needs_review / blocked / only_plan
      return canOpenSession(task) ? 'openSession' : 'openTask';
  }
}

export function attentionItems(tasks: Task[], now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of tasks) {
    const sub = task.sub_status;
    const tone = sub ? SUB_SIGNAL_TONE[sub] : undefined;
    if (sub && tone) {
      items.push({ task, signal: sub, label: SUB_STATUS_META[sub].label, tone, action: actionFor(sub, task) });
      continue;
    }
    // 纯逾期：无子状态信号，但 deadline 已过且未完成/归档。
    if (task.deadline && task.status !== 'done' && task.status !== 'archived') {
      const info = deadlineInfo(task.deadline, now);
      if (info.overdue) {
        items.push({
          task,
          signal: 'overdue',
          label: info.label,
          tone: 'late',
          action: task.status === 'todo' ? 'start' : canOpenSession(task) ? 'openSession' : 'openTask',
        });
      }
    }
  }
  return items;
}
