/**
 * 定时任务「间隔」的单位表与秒数换算。
 *
 * 单一事实来源：表单的数字框/单位 chip 与列表的 intervalLabel 都从这里取，
 * 保证「表单里选的」和「列表里显示的」永远是同一个值。
 */

export type IntervalUnit = 'second' | 'minute' | 'hour' | 'day' | 'week';

export const INTERVAL_UNITS: { value: IntervalUnit; label: string; seconds: number }[] = [
  { value: 'second', label: '秒', seconds: 1 },
  { value: 'minute', label: '分钟', seconds: 60 },
  { value: 'hour', label: '小时', seconds: 3600 },
  { value: 'day', label: '天', seconds: 86400 },
  { value: 'week', label: '星期', seconds: 604800 },
];

/** 调度器是 15 秒一跳（setInterval(tick, 15_000)），更小的间隔根本触发不到；上限取一整年。 */
export const INTERVAL_MIN_SECONDS = 60;
export const INTERVAL_MAX_SECONDS = 365 * 86400;

const DESC = [...INTERVAL_UNITS].sort((a, b) => b.seconds - a.seconds);

/**
 * 秒 → (数字, 单位)：取「能整除的最大单位」，保证 amount × unit.seconds === seconds 精确成立。
 *
 * 单位表里有「秒」，任何整数秒都能整除，所以这是**全函数** —— 不会出现「90 秒显示成
 * 2 分钟」这种近似。近似在这里是有害的：用户会以为任务真的每 2 分钟触发一次。
 *
 * 要求 `seconds` 是 ≥ 1 的有限数；非法输入的兜底由调用方负责（见 ScheduledTaskForm.toDraft）。
 */
export function decomposeInterval(seconds: number): { amount: number; unit: IntervalUnit } {
  for (const u of DESC) {
    if (seconds % u.seconds === 0) return { amount: seconds / u.seconds, unit: u.value };
  }
  // 不可达：'second' 的 seconds 是 1，任何整数都能整除。保留以满足返回类型。
  return { amount: seconds, unit: 'second' };
}

export function intervalSecondsOf(amount: number, unit: IntervalUnit): number {
  const u = INTERVAL_UNITS.find((x) => x.value === unit);
  return u ? amount * u.seconds : 0;
}

/** 单位 → 中文标签。从 INTERVAL_UNITS 派生，避免单位表存在两份。 */
export function intervalUnitLabel(unit: IntervalUnit): string {
  return INTERVAL_UNITS.find((x) => x.value === unit)?.label ?? unit;
}
