import type { ScheduledTask } from '../types/app';
import { parseCronPreset } from './cronPreset';
import { decomposeInterval, intervalUnitLabel } from './interval';

/**
 * interval_seconds → 可读中文。
 *
 * 与表单共用 interval.ts 的精确分解，保证「表单里选的」和「列表里显示的」是同一个值。
 * 这里**不做四舍五入**：把 5401 秒显示成「每 90 分钟」会让用户以为任务真的每 90 分钟
 * 触发一次，而实际是 90 分 1 秒。
 */
export function intervalLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return `每 ${seconds} 秒`;
  const { amount, unit } = decomposeInterval(seconds);
  return `每 ${amount} ${intervalUnitLabel(unit)}`;
}

const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 常见 cron 表达式 → 中文；无法 humanize 时原样返回。 */
export function cronLabel(expr: string): string {
  const preset = parseCronPreset(expr);
  if (!preset) return expr;
  switch (preset.mode) {
    case 'daily':
      return `每天 ${preset.time}`;
    case 'weekday':
      return `工作日 ${preset.time}`;
    case 'weekly':
      return `每周${DOW_LABELS[Number(preset.dow)]} ${preset.time}`;
    case 'monthly':
      return `每月 ${Number(preset.dom)} 日 ${preset.time}`;
    default:
      return expr;
  }
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
