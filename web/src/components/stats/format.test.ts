import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AXIS_MAX_TICKS,
  AXIS_MIN_TICKS,
  buildChartRows,
  componentShares,
  EMPTY_COMPONENTS,
  formatAxisTickParts,
  groupByDimension,
  metricValue,
  metricLabel,
  METRICS,
  pickAxisTargetTicks,
  pickAxisTickStride,
  pickBucketMs,
  formatTokenCount,
  formatTpm,
  formatBucketLabel,
  TIME_RANGES,
  mergeSummaryByVendor,
  vendorOf,
  type DimensionInput,
  type SummaryRow,
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
// 横轴刻度：宽度感知的刻度数 + 抽样步长 + 双行标签
//
// 背景：recharts 对 AreaChart 的 XAxis 恒走 categorical 分支，每个数据点都是
// 候选刻度；7 天视图 = 169 个 1 小时桶，默认的 'preserveEnd' 再按像素丢弃，
// 保留间隔 ≈20.x 小时（非整数）→ 钟点逐格漂移，且标签只有 HH:00 分不出是哪天。
//
// 修法两步：先用绘图区宽度定「目标刻度数」（窄屏自动变少，顶替被 interval={0}
// 关掉的像素过滤），再把步长吸附到「能整除一天的桶数」的约数上，让刻度落在
// 固定钟点上（否则 169 桶 / stride 13 会落在 12 个不同钟点上，仍然「乱跳」）。
// ---------------------------------------------------------------------------

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HOUR_MS = 60 * MIN;
const DAY_MS = 24 * HOUR_MS;

test('pickAxisTargetTicks 按绘图区宽度算目标刻度数', () => {
  // 绘图区 = 容器宽度 − YAxis 的 48px。桌面容器 ≈1374 → 1326/72 = 18 → 被上限截到 15
  assert.equal(pickAxisTargetTicks(1326), AXIS_MAX_TICKS);
  // 平板 768 − 32（卡片内边距）− 48 = 688 → floor(688/72) = 9
  assert.equal(pickAxisTargetTicks(688), 9);
  // 手机 390 − 32 − 48 = 310 → 4
  assert.equal(pickAxisTargetTicks(310), 4);
  // 小屏 360 − 32 − 48 = 280 → 3
  assert.equal(pickAxisTargetTicks(280), 3);
});

test('pickAxisTargetTicks 未测量/非法宽度回落到上限（首帧不能渲染 3 个刻度再跳变）', () => {
  assert.equal(pickAxisTargetTicks(0), AXIS_MAX_TICKS);
  assert.equal(pickAxisTargetTicks(-48), AXIS_MAX_TICKS);
  assert.equal(pickAxisTargetTicks(Number.NaN), AXIS_MAX_TICKS);
  assert.equal(pickAxisTargetTicks(Number.POSITIVE_INFINITY), AXIS_MAX_TICKS);
  // 极窄也不能低于下限
  assert.equal(pickAxisTargetTicks(1), AXIS_MIN_TICKS);
});

test('pickAxisTickStride 吸附到能整除一天的步长（验收表）', () => {
  const cases = [
    // 名称, 桶数, bucketMs, target, 期望 stride, 期望刻度数, 期望间隔
    ['桌面 7 天', 169, HOUR_MS, 15, 12, 15, 12 * HOUR_MS],
    ['桌面 1 小时', 61, MIN, 15, 4, 16, 4 * MIN],
    ['桌面 6 小时', 361, MIN, 15, 24, 16, 24 * MIN],
    ['桌面 24 小时', 289, 5 * MIN, 15, 24, 13, 2 * HOUR_MS],
    ['桌面 30 天', 31, DAY_MS, 15, 3, 11, 3 * DAY_MS],
    // 手机：吸附候选（24）会给出 8 个刻度、挤在 342px 里，必须回落到朴素步长
    ['手机 7 天', 169, HOUR_MS, 4, 43, 4, 43 * HOUR_MS],
  ] as const;

  for (const [name, bucketCount, bucketMs, target, stride, ticks, intervalMs] of cases) {
    const actual = pickAxisTickStride(bucketCount, target, bucketMs);
    assert.equal(actual, stride, `${name}: stride`);
    assert.equal(Math.ceil(bucketCount / actual), ticks, `${name}: 刻度数`);
    assert.equal(actual * bucketMs, intervalMs, `${name}: 相邻刻度间隔`);
  }
});

test('桌面 7 天：15 个刻度、间隔 12 小时、只出现 2 个钟点值', () => {
  const start = new Date(2026, 8, 11, 11, 0, 0).getTime(); // 窗口起点不是整点
  const stride = pickAxisTickStride(169, 15, HOUR_MS);
  const ticks = Array.from({ length: 169 }, (_, i) => start + i * HOUR_MS).filter(
    (_, i) => i % stride === 0,
  );
  assert.equal(ticks.length, 15);
  for (let i = 1; i < ticks.length; i++) {
    assert.equal(ticks[i] - ticks[i - 1], 12 * HOUR_MS);
  }

  const labels = ticks.map((ts) => formatAxisTickParts(ts, HOUR_MS, 7 * DAY_MS));
  // 吸附的意义：钟点只有 11:00 / 23:00 两个值，不再「乱跳」
  const clockValues = [...new Set(labels.map((l) => l.secondary))].sort();
  assert.deepEqual(clockValues, ['11:00', '23:00']);
  // 15 个标签两两不同（日期 + 时刻唯一），日期不回头
  const rendered = labels.map((l) => `${l.primary} ${l.secondary}`);
  assert.equal(new Set(rendered).size, rendered.length, `标签有重复：${rendered.join(' | ')}`);
  const dates = labels.map((l) => l.primary);
  assert.equal(new Set(dates).size, 8);
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i] >= dates[i - 1], `日期应逐日递增：${dates[i - 1]} → ${dates[i]}`);
  }
});

test('手机 7 天：回落到朴素步长，刻度数远小于桌面（窄屏防回归）', () => {
  const phoneStride = pickAxisTickStride(169, 4, HOUR_MS);
  const desktopStride = pickAxisTickStride(169, 15, HOUR_MS);
  // 不是吸附候选 24：那会渲染 8 个刻度、挤在 342px 里
  assert.equal(phoneStride, 43);
  assert.notEqual(phoneStride, 24);
  const phoneTicks = Math.ceil(169 / phoneStride);
  assert.equal(phoneTicks, 4);
  assert.ok(phoneTicks <= 4 + 2, '窄屏刻度数不能超出目标 +2');
  assert.ok(phoneTicks < Math.ceil(169 / desktopStride), '窄屏刻度数必须少于桌面');
});

test('pickAxisTickStride 对空/非法桶数退化到 1（不能返回 0 或负数）', () => {
  assert.equal(pickAxisTickStride(0, 15, HOUR_MS), 1);
  assert.equal(pickAxisTickStride(-5, 15, HOUR_MS), 1);
  assert.equal(pickAxisTickStride(Number.NaN, 15, HOUR_MS), 1);
  assert.equal(pickAxisTickStride(Number.POSITIVE_INFINITY, 15, HOUR_MS), 1);
});

test('pickAxisTickStride 没有整齐候选时回落朴素步长', () => {
  // bucketMs 非法 → 算不出「一天的桶数」
  assert.equal(pickAxisTickStride(169, 15, Number.NaN), Math.ceil(169 / 15));
  assert.equal(pickAxisTickStride(169, 15, 0), Math.ceil(169 / 15));
  // 桶比一天还大 → 一天的桶数 < 1，没有约数可枚举
  assert.equal(pickAxisTickStride(31, 15, 2 * DAY_MS), Math.ceil(31 / 15));
  // 一天的桶数只有 1 → 候选只有 1，刻度数远超 target+2 → 回落
  assert.equal(pickAxisTickStride(31, 15, DAY_MS), Math.ceil(31 / 15));
  // target 非法 → 与 AXIS_MAX_TICKS 等价
  assert.equal(pickAxisTickStride(169, Number.NaN, HOUR_MS), pickAxisTickStride(169, AXIS_MAX_TICKS, HOUR_MS));
});

test('pickAxisTickStride 的返回值要么是整齐步长，要么就是朴素回落', () => {
  for (const bucketMs of [MIN, 5 * MIN, HOUR_MS, DAY_MS]) {
    const bucketsPerDay = DAY_MS / bucketMs;
    for (const bucketCount of [31, 61, 169, 289, 361, 1440, 43200]) {
      for (const target of [AXIS_MIN_TICKS, 4, 9, AXIS_MAX_TICKS]) {
        const stride = pickAxisTickStride(bucketCount, target, bucketMs);
        const isAligned = bucketsPerDay % stride === 0;
        const isNaive = stride === Math.ceil(bucketCount / target);
        assert.ok(
          isAligned || isNaive,
          `bucketMs=${bucketMs} count=${bucketCount} target=${target} → stride=${stride} 既不是整齐步长也不是朴素回落`,
        );
      }
    }
  }
});

test('pickAxisTickStride 在任何桶数下都保证刻度数不失控', () => {
  for (const count of [1, 30, 168, 169, 288, 360, 1000, 43200]) {
    for (const target of [AXIS_MIN_TICKS, 9, AXIS_MAX_TICKS]) {
      const stride = pickAxisTickStride(count, target, HOUR_MS);
      assert.ok(Number.isInteger(stride) && stride >= 1, `${count} 个桶的步长应为正整数，实际 ${stride}`);
      // 吸附分支允许最多 target+2 个刻度（否则就回落了），再留一点取整余量
      assert.ok(
        Math.ceil(count / stride) <= target + 2,
        `${count} 个桶 / target ${target} 用步长 ${stride} 会渲染出 ${Math.ceil(count / stride)} 个刻度`,
      );
    }
  }
});

test('formatAxisTickParts 跨度 ≤ 24h 时单行只显示时刻', () => {
  const onTheHour = new Date(2026, 8, 17, 14, 0, 0).getTime();
  const onTheFive = new Date(2026, 8, 17, 14, 5, 0).getTime();
  // 1 小时窗口 / 1 分钟桶
  assert.deepEqual(formatAxisTickParts(onTheHour, MIN, 60 * MIN), { primary: '14:00' });
  // 6 小时窗口 / 1 分钟桶
  assert.deepEqual(formatAxisTickParts(onTheHour, MIN, 6 * HOUR), { primary: '14:00' });
  // 24 小时窗口 / 5 分钟桶：一天之内，日期是冗余信息，但分钟要保留
  assert.deepEqual(formatAxisTickParts(onTheFive, 5 * MIN, 23 * HOUR), { primary: '14:05' });
});

test('formatAxisTickParts 桶 ≥ 24h 时单行只显示日期', () => {
  const ts = new Date(2026, 8, 17, 0, 0, 0).getTime();
  // 30 天视图：每天一个桶，时刻恒为 00:00，显示是噪音
  assert.deepEqual(formatAxisTickParts(ts, DAY, 30 * DAY), { primary: '09-17' });
  assert.deepEqual(formatAxisTickParts(ts, DAY, 7 * DAY), { primary: '09-17' });
});

test('formatAxisTickParts 跨天 + 亚日桶时双行（上行日期，下行时刻）', () => {
  const ts = new Date(2026, 8, 17, 14, 0, 0).getTime();
  assert.deepEqual(formatAxisTickParts(ts, HOUR, 7 * DAY), { primary: '09-17', secondary: '14:00' });
  // 亚小时桶也要带上真实分钟，而不是像 formatBucketLabel 那样取整到 :00
  const ts5 = new Date(2026, 8, 17, 14, 35, 0).getTime();
  assert.deepEqual(formatAxisTickParts(ts5, 5 * MIN, 7 * DAY), { primary: '09-17', secondary: '14:35' });
});

test('formatAxisTickParts 跨天时主行随日期变化（不退回只有钟点）', () => {
  const spanMs = 7 * DAY;
  const day1 = new Date(2026, 8, 17, 14, 0, 0).getTime();
  const day2 = new Date(2026, 8, 18, 14, 0, 0).getTime();
  const first = formatAxisTickParts(day1, HOUR, spanMs);
  const second = formatAxisTickParts(day2, HOUR, spanMs);

  assert.equal(first.primary, '09-17');
  assert.equal(second.primary, '09-18');
  assert.notEqual(first.primary, second.primary);
  // 同一钟点、不同日期：老实现（只有 HH:00）会渲染出两个一模一样的标签
  assert.equal(first.secondary, second.secondary);
});

// ---------------------------------------------------------------------------
// 附录 A.3：口径 / 维度 / 构成条
// ---------------------------------------------------------------------------

test('METRICS 覆盖四个口径且默认口径是 all', () => {
  assert.deepEqual(
    METRICS.map((m) => m.value),
    ['all', 'new', 'input', 'output'],
  );
  assert.deepEqual(
    METRICS.map((m) => m.label),
    ['全部', '仅新增', '仅输入', '仅输出'],
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
  for (const metric of ['all', 'new', 'input', 'output'] as const) {
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

// ---------------------------------------------------------------------------
// 附录 A.6：mergeSummaryByVendor
// ---------------------------------------------------------------------------

/** 构造一行 summary 记录，省得每处都写全字段。peaks 顺序：all / new / input / output。 */
function summaryRow(
  model: string,
  tokens: TokenComponents,
  peaks: [number, number, number, number],
  sessions: number,
  lastUsedAt: number,
): SummaryRow {
  return {
    model,
    tokens,
    peakAll: peaks[0],
    peakNew: peaks[1],
    peakInput: peaks[2],
    peakOutput: peaks[3],
    sessions,
    lastUsedAt,
  };
}

test('mergeSummaryByVendor 把同族模型归并成一行', () => {
  const merged = mergeSummaryByVendor([
    summaryRow('claude-sonnet-4-5', components(10, 1, 100, 5), [500, 50, 45, 10], 3, 1000),
    summaryRow('claude-opus-4-1', components(20, 2, 200, 6), [900, 80, 70, 20], 4, 2000),
    summaryRow('deepseek-chat', components(30, 3, 300, 7), [700, 70, 60, 30], 5, 1500),
  ]);

  assert.deepEqual(
    merged.map((row) => row.model).sort(),
    ['Claude', 'DeepSeek'],
  );

  const claude = merged.find((row) => row.model === 'Claude');
  const deepseek = merged.find((row) => row.model === 'DeepSeek');
  assert.ok(claude && deepseek);

  // tokens / sessions 相加
  assert.deepEqual(claude.tokens, components(30, 3, 300, 11));
  assert.equal(claude.sessions, 7);
  assert.deepEqual(deepseek.tokens, components(30, 3, 300, 7));
  assert.equal(deepseek.sessions, 5);

  // peak* 取 max（不是相加：峰值是瞬时量，相加没有意义）
  assert.equal(claude.peakAll, 900);
  assert.equal(claude.peakNew, 80);
  assert.equal(claude.peakInput, 70, 'peakInput 取 max（45 vs 70）');
  assert.equal(claude.peakOutput, 20);
  assert.equal(deepseek.peakAll, 700);
});

test('mergeSummaryByVendor 的 lastUsedAt 取 max', () => {
  const merged = mergeSummaryByVendor([
    summaryRow('claude-sonnet-4-5', components(1, 0, 0, 0), [1, 1, 1, 1], 1, 1000),
    summaryRow('claude-opus-4-1', components(1, 0, 0, 0), [1, 1, 1, 1], 1, 9000),
    summaryRow('claude-haiku', components(1, 0, 0, 0), [1, 1, 1, 1], 1, 5000),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lastUsedAt, 9000);
});

test('mergeSummaryByVendor 认不出的模型各自保留原 id', () => {
  const merged = mergeSummaryByVendor([
    summaryRow('llama-3-70b', components(1, 0, 0, 0), [1, 1, 1, 1], 1, 100),
    summaryRow('mistral-large', components(2, 0, 0, 0), [2, 2, 2, 2], 1, 200),
  ]);
  assert.deepEqual(
    merged.map((row) => row.model).sort(),
    ['llama-3-70b', 'mistral-large'],
  );
});

test('mergeSummaryByVendor 归并是无损的：各口径总量守恒', () => {
  const rows = [
    summaryRow('claude-sonnet-4-5', components(10, 1, 100, 5), [500, 50, 45, 10], 3, 1000),
    summaryRow('claude-opus-4-1', components(20, 2, 200, 6), [900, 80, 70, 20], 4, 2000),
    summaryRow('deepseek-chat', components(30, 3, 300, 7), [700, 70, 60, 30], 5, 1500),
    summaryRow('llama-3-70b', components(40, 4, 400, 8), [800, 90, 75, 40], 6, 500),
  ];
  const merged = mergeSummaryByVendor(rows);

  for (const metric of ['all', 'new', 'input', 'output'] as const) {
    const before = rows.reduce((sum, row) => sum + metricValue(row.tokens, metric), 0);
    const after = merged.reduce((sum, row) => sum + metricValue(row.tokens, metric), 0);
    assert.equal(after, before, `${metric} 口径归并前后总量应相等`);
  }
  assert.equal(
    merged.reduce((sum, row) => sum + row.sessions, 0),
    rows.reduce((sum, row) => sum + row.sessions, 0),
  );
  // 模型数只减不增
  assert.ok(merged.length <= rows.length);
});

test('mergeSummaryByVendor 空输入返回空数组', () => {
  assert.deepEqual(mergeSummaryByVendor([]), []);
});

test('mergeSummaryByVendor 单行也换成厂商键', () => {
  const rows = [summaryRow('deepseek-chat', components(1, 2, 3, 4), [9, 8, 6, 7], 2, 42)];
  assert.deepEqual(mergeSummaryByVendor(rows), [{ ...rows[0], model: 'DeepSeek' }]);
});

test('mergeSummaryByVendor 认不出的单行原样返回', () => {
  const rows = [summaryRow('llama-3-70b', components(1, 2, 3, 4), [9, 8, 6, 7], 2, 42)];
  assert.deepEqual(mergeSummaryByVendor(rows), rows);
});

test('metricLabel 与 METRICS 标签一致', () => {
  for (const m of METRICS) {
    assert.equal(metricLabel(m.value), m.label);
  }
});

test('metricValue 的仅输入档只取 input', () => {
  const c = components(600, 10, 1000, 5);
  assert.equal(metricValue(c, 'all'), 1615);
  assert.equal(metricValue(c, 'new'), 610);
  assert.equal(metricValue(c, 'input'), 600);
  assert.equal(metricValue(c, 'output'), 10);
});

test('mergeSummaryByVendor 对 peakInput 取 max（瞬时量不能相加）', () => {
  const merged = mergeSummaryByVendor([
    summaryRow('deepseek-a', components(0, 0, 0, 0), [10, 5, 3, 1], 1, 100),
    summaryRow('deepseek-b', components(0, 0, 0, 0), [7, 2, 9, 4], 1, 200),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].peakInput, 9, 'peakInput 取 max 而不是相加');
});
