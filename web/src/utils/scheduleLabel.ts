import type { ScheduledTask } from '../types/app';

/** interval_seconds → 可读中文（按分钟/小时/天就近取整）。 */
export function intervalLabel(seconds: number): string {
  if (seconds <= 0) return `每 ${seconds} 秒`;
  if (seconds < 60) return `每 ${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `每 ${minutes} 分钟`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `每 ${hours} 小时`;
  const days = Math.round(seconds / 86400);
  return `每 ${days} 天`;
}

const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 常见 cron 表达式 → 中文；无法 humanize 时原样返回。 */
export function cronLabel(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return expr;
  const hhmm = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom === '*' && month === '*' && dow === '*') return `每天 ${hhmm}`;
  if (dom === '*' && month === '*' && /^[0-6]$/.test(dow)) return `每周${DOW_LABELS[Number(dow)]} ${hhmm}`;
  if (/^\d+$/.test(dom) && month === '*' && dow === '*') return `每月 ${Number(dom)} 日 ${hhmm}`;
  return expr;
}

/** 调度模板 → 人类可读描述；once 只显示「一次性」（具体时间由视图用 next_run_at 展示）。 */
export function scheduleLabel(s: ScheduledTask): string {
  switch (s.schedule_type) {
    case 'interval': return intervalLabel(s.interval_seconds ?? 0);
    case 'cron': return cronLabel(s.cron_expr ?? '');
    case 'once': return '一次性';
    default: return s.schedule_type;
  }
}
