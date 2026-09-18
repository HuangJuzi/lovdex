import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOM_OPTIONS,
  DOW_OPTIONS,
  buildCronPreset,
  parseCronPreset,
  resolveCronExpr,
  type CronPreset,
} from './cronPreset';

test('parseCronPreset recognises the four preset shapes', () => {
  assert.deepEqual(parseCronPreset('0 8 * * *'), { mode: 'daily', time: '08:00', dow: '1', dom: '1' });
  assert.deepEqual(parseCronPreset('30 6 * * 0'), { mode: 'weekly', time: '06:30', dow: '0', dom: '1' });
  assert.deepEqual(parseCronPreset('0 9 * * 1-5'), { mode: 'weekday', time: '09:00', dow: '1', dom: '1' });
  assert.deepEqual(parseCronPreset('0 10 15 * *'), { mode: 'monthly', time: '10:00', dow: '1', dom: '15' });
});

test('parseCronPreset returns null for anything it cannot represent exactly', () => {
  // 多值 / 列表 / 步进 / 段数不对 / 越界 / dom 与 dow 同时非 * —— 一律落到「自定义」，
  // 原始表达式一个字符都不改。
  for (const expr of ['0 9,17 * * *', '0 9 * * 1,3', '*/5 * * * *', '0 9 * *', '0 9 * * * * *', '99 9 * * *', '0 24 * * *', '0 9 15 * 1', '0 9 * 3 *']) {
    assert.equal(parseCronPreset(expr), null, `expected null for ${expr}`);
  }
});

test('parse and build round-trip exactly', () => {
  const cases: CronPreset[] = [
    { mode: 'daily', time: '08:00', dow: '1', dom: '1' },
    { mode: 'weekly', time: '06:30', dow: '0', dom: '1' },
    { mode: 'weekly', time: '23:59', dow: '6', dom: '1' },
    { mode: 'weekday', time: '09:00', dow: '1', dom: '1' },
    { mode: 'monthly', time: '10:00', dow: '1', dom: '15' },
  ];
  for (const c of cases) {
    assert.deepEqual(parseCronPreset(buildCronPreset(c)), c, `round trip failed for ${JSON.stringify(c)}`);
  }
});

test('buildCronPreset returns an empty string for an invalid time', () => {
  for (const time of ['', '9', '25:00', '09:60', 'ab:cd']) {
    assert.equal(buildCronPreset({ mode: 'daily', time, dow: '1', dom: '1' }), '', `expected '' for ${time}`);
  }
});

test('resolveCronExpr: custom passes the raw expression through untouched', () => {
  assert.equal(
    resolveCronExpr({ cronMode: 'custom', cronExpr: '0 9,17 * * *', cronTime: '09:00', cronDow: '1', cronDom: '1' }),
    '0 9,17 * * *',
  );
});

test('resolveCronExpr: preset modes ignore cronExpr and rebuild from the parameters', () => {
  assert.equal(
    resolveCronExpr({ cronMode: 'daily', cronExpr: '0 9,17 * * *', cronTime: '08:00', cronDow: '1', cronDom: '1' }),
    '0 8 * * *',
  );
  assert.equal(
    resolveCronExpr({ cronMode: 'weekday', cronExpr: '', cronTime: '09:30', cronDow: '1', cronDom: '1' }),
    '30 9 * * 1-5',
  );
  assert.equal(
    resolveCronExpr({ cronMode: 'weekly', cronExpr: '', cronTime: '06:00', cronDow: '3', cronDom: '1' }),
    '0 6 * * 3',
  );
  assert.equal(
    resolveCronExpr({ cronMode: 'monthly', cronExpr: '', cronTime: '10:00', cronDow: '1', cronDom: '15' }),
    '0 10 15 * *',
  );
});

test('the option tables cover every weekday and day-of-month', () => {
  assert.equal(DOW_OPTIONS.length, 7);
  assert.deepEqual(DOW_OPTIONS.map((o) => o.value), ['0', '1', '2', '3', '4', '5', '6']);
  assert.equal(DOM_OPTIONS.length, 31);
  assert.equal(DOM_OPTIONS[0].value, '1');
  assert.equal(DOM_OPTIONS[30].value, '31');
});
