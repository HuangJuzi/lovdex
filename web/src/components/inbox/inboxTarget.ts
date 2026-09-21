import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';

/**
 * 通知的可跳转目标路径；无目标时返回 null（列表行不可点）。
 * 优先级：任务 > 会话 > 技能更新。
 */
export function inboxTargetPath(it: InboxNotification): string | null {
  if (it.task_id) return `/task/${it.task_id}`;
  if (it.session_id) return `/session/${it.session_id}`;
  if (it.code === 'skill_update') return '/settings?tab=skills';
  return null;
}

/**
 * 「来源」标签。只能从关联关系推，**不能按 `code` 建分类表** ——
 * `code` 是用户在 prompt 里自起的自由文本（如 `disk_full`），后端不枚举。
 * 全仓唯一的内置 code 是 `skill_update`（backend/server/index.js:2247）。
 */
export function sourceLabel(it: InboxNotification): string {
  if (it.code === 'skill_update') return '技能';
  if (it.task_id) return '任务';
  if (it.session_id) return '会话';
  return '系统';
}

const SEVERITY_LABEL: Record<InboxSeverity, string> = {
  critical: '严重',
  warning: '警告',
  info: '信息',
};

export function severityLabel(severity: InboxSeverity): string {
  return SEVERITY_LABEL[severity];
}
