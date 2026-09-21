import type { Task } from '../../types/app';

/**
 * 后端的时间戳是 SQLite `CURRENT_TIMESTAMP` 的产物：`YYYY-MM-DD HH:MM:SS`，
 * 是 **UTC** 但**不带时区标识**（既没有 `Z`，也没有 `+08:00`）。
 *
 * 而 JS 的 `new Date()` 对「无时区标识的日期时间串」按**本地时间**解释
 * （ES2015+ 规定；只有纯日期 `YYYY-MM-DD` 才按 UTC）。于是整条时间偏掉一个
 * 时区偏移 —— 在 Asia/Shanghai 下差 8 小时，真实的「3 小时前」会显示成「11 小时前」。
 *
 * 这里给裸格式补上 `Z` 按 UTC 解析。已经带时区标识的串（`...Z` / `...+08:00`）
 * 原样交给 `Date`，不受影响。
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;

export function parseBackendTimestamp(value: string): Date {
  if (NAIVE_DATETIME.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`);
  }
  return new Date(value);
}

/**
 * Pick the timestamp most relevant to the task's current lifecycle state.
 * Every branch falls back through updated_at → created_at so a card always
 * renders a time regardless of how sparse the row is.
 */
export function taskTimeLabel(task: Task): { label: string; iso: string } {
  switch (task.status) {
    case 'in_progress':
      return { label: '开始于', iso: task.started_at ?? task.updated_at ?? task.created_at };
    case 'in_review':
      return { label: '评审于', iso: task.updated_at ?? task.created_at };
    case 'done':
      return { label: '完成于', iso: task.completed_at ?? task.updated_at ?? task.created_at };
    default:
      return { label: '创建于', iso: task.created_at };
  }
}

export function formatRelativeTime(iso: string, now: Date): string {
  const date = parseBackendTimestamp(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return '刚刚'; // clock skew / future timestamp
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatAbsoluteTime(iso: string): string {
  const date = parseBackendTimestamp(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
