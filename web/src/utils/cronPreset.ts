/**
 * 定时任务 Cron 的「快捷模式」模型：把常见表达式结构化成可点的控件。
 *
 * 只认本模块 buildCronPreset 能生成的四种形态 —— **刻意不做通用 cron 解析**。
 * 解析得越宽，「保存后表达式被悄悄改写」的风险越大；认不出的一律原样透传。
 */

export type CronPresetMode = 'daily' | 'weekly' | 'weekday' | 'monthly';
export type CronMode = CronPresetMode | 'custom';

export type CronPreset = { mode: CronPresetMode; time: string; dow: string; dom: string };

export const CRON_MODES: { value: CronMode; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'weekday', label: '工作日' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义' },
];

/** 值直接就是 cron 的 dow 字段（0 = 周日），不需要再做映射。 */
export const DOW_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: '周日' },
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
];

export const DOM_OPTIONS: { value: string; label: string }[] = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: `${i + 1} 日`,
}));

/**
 * 认得出的表达式 → 结构化预设；认不出的返回 null（调用方落到「自定义」并原样保留）。
 *
 * 识别顺序有讲究：`weekday`（`1-5`）必须在 `weekly`（`/^[0-6]$/`）之前。`'1-5'` 是三个
 * 字符、不会被那个单字符正则匹配，所以顺序上其实等价 —— 但显式排在前面能让意图一眼可见。
 */
export function parseCronPreset(expr: string): CronPreset | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  // 月份非 * 的表达式（如季度任务）不在这四种形态里
  if (month !== '*') return null;

  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  // daily/weekday 不消费 dow/dom，'1' 只是让 CronPreset 保持扁平的占位值。
  const base = { time, dow: '1', dom: '1' };

  if (dom === '*' && dow === '*') return { mode: 'daily', ...base };
  if (dom === '*' && dow === '1-5') return { mode: 'weekday', ...base };
  if (dom === '*' && /^[0-6]$/.test(dow)) return { mode: 'weekly', ...base, dow };
  if (/^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31 && dow === '*') {
    return { mode: 'monthly', ...base, dom };
  }
  return null;
}

/** (模式, 参数) → cron 表达式。`time` 非法（空 / 缺冒号 / 残缺 / 越界）时返回空串。 */
export function buildCronPreset(preset: CronPreset): string {
  const [h, m] = preset.time.split(':');
  // 必须用正则而不是 Number()+isInteger：Number('') === 0，会让 ':' / ':30' / '0:'
  // 这类残缺输入静默通过，变成一个会真实触发的午夜任务。
  if (!/^\d{1,2}$/.test(h ?? '') || !/^\d{1,2}$/.test(m ?? '')) return '';
  const hh = Number(h);
  const mm = Number(m);
  if (hh > 23 || mm > 59) return '';
  const head = `${mm} ${hh}`;
  switch (preset.mode) {
    case 'daily':
      return `${head} * * *`;
    case 'weekday':
      return `${head} * * 1-5`;
    case 'weekly':
      return `${head} * * ${preset.dow}`;
    case 'monthly':
      return `${head} ${preset.dom} * *`;
    default:
      return '';
  }
}

/**
 * cron 分支的**唯一事实来源**：自定义模式用原始表达式，其余模式按参数拼。
 *
 * `cronExpr` 只承载「自定义」模式的内容。让它继续当唯一来源的话，UI 就得「改时间 →
 * 回写表达式」，而用户在自定义框里逐字敲 `0 9 * * *` 时，中途会被识别成 daily、
 * 控件突然换掉。反过来让本函数当来源，就不存在双源同步问题。
 */
export function resolveCronExpr(draft: {
  cronMode: CronMode;
  cronExpr: string;
  cronTime: string;
  cronDow: string;
  cronDom: string;
}): string {
  if (draft.cronMode === 'custom') return draft.cronExpr;
  return buildCronPreset({
    mode: draft.cronMode,
    time: draft.cronTime,
    dow: draft.cronDow,
    dom: draft.cronDom,
  });
}
