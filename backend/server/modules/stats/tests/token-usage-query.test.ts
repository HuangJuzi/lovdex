import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimeseries,
  buildSummary,
  pickBucketMs,
  isAllowedBucketMs,
  resolveRange,
} from '../services/token-usage-query.service.js';

const MIN = 60_000;

test('pickBucketMs 按范围自适应，边界取较小桶', () => {
  assert.equal(pickBucketMs(60 * MIN), MIN);            // 1h → 1 分钟桶
  assert.equal(pickBucketMs(6 * 60 * MIN), MIN);        // 恰好 6h → 仍是 1 分钟
  assert.equal(pickBucketMs(6 * 60 * MIN + 1), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN + 1), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN + 1), 24 * 60 * MIN);
});

test('isAllowedBucketMs 只接受 60000 的正整数倍', () => {
  assert.equal(isAllowedBucketMs(MIN), true);
  assert.equal(isAllowedBucketMs(5 * MIN), true);
  assert.equal(isAllowedBucketMs(0), false);
  assert.equal(isAllowedBucketMs(-MIN), false);
  assert.equal(isAllowedBucketMs(30_000), false);
  assert.equal(isAllowedBucketMs(Number.NaN), false);
});

test('resolveRange 缺省为最近 24 小时，且容忍 from >= to', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(resolveRange(undefined, undefined, now), { from: now - 24 * 60 * MIN, to: now });
  assert.deepEqual(resolveRange(1000, 2000, now), { from: 1000, to: 2000 });
  // 只给 from 时上界补 now
  assert.deepEqual(resolveRange(1000, undefined, now), { from: 1000, to: now });
  // from >= to 属矛盾输入 → 回退默认窗口，避免返回空数组让前端误以为没数据
  assert.deepEqual(resolveRange(5000, 5000, now), { from: now - 24 * 60 * MIN, to: now });
});

test('buildTimeseries 补零到连续桶，tpm 按桶分钟数换算', () => {
  // from 必须先对齐到桶边界，否则聚合行的 bucket_ts 与补零循环的起点对不上
  const from = Math.floor(1_700_000_000_000 / MIN) * MIN;
  const to = from + 3 * MIN;
  const buckets = buildTimeseries(
    [{ bucket_ts: from, model: 'm-a', tokens: 600 }],
    { from, to, bucketMs: MIN },
  );
  assert.equal(buckets.length, 3, '空桶也要补出来');
  assert.equal(buckets[0].total, 600);
  assert.equal(buckets[0].tpm, 600);        // 1 分钟桶：600 tokens / 1 min
  assert.equal(buckets[1].total, 0);
  assert.equal(buckets[1].tpm, 0);
  assert.deepEqual(buckets[0].byModel, { 'm-a': 600 });
});

test('buildTimeseries 在 5 分钟桶下把 tpm 归一成每分钟', () => {
  const from = Math.floor(1_700_000_000_000 / (5 * MIN)) * (5 * MIN);
  const buckets = buildTimeseries(
    [{ bucket_ts: from, model: 'm-a', tokens: 3000 }],
    { from, to: from + 5 * MIN, bucketMs: 5 * MIN },
  );
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].tpm, 600);        // 3000 tokens / 5 min
});

test('buildSummary 算 share / tpmAvg / tpmPeak / sessions', () => {
  const from = 1_700_000_000_000;
  const to = from + 10 * MIN;
  const summary = buildSummary(
    [
      { model: 'm-a', tokens: 600, sessions: 2, last_used_at: from + MIN },
      { model: 'm-b', tokens: 400, sessions: 1, last_used_at: from },
    ],
    [{ model: 'm-a', peak: 300 }],
    { from, to },
  );
  assert.equal(summary.totalTokens, 1000);
  const a = summary.byModel.find((m) => m.model === 'm-a');
  assert.ok(a);
  assert.equal(a.share, 0.6);
  assert.equal(a.tpmAvg, 60);               // 600 / 10 min
  assert.equal(a.tpmPeak, 300);             // 来自 1 分钟粒度查询，不是 10 分钟桶
  assert.equal(a.sessions, 2);
  // 没有峰值记录的模型回落 0 而不是 undefined
  const b = summary.byModel.find((m) => m.model === 'm-b');
  assert.equal(b?.tpmPeak, 0);
});

test('空区间返回空 buckets 与零总量，不抛错', () => {
  const from = 1_700_000_000_000;
  const summary = buildSummary([], [], { from, to: from + MIN });
  assert.equal(summary.totalTokens, 0);
  assert.deepEqual(summary.byModel, []);
});

test('buildTimeseries 对非法 bucketMs 返回空数组而不是死循环', () => {
  // 负桶：`ts += bucketMs` 会朝 to 的反方向走，永远到不了终点 → 无限循环 + 无限分配。
  // 0 / NaN / ±Infinity 的起点对齐结果是 NaN，循环本就不会进入，但同样应视为非法输入。
  const from = 1_700_000_000_000;
  for (const bucketMs of [0, -MIN, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(
      buildTimeseries([{ bucket_ts: from, model: 'm-a', tokens: 600 }], {
        from,
        to: from + MIN,
        bucketMs,
      }),
      [],
      `bucketMs=${bucketMs} 应返回空数组`,
    );
  }
});
