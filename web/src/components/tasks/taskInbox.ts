import type { SubStatus, Task } from '../../types/app';

import { canOpenSession } from './taskActions';
import { deadlineInfo } from './taskDeadline';
import { SUB_STATUS_META } from './taskStatus';

export type AttentionAction = 'retry' | 'start' | 'accept' | 'ignore' | 'openSession' | 'openTask';
export type AttentionTone = 'wait' | 'fail' | 'accept' | 'plan' | 'late';

export type AttentionItem = {
  task: Task;
  signal: SubStatus | 'overdue';
  label: string;
  tone: AttentionTone;
  action: AttentionAction;
  /**
   * 该条提醒「进入当前状态」的时刻（ISO 串）。后端 decorate 派生的
   * `attention_since` 直接透传 —— 信号到时间戳的映射只在后端一处，前端不重复
   * 推导（两处判据迟早漂移）。纯逾期条目恒为 null：deadline 是日期不是时刻。
   */
  since: string | null;
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
      items.push({ task, signal: sub, label: SUB_STATUS_META[sub].label, tone, action: actionFor(sub, task), since: task.attention_since ?? null });
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
          since: null,
        });
      }
    }
  }
  return items;
}
