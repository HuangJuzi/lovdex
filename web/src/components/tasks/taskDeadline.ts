import type { Task } from '../../types/app';

/** 剩余天数/逾期文案。deadline 是 YYYY-MM-DD，按本地时区当天 23:59:59.999 算截止。 */
export function deadlineInfo(deadline: string, now: Date): { label: string; overdue: boolean } {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!parts) return { label: deadline, overdue: false };
  const due = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 23, 59, 59, 999);
  const days = Math.floor((due.getTime() - now.getTime()) / 86400000);
  if (days < 0) return { label: `已逾期 ${-days} 天`, overdue: true };
  if (days === 0) return { label: '今天截止', overdue: false };
  return { label: `剩 ${days} 天`, overdue: false };
}

export function taskDeadlineInfo(task: Task, now: Date): { label: string; overdue: boolean } | null {
  return task.deadline ? deadlineInfo(task.deadline, now) : null;
}
