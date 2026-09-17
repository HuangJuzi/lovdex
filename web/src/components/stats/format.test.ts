import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChartRows,
  componentShares,
  EMPTY_COMPONENTS,
  groupByDimension,
  metricValue,
  METRICS,
  pickBucketMs,
  formatTokenCount,
  formatTpm,
  formatBucketLabel,
  TIME_RANGES,
  vendorOf,
  type DimensionInput,
  type TokenComponents,
} from './format';

const MIN = 60_000;

/** 构造四类分量，省得每处都写全字段。 */
function components(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): TokenComponents {
  return { input, output, cacheRead, cacheCreation };
}

test('pickBucketMs 与后端规则一致', () => {
  assert.equal(pickBucketMs(60 * MIN), MIN);
  assert.equal(pickBucketMs(6 * 60 * MIN), MIN);
  assert.equal(pickBucketMs(6 * 60 * MIN + 1), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN), 5 * MIN);
  assert.equal(pickBucketMs(24 * 60 * MIN + 1), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN), 60 * MIN);
  assert.equal(pickBucketMs(7 * 24 * 60 * MIN + 1), 24 * 60 * MIN);
});

test('TIME_RANGES 的每个预设都能推出合法桶', () => {
  for (const range of TIME_RANGES) {
    assert.ok(range.label.length > 0);
    assert.ok(range.ms > 0);
    assert.equal(pickBucketMs(range.ms) % MIN, 0);
  }
});

test('formatTokenCount 用 K/M 缩写并保留一位小数', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1.0K');
  assert.equal(formatTokenCount(1234), '1.2K');
  assert.equal(formatTokenCount(1_000_000), '1.0M');
  assert.equal(formatTokenCount(12_345_678), '12.3M');
});

test('formatTpm 处理小数值与空值', () => {
  assert.equal(formatTpm(0), '0');
  assert.equal(formatTpm(12.34), '12.3');
  assert.equal(formatTpm(1234.5), '1.2K');
});

test('formatBucketLabel 按桶大小切换格式', () => {
  const ts = new Date(2026, 8, 17, 14, 30, 0).getTime(); // 本地时间 2026-09-17 14:30
  assert.equal(formatBucketLabel(ts, MIN), '14:30');
  assert.equal(formatBucketLabel(ts, 60 * MIN), '14:00');
  assert.equal(formatBucketLabel(ts, 24 * 60 * MIN), '09-17');
});

// ---------------------------------------------------------------------------
// 附录 A.3：口径 / 维度 / 构成条
// ---------------------------------------------------------------------------

test('METRICS 覆盖三个口径且默认口径是 all', () => {
  assert.deepEqual(
    METRICS.map((m) => m.value),
    ['all', 'new', 'output'],
  );
  for (const metric of METRICS) {
    assert.ok(metric.label.length > 0);
    assert.ok(metric.hint.length > 0);
  }
});

test('EMPTY_COMPONENTS 四类分量全零', () => {
  assert.deepEqual(EMPTY_COMPONENTS, components(0, 0, 0, 0));
});

test('metricValue 三个口径各自取对应分量', () => {
  const sample = components(10, 3, 100, 7);
  assert.equal(metricValue(sample, 'all'), 120); // 10 + 3 + 100 + 7
  assert.equal(metricValue(sample, 'new'), 13); // 10 + 3，排除缓存重读
  assert.equal(metricValue(sample, 'output'), 3); // 只算生成
  // 口径之间必须满足 全部 ≥ 仅新增 ≥ 仅输出（非负分量的直接推论）
  assert.ok(metricValue(sample, 'all') >= metricValue(sample, 'new'));
  assert.ok(metricValue(sample, 'new') >= metricValue(sample, 'output'));
  assert.equal(metricValue(EMPTY_COMPONENTS, 'all'), 0);
});

test('vendorOf 把已知厂商归一', () => {
  assert.equal(vendorOf('deepseek-chat'), 'DeepSeek');
  assert.equal(vendorOf('DeepSeek-V3'), 'DeepSeek');
  assert.equal(vendorOf('glm-4.6'), 'GLM');
  assert.equal(vendorOf('zhipu-glm'), 'GLM');
  assert.equal(vendorOf('chatglm3'), 'GLM');
  assert.equal(vendorOf('kimi-k2'), 'Kimi');
  assert.equal(vendorOf('moonshot-v1-8k'), 'Kimi');
  assert.equal(vendorOf('claude-sonnet-4-5'), 'Claude');
  assert.equal(vendorOf('claude-opus-4-1'), 'Claude');
  assert.equal(vendorOf('haiku'), 'Claude');
  assert.equal(vendorOf('anthropic/claude-3'), 'Claude');
  assert.equal(vendorOf('gpt-4o'), 'GPT');
  assert.equal(vendorOf('openai/gpt-5'), 'GPT');
  assert.equal(vendorOf('o1-preview'), 'GPT');
  assert.equal(vendorOf('o3-mini'), 'GPT');
  assert.equal(vendorOf('minimax-m2'), 'MiniMax');
  assert.equal(vendorOf('abab6.5s-chat'), 'MiniMax');
  assert.equal(vendorOf('gemini-2.5-pro'), 'Gemini');
  assert.equal(vendorOf('palm-2'), 'Gemini');
  assert.equal(vendorOf('qwen-max'), 'Qwen');
  assert.equal(vendorOf('tongyi-qianwen'), 'Qwen');
});

test('vendorOf 认不出时原样返回，不混进"其他"桶', () => {
  assert.equal(vendorOf('llama-3-70b'), 'llama-3-70b');
  assert.equal(vendorOf('mistral-large'), 'mistral-large');
  assert.equal(vendorOf(''), '');
});

test('groupByDimension 在 model 维度下是恒等映射', () => {
  const byModel = {
    'claude-sonnet-4-5': components(1, 2, 3, 4),
    'deepseek-chat': components(5, 6, 7, 8),
  };
  assert.deepEqual(groupByDimension(byModel, 'model'), byModel);
});

test('groupByDimension 在 vendor 维度下归并同族模型并相加分量', () => {
  const byModel = {
    'claude-sonnet-4-5': components(10, 1, 100, 5),
    'claude-opus-4-1': components(20, 2, 200, 6),
    'deepseek-chat': components(30, 3, 300, 7),
    'llama-3-70b': components(40, 4, 400, 8), // 认不出，自己成一个键
  };
  const grouped = groupByDimension(byModel, 'vendor');

  assert.deepEqual(Object.keys(grouped).sort(), ['Claude', 'DeepSeek', 'llama-3-70b']);
  assert.deepEqual(grouped.Claude, components(30, 3, 300, 11));
  assert.deepEqual(grouped.DeepSeek, components(30, 3, 300, 7));
  assert.deepEqual(grouped['llama-3-70b'], components(40, 4, 400, 8));

  // 归并是无损的：每个口径的标量总量在归并前后相等
  for (const metric of ['all', 'new', 'output'] as const) {
    const before = Object.values(byModel).reduce((sum, c) => sum + metricValue(c, metric), 0);
    const after = Object.values(grouped).reduce((sum, c) => sum + metricValue(c, metric), 0);
    assert.equal(after, before);
  }
});

test('groupByDimension 空输入返回空对象', () => {
  assert.deepEqual(groupByDimension({}, 'model'), {});
  assert.deepEqual(groupByDimension({}, 'vendor'), {});
});

test('componentShares 占比求和为 1 且顺序固定', () => {
  const shares = componentShares(components(10, 3, 100, 7)); // total 120
  assert.deepEqual(
    shares.map((row) => row.key),
    ['input', 'output', 'cacheRead', 'cacheCreation'],
  );
  assert.equal(shares[0].share, 10 / 120);
  assert.equal(shares[1].share, 3 / 120);
  assert.equal(shares[2].share, 100 / 120);
  assert.equal(shares[3].share, 7 / 120);
  const sum = shares.reduce((acc, row) => acc + row.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `shares 求和应约为 1，实际 ${sum}`);
  for (const row of shares) {
    assert.ok(row.label.length > 0);
    assert.ok(row.color.length > 0);
  }
});

test('componentShares 总量为 0 时返回全 0 而不是 NaN', () => {
  const shares = componentShares(EMPTY_COMPONENTS);
  assert.equal(shares.length, 4);
  for (const row of shares) {
    assert.equal(row.share, 0);
    assert.ok(Number.isFinite(row.share));
  }
});

// ---------------------------------------------------------------------------
// 附录 A.4：buildChartRows
// ---------------------------------------------------------------------------

test('buildChartRows 维度键按 all-token 总量降序', () => {
  const buckets = [
    {
      ts: 0,
      byModel: {
        small: components(5, 5, 0, 0), // all = 10
        big: components(60, 20, 15, 5), // all = 100
        mid: components(30, 10, 5, 5), // all = 50
      },
    },
  ];
  const { keys } = buildChartRows(buckets, 'all', 'model');
  assert.deepEqual(keys, ['big', 'mid', 'small']);
});

test('buildChartRows 输出桶内原始计数（未做 TPM 归一化）', () => {
  const buckets = [
    { ts: 0, byModel: { a: components(60, 20, 15, 5), b: components(5, 5, 0, 0) } },
  ];
  assert.deepEqual(buildChartRows(buckets, 'all', 'model').rows, [{ ts: 0, a: 100, b: 10 }]);
  assert.deepEqual(buildChartRows(buckets, 'new', 'model').rows, [{ ts: 0, a: 80, b: 10 }]);
  assert.deepEqual(buildChartRows(buckets, 'output', 'model').rows, [{ ts: 0, a: 20, b: 5 }]);
});

test('buildChartRows 空桶补零且保留 ts', () => {
  const buckets: DimensionInput[] = [
    { ts: 0, byModel: { a: components(10, 0, 0, 0) } },
    { ts: MIN, byModel: {} },
  ];
  const { rows, keys } = buildChartRows(buckets, 'all', 'model');
  assert.deepEqual(keys, ['a']);
  assert.deepEqual(rows, [
    { ts: 0, a: 10 },
    { ts: MIN, a: 0 },
  ]);
});

test('buildChartRows 每个桶都补齐全部维度键', () => {
  const buckets: DimensionInput[] = [
    { ts: 0, byModel: { a: components(10, 0, 0, 0) } },
    { ts: MIN, byModel: { b: components(1, 0, 0, 0) } },
  ];
  const { rows, keys } = buildChartRows(buckets, 'all', 'model');
  assert.deepEqual(keys, ['a', 'b']);
  assert.deepEqual(rows, [
    { ts: 0, a: 10, b: 0 },
    { ts: MIN, a: 0, b: 1 },
  ]);
});

test('buildChartRows 支持 vendor 维度归并', () => {
  const buckets = [
    {
      ts: 0,
      byModel: {
        'claude-sonnet-4-5': components(10, 1, 100, 5),
        'claude-opus-4-1': components(20, 2, 200, 6),
        'deepseek-chat': components(30, 3, 300, 7),
      },
    },
  ];
  // all-token 总量：Claude 116+228=344，DeepSeek 340 → Claude 在前
  const { rows, keys } = buildChartRows(buckets, 'new', 'vendor');
  assert.deepEqual(keys, ['Claude', 'DeepSeek']);
  assert.deepEqual(rows, [{ ts: 0, Claude: 33, DeepSeek: 33 }]);
});

test('buildChartRows 无桶时返回空', () => {
  const { rows, keys } = buildChartRows([], 'all', 'model');
  assert.deepEqual(rows, []);
  assert.deepEqual(keys, []);
});
