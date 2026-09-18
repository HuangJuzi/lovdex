import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERVAL_MAX_SECONDS,
  INTERVAL_MIN_SECONDS,
  decomposeInterval,
  intervalSecondsOf,
  intervalUnitLabel,
} from './interval';

test('decomposeInterval picks the largest unit that divides exactly', () => {
  assert.deepEqual(decomposeInterval(60), { amount: 1, unit: 'minute' });
  assert.deepEqual(decomposeInterval(3600), { amount: 1, unit: 'hour' });
  assert.deepEqual(decomposeInterval(5400), { amount: 90, unit: 'minute' });
  assert.deepEqual(decomposeInterval(86400), { amount: 1, unit: 'day' });
  assert.deepEqual(decomposeInterval(604800), { amount: 1, unit: 'week' });
  // 非整分钟的值如实落到「秒」，不做四舍五入 —— 近似会撒谎成「每 2 分钟」
  assert.deepEqual(decomposeInterval(90), { amount: 90, unit: 'second' });
  assert.deepEqual(decomposeInterval(45), { amount: 45, unit: 'second' });
});

test('decomposeInterval never approximates: the round trip is exact', () => {
  for (const s of [45, 60, 90, 1800, 3600, 5400, 86400, 172800, 604800, 1209600]) {
    const { amount, unit } = decomposeInterval(s);
    assert.equal(intervalSecondsOf(amount, unit), s, `round trip failed for ${s}`);
  }
});

test('intervalUnitLabel reads the label off the shared unit table', () => {
  assert.equal(intervalUnitLabel('second'), '秒');
  assert.equal(intervalUnitLabel('week'), '星期');
});

test('the bounds bracket exactly one minute and one year', () => {
  assert.equal(INTERVAL_MIN_SECONDS, 60);
  assert.equal(INTERVAL_MAX_SECONDS, 365 * 86400);
  // 调度器 15 秒一跳，下限必须 ≥ 15 秒，否则用户设的值会被静默降级
  assert.ok(INTERVAL_MIN_SECONDS >= 15);
  // 上限正好是一整年，用户选「365 天」时卡在边界上而不是越界
  assert.equal(INTERVAL_MAX_SECONDS % 86400, 0);
});
