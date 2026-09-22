import assert from 'node:assert/strict';
import test from 'node:test';

import type { BucketAggregateRow } from '@/modules/database/repositories/token-usage.db.js';

import {
  buildTimeseries,
  buildSummary,
  pickBucketMs,
  isAllowedBucketMs,
  resolveRange,
  MAX_RANGE_MS,
  MAX_BUCKETS,
  type TokenComponents,
} from '../services/token-usage-query.service.js';

const MIN = 60_000;

const ZERO_COMPONENTS: TokenComponents = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** 造一行聚合结果；四类分量显式给，避免测试读起来要回头查默认值。 */
function makeRow(
  bucket_ts: number,
  model: string,
  components: Partial<{ input: number; output: number; cacheRead: number; cacheCreation: number }> = {},
): BucketAggregateRow {
  return {
    bucket_ts,
    model,
    input_tokens: components.input ?? 0,
    output_tokens: components.output ?? 0,
    cache_read_tokens: components.cacheRead ?? 0,
    cache_creation_tokens: components.cacheCreation ?? 0,
  };
}

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

test('resolveRange 把超大跨度夹到 MAX_RANGE_MS，正常跨度不受影响', () => {
  const now = 1_700_000_000_000;

  // 上界是必需的：from=0&to=1e18 会让补零循环迭代 ~1.16e10 次并撑爆堆。
  const huge = resolveRange(0, 1_000_000_000_000_000_000, now);
  assert.equal(huge.to, 1_000_000_000_000_000_000);
  assert.equal(huge.to - huge.from, MAX_RANGE_MS, 'from 必须被夹到 to - MAX_RANGE_MS');

  // 恰好等于上界时不夹取
  const exact = resolveRange(now - MAX_RANGE_MS, now, now);
  assert.deepEqual(exact, { from: now - MAX_RANGE_MS, to: now });

  // 正常跨度（前端最大预设 30 天）原样透传
  const thirtyDays = 30 * 24 * 60 * MIN;
  assert.deepEqual(resolveRange(now - thirtyDays, now, now), { from: now - thirtyDays, to: now });
});

test('buildTimeseries 对超出 MAX_BUCKETS 的跨度返回空数组而不是挂死', () => {
  // 纵深防御：service 路径已被 resolveRange 夹住，但本函数是模块导出，
  // 直接调用时也不能让无界补零循环把进程 OOM 掉。
  assert.deepEqual(
    buildTimeseries([], { from: 0, to: 1_000_000_000_000_000_000, bucketMs: 24 * 60 * MIN }),
    [],
  );
  // 小桶 + 大跨度同样要挡住
  assert.deepEqual(
    buildTimeseries([], { from: 0, to: (MAX_BUCKETS + 1) * MIN, bucketMs: MIN }),
    [],
  );
  // 恰好等于上限仍应正常返回
  assert.equal(buildTimeseries([], { from: 0, to: MAX_BUCKETS * MIN, bucketMs: MIN }).length, MAX_BUCKETS);
});

test('buildTimeseries 补零到连续桶，四类分量原样透传', () => {
  // from 必须先对齐到桶边界，否则聚合行的 bucket_ts 与补零循环的起点对不上
  const from = Math.floor(1_700_000_000_000 / MIN) * MIN;
  const to = from + 3 * MIN;
  const buckets = buildTimeseries(
    [makeRow(from, 'm-a', { input: 600, output: 5, cacheRead: 3, cacheCreation: 1 })],
    { from, to, bucketMs: MIN },
  );
  assert.equal(buckets.length, 3, '空桶也要补出来');
  assert.deepEqual(buckets.map((b) => b.ts), [from, from + MIN, from + 2 * MIN]);
  assert.deepEqual(buckets[0].byModel, { 'm-a': { input: 600, output: 5, cacheRead: 3, cacheCreation: 1 } });
  // 空桶补的是四类零值，而不是缺 key / 缺模型
  assert.deepEqual(buckets[1].byModel, { 'm-a': ZERO_COMPONENTS });
  assert.deepEqual(buckets[2].byModel, { 'm-a': ZERO_COMPONENTS });
});

test('buildTimeseries 桶内只有四类分量，不再有合并的 total / tpm', () => {
  // 口径（全部 / 仅新增 / 仅输出）由前端按分量本地换算，切换不需要重新请求；
  // 后端一旦又合并出单一总量，cache_read 占 74% 这个事实就会被藏起来。
  const from = Math.floor(1_700_000_000_000 / MIN) * MIN;
  const buckets = buildTimeseries([makeRow(from, 'm-a', { input: 10, output: 1, cacheRead: 1000 })], {
    from,
    to: from + MIN,
    bucketMs: MIN,
  });
  const bucket = buckets[0];
  assert.ok(!('total' in bucket), '不应再有合并后的 total');
  assert.ok(!('tpm' in bucket), 'tpm 归一化已下放前端');
  // 主导项与细项都还在，且没有被折叠成同一个数
  assert.equal(bucket.byModel['m-a'].cacheRead, 1000);
  assert.equal(bucket.byModel['m-a'].output, 1);
});

test('buildTimeseries 不做每分钟归一：桶大小变了，分量仍是原始计数', () => {
  // 5 分钟桶里 3000 tokens 就是 3000，不再是「每分钟 600」——
  // 换算成 TPM 是前端拿 bucketMs 自己做的事，后端归一化会丢掉原始量级。
  const from = Math.floor(1_700_000_000_000 / (5 * MIN)) * (5 * MIN);
  const buckets = buildTimeseries([makeRow(from, 'm-a', { input: 3000 })], {
    from,
    to: from + 5 * MIN,
    bucketMs: 5 * MIN,
  });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].byModel['m-a'].input, 3000);
});

test('buildTimeseries 模型按全部 token 降序，且每个桶都补齐所有模型', () => {
  const from = Math.floor(1_700_000_000_000 / MIN) * MIN;
  const buckets = buildTimeseries(
    [
      // cache 主导的模型排最前：排序按「全部 token」，不是按 output 或 input
      makeRow(from, 'm-cache', { cacheRead: 1000, output: 1 }),
      makeRow(from, 'm-out', { output: 900 }),
      makeRow(from, 'm-small', { input: 1 }),
      makeRow(from + MIN, 'm-out', { output: 2 }),
    ],
    { from, to: from + 2 * MIN, bucketMs: MIN },
  );

  assert.deepEqual(Object.keys(buckets[0].byModel), ['m-cache', 'm-out', 'm-small']);
  // 第 2 个桶里 m-cache / m-small 没有数据，但 key 必须还在（补零），否则堆叠图会错位
  assert.deepEqual(Object.keys(buckets[1].byModel), ['m-cache', 'm-out', 'm-small']);
  assert.deepEqual(buckets[1].byModel['m-cache'], ZERO_COMPONENTS);
  assert.equal(buckets[1].byModel['m-out'].output, 2);
});

test('buildSummary 按模型返回四类分量 / 四档峰值 / 会话数', () => {
  const from = 1_700_000_000_000;
  const to = from + 10 * MIN;
  const summary = buildSummary(
    [
      {
        model: 'm-a',
        input_tokens: 600, output_tokens: 10, cache_read_tokens: 1000, cache_creation_tokens: 0,
        sessions: 2,
        last_used_at: from + MIN,
      },
      {
        model: 'm-b',
        input_tokens: 400, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 5,
        sessions: 1,
        last_used_at: from,
      },
    ],
    [{ model: 'm-a', peak_all: 300, peak_new: 120, peak_input: 90, peak_output: 30 }],
    { from, to },
  );

  assert.deepEqual(summary.range, { from, to });
  const a = summary.byModel.find((m) => m.model === 'm-a');
  assert.ok(a);
  assert.deepEqual(a.tokens, { input: 600, output: 10, cacheRead: 1000, cacheCreation: 0 });
  // 峰值来自 1 分钟粒度查询，四档各自独立（不是同一个数复制四份）
  assert.equal(a.peakAll, 300);
  assert.equal(a.peakNew, 120);
  assert.equal(a.peakInput, 90);
  assert.equal(a.peakOutput, 30);
  assert.equal(a.sessions, 2);
  assert.equal(a.lastUsedAt, from + MIN);

  // 没有峰值记录的模型四档都回落 0 而不是 undefined
  const b = summary.byModel.find((m) => m.model === 'm-b');
  assert.ok(b);
  assert.deepEqual(b.tokens, { input: 400, output: 0, cacheRead: 0, cacheCreation: 5 });
  assert.equal(b.peakAll, 0);
  assert.equal(b.peakNew, 0);
  assert.equal(b.peakInput, 0);
  assert.equal(b.peakOutput, 0);
});

test('buildSummary 不再返回依赖口径的 share / tpmAvg / totalTokens', () => {
  // 这三个值都随「全部 / 仅新增 / 仅输出」而变，必须由前端按分量算，
  // 后端给一个口径固定的数字只会被误用。
  const from = 1_700_000_000_000;
  const summary = buildSummary(
    [{
      model: 'm-a',
      input_tokens: 600, output_tokens: 0, cache_read_tokens: 400, cache_creation_tokens: 0,
      sessions: 1,
      last_used_at: from,
    }],
    [],
    { from, to: from + 10 * MIN },
  );
  const a = summary.byModel[0];
  assert.ok(!('share' in a));
  assert.ok(!('tpmAvg' in a));
  assert.ok(!('tpmPeak' in a));
  assert.ok(!('totalTokens' in summary));
});

test('空区间返回空 byModel，不抛错', () => {
  const from = 1_700_000_000_000;
  const summary = buildSummary([], [], { from, to: from + MIN });
  assert.deepEqual(summary.byModel, []);
  assert.deepEqual(summary.range, { from, to: from + MIN });
});

test('buildTimeseries 对非法 bucketMs 返回空数组而不是死循环', () => {
  // 负桶：`ts += bucketMs` 会朝 to 的反方向走，永远到不了终点 → 无限循环 + 无限分配。
  // 0 / NaN / ±Infinity 的起点对齐结果是 NaN，循环本就不会进入，但同样应视为非法输入。
  const from = 1_700_000_000_000;
  for (const bucketMs of [0, -MIN, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(
      buildTimeseries([makeRow(from, 'm-a', { input: 600 })], { from, to: from + MIN, bucketMs }),
      [],
      `bucketMs=${bucketMs} 应返回空数组`,
    );
  }
});
