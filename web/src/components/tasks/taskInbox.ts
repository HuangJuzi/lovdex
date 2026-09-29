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

/**
 * 定时任务跑出来的任务（`source_schedule_id` 非空）：**已交付**不算要人处理。
 *
 * 定时任务跑完的常态就是「评审 + 待你验收」，而它一天跑几十次 —— 每次都推给
 * 收件箱，人还没看就先被自己的定时任务淹没。结果去「定时 → 运行记录」里翻。
 * 只有真的「出问题」的信号（失败 / 等人回答 / 等确认计划 / 待决策 / 需协助 /
 * 待执行计划 / 逾期）才值得打扰人：无人值守的任务静默出故障才是危险的。
 *
 * 用「排除已交付」而不是「只允许失败」：将来若给 `SUB_STATUS_META` 加了新的
 * 需人工介入信号，定时任务默认仍会提醒 —— 漏报比误报危险得多。
 */
function isScheduledDelivered(task: Task, signal: SubStatus): boolean {
  return Boolean(task.source_schedule_id) && signal === 'pending_acceptance';
}

export function attentionItems(tasks: Task[], now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of tasks) {
    const sub = task.sub_status;
    const tone = sub ? SUB_SIGNAL_TONE[sub] : undefined;
    if (sub && tone) {
      if (isScheduledDelivered(task, sub)) continue;
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
