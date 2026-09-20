const MINUTE_MS = 60_000;

/**
 * 时间范围预设。`ms` 与后端 `pickBucketMs` 的阶梯对应，
 * 保证两端对同一区间算出同一个桶大小。
 */
export const TIME_RANGES: { label: string; ms: number }[] = [
  { label: '1 小时', ms: 60 * MINUTE_MS },
  { label: '6 小时', ms: 6 * 60 * MINUTE_MS },
  { label: '24 小时', ms: 24 * 60 * MINUTE_MS },
  { label: '7 天', ms: 7 * 24 * 60 * MINUTE_MS },
  { label: '30 天', ms: 30 * 24 * 60 * MINUTE_MS },
];

/** 与后端 token-usage-query.service.ts 的 BUCKET_STEPS 保持一致。 */
export function pickBucketMs(rangeMs: number): number {
  if (rangeMs <= 6 * 60 * MINUTE_MS) return MINUTE_MS;
  if (rangeMs <= 24 * 60 * MINUTE_MS) return 5 * MINUTE_MS;
  if (rangeMs <= 7 * 24 * 60 * MINUTE_MS) return 60 * MINUTE_MS;
  return 24 * 60 * MINUTE_MS;
}

/** token 数缩写：1234 → "1.2K"，12345678 → "12.3M"。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(value));
}

/** TPM 数值：小值保留一位小数，大值走 K/M 缩写。 */
export function formatTpm(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1000) {
    return formatTokenCount(value);
  }
  return value.toFixed(1);
}

/** x 轴刻度：桶越粗，标签越粗。 */
export function formatBucketLabel(ts: number, bucketMs: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (bucketMs >= 24 * 60 * MINUTE_MS) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  if (bucketMs >= 60 * MINUTE_MS) {
    return `${pad(date.getHours())}:00`;
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 悬浮提示里的完整时间。 */
export function formatFullTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 横轴刻度
//
// 为什么不能直接用 formatBucketLabel 当刻度：recharts 对 AreaChart 的 XAxis
// 恒走 categorical 分支（`isCategoricalAxis` 只看 `layout === 'horizontal' &&
// axisType === 'xAxis'`，与 `type` 无关），于是**每个数据点都是一个候选刻度**。
// 7 天视图 ≈169 个 1 小时桶 → 169 个候选，默认的 `interval: 'preserveEnd'`
// 再按像素从右往左丢弃，保留间隔 ≈20.x 小时这种**非整数**值，钟点就逐格漂移
// （14:00 → 17:00 → 21:00 → 01:00 …），且标签只有 `HH:00`，分不出是哪一天。
//
// 修法两步：先用绘图区宽度定「目标刻度数」（窄屏自动变少，顶替被 `interval={0}`
// 关掉的像素过滤），再把步长吸附到「能整除一天的桶数」的约数上（让刻度落在固定
// 钟点上，而不是 12 个互不相干的时刻），最后在 XAxis 上用 `interval={0}` 原样
// 渲染抽样结果。
// ---------------------------------------------------------------------------

/** 横轴目标刻度数的下限。再窄也要给出 3 个刻度，否则横轴没有参照。 */
export const AXIS_MIN_TICKS = 3;

/** 横轴目标刻度数的上限。桌面宽度下取到它。 */
export const AXIS_MAX_TICKS = 15;

/** 每个刻度至少需要的水平像素（双行标签约 35px 宽 + 间隙）。 */
export const MIN_TICK_SPACING_PX = 72;

/**
 * 按绘图区宽度算目标刻度数；未测量（0/NaN）时回落到 `AXIS_MAX_TICKS`。
 *
 * 这一层是**窄屏的安全网**：XAxis 上的 `interval={0}` 关掉了 recharts 的像素
 * 过滤（那正是消除钟点漂移的前提），代价是刻度不会再自动变少。手机 390px 下
 * 绘图区只剩 ~310px，若还按 15 个刻度排，相邻标签只有 ~21px 而标签本身约 35px
 * 宽 → 必然重叠。所以这里按宽度先把目标刻度数压下来。
 *
 * 未测量时返回上限而不是 0：首帧量不到宽度，若返回 3 会先渲染 3 个刻度、量到
 * 宽度后再跳变成 15 个，视觉上是明显的闪动。
 */
export function pickAxisTargetTicks(drawableWidthPx: number): number {
  if (!Number.isFinite(drawableWidthPx) || drawableWidthPx <= 0) {
    return AXIS_MAX_TICKS;
  }
  return Math.min(
    AXIS_MAX_TICKS,
    Math.max(AXIS_MIN_TICKS, Math.floor(drawableWidthPx / MIN_TICK_SPACING_PX)),
  );
}

/** `n` 的正约数（含 1 与 n）。`n` 必须是 >=1 的整数。 */
function divisorsOf(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i * i <= n; i += 1) {
    if (n % i === 0) {
      out.push(i);
      if (i !== n / i) {
        out.push(n / i);
      }
    }
  }
  return out;
}

/**
 * 按桶数算出抽样步长，使渲染出的刻度数接近 `targetTicks`。
 *
 * 步长必须是整数，否则刻度会落在桶中间；更进一步，**步长要吸附到「能整除一天的
 * 桶数」的约数上**：169 个 1 小时桶用朴素步长 13 会落在 12 个不同的钟点上
 * （11:00 → 00:00 → 13:00 → 02:00 …），用户看到的仍然是「小时数乱跳」。吸附到
 * 12 之后刻度只在 11:00 / 23:00 之间交替，日期成为唯一的变化量。
 *
 * 规则：
 * 1. 候选 = 一天的桶数（`86_400_000 / bucketMs`）的正约数；它必须是 >=1 的整数
 *    （桶比一天还大时没有候选）。
 * 2. 在候选里取「刻度数 `ceil(bucketCount / d)` 与 target 差值最小」的 d。
 * 3. 差值并列时取 **d 较大**的（刻度更少、更安静）。
 * 4. 若最优候选的刻度数 **> target + 2**（太密），或根本没有候选，则回落到朴素的
 *    `ceil(bucketCount / target)`。这一条是窄屏的关键：手机下 169 桶 / target 4
 *    的最佳候选是 24（8 个刻度），8 > 4 + 2 成立，于是回落到 43（4 个刻度）。
 */
export function pickAxisTickStride(
  bucketCount: number,
  targetTicks: number,
  bucketMs: number,
): number {
  const target =
    Number.isFinite(targetTicks) && targetTicks >= 1 ? Math.floor(targetTicks) : AXIS_MAX_TICKS;
  if (!Number.isFinite(bucketCount) || bucketCount <= 0) {
    return 1;
  }
  const naive = Math.max(1, Math.ceil(bucketCount / target));

  const bucketsPerDay = 86_400_000 / bucketMs;
  if (!Number.isInteger(bucketsPerDay) || bucketsPerDay < 1) {
    return naive;
  }

  let bestStride = 0;
  let bestTicks = 0;
  for (const candidate of divisorsOf(bucketsPerDay)) {
    const ticks = Math.ceil(bucketCount / candidate);
    if (bestStride === 0) {
      bestStride = candidate;
      bestTicks = ticks;
      continue;
    }
    const diff = Math.abs(ticks - target);
    const bestDiff = Math.abs(bestTicks - target);
    // 差值并列时取更大的 d（刻度更少）
    if (diff < bestDiff || (diff === bestDiff && candidate > bestStride)) {
      bestStride = candidate;
      bestTicks = ticks;
    }
  }

  if (bestStride === 0 || bestTicks > target + 2) {
    return naive;
  }
  return bestStride;
}

/**
 * 横轴刻度标签。双行还是单行由「跨度」和「桶大小」共同决定：
 * - 跨度 ≤ 24h → 单行 `HH:MM`（一天之内，日期是冗余信息）
 * - 桶 ≥ 24h → 单行 `MM-DD`（每天一个桶，时刻恒为同一个钟点，显示是噪音）
 * - 其余（跨天 + 亚日桶）→ 双行 `MM-DD` / `HH:MM`
 *
 * 与 `formatBucketLabel` 的分工：那个描述的是「单个桶的粒度」（Tooltip 用），
 * 这个描述的是「刻度之间的间距」——7 天视图的桶是 1 小时，但刻度隔 12 小时，
 * 只报 `HH:00` 就分不出是哪一天。两者刻意不共用实现。
 */
export function formatAxisTickParts(
  ts: number,
  bucketMs: number,
  spanMs: number,
): { primary: string; secondary?: string } {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (spanMs <= 24 * 60 * MINUTE_MS) {
    return { primary: time };
  }
  if (bucketMs >= 24 * 60 * MINUTE_MS) {
    return { primary: day };
  }
  return { primary: day, secondary: time };
}

/**
 * 给模型分配稳定的颜色。同一个模型在同一会话内始终拿到同一个颜色，
 * 避免筛选后颜色跳变。
 */
const MODEL_COLORS = [
  'hsl(var(--chart-1))',  // sky    → chart-1
  'hsl(var(--chart-2))',  // emerald → chart-2
  'hsl(var(--chart-9))',  // amber  → chart-9 (gold, closest hue)
  'hsl(var(--chart-6))',  // violet → chart-6
  'hsl(var(--chart-8))',  // red    → chart-8
  'hsl(var(--chart-3))',  // teal   → chart-3
  'hsl(var(--chart-7))',  // pink   → chart-7
  'hsl(var(--chart-5))',  // lime   → chart-5
  'hsl(var(--chart-4))',  // indigo → chart-4
  'hsl(var(--chart-10))', // orange → chart-10
];

export function colorForModel(model: string, allModels: string[]): string {
  const index = allModels.indexOf(model);
  return MODEL_COLORS[(index < 0 ? 0 : index) % MODEL_COLORS.length];
}

// ---------------------------------------------------------------------------
// 四类 token 分量 / 口径 / 维度
//
// 后端返回的是四类分量而不是一个总数（真实数据里 cache_read 占 74%、
// output 仅 0.3%，压成一个数会把「上下文被重读多少」伪装成「干了多少活」）。
// 口径与维度都是纯前端状态，切换时不需要重新请求。
// ---------------------------------------------------------------------------

/** 四类 token 分量，与后端 TokenComponents 对齐。 */
export type TokenComponents = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export const EMPTY_COMPONENTS: TokenComponents = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** TPM 口径。默认 `all`——与 provider 计费/限流口径一致。 */
export type TokenMetric = 'all' | 'new' | 'output';

export const METRICS: { value: TokenMetric; label: string; hint: string }[] = [
  { value: 'all', label: '全部', hint: 'input + output + 缓存读取 + 缓存写入（provider 计费口径）' },
  { value: 'new', label: '仅新增', hint: 'input + output，排除缓存重读' },
  { value: 'output', label: '仅输出', hint: '只算模型实际生成的内容' },
];

/** 按口径把四类分量折算成一个标量。 */
export function metricValue(components: TokenComponents, metric: TokenMetric): number {
  switch (metric) {
    case 'all':
      return components.input + components.output + components.cacheRead + components.cacheCreation;
    case 'new':
      return components.input + components.output;
    case 'output':
      return components.output;
  }
}

export function addComponents(a: TokenComponents, b: TokenComponents): TokenComponents {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

/** 四类分量在总量里的占比，用于构成条。返回顺序固定为 input/output/cacheRead/cacheCreation。 */
export function componentShares(components: TokenComponents): { key: keyof TokenComponents; label: string; share: number; color: string }[] {
  const total = metricValue(components, 'all');
  const rows: { key: keyof TokenComponents; label: string; color: string }[] = [
    { key: 'input', label: '输入', color: 'hsl(var(--chart-1))' },
    { key: 'output', label: '输出', color: 'hsl(var(--chart-2))' },
    { key: 'cacheRead', label: '缓存读取', color: 'hsl(var(--chart-9))' },
    { key: 'cacheCreation', label: '缓存写入', color: 'hsl(var(--chart-6))' },
  ];
  return rows.map((row) => ({ ...row, share: total > 0 ? components[row.key] / total : 0 }));
}

/** 维度切换。`vendor` 把同族模型归并；认不出的**原样返回**，避免把不同厂商混成一个桶。 */
export type TokenDimension = 'model' | 'vendor';

export const DIMENSIONS: { value: TokenDimension; label: string }[] = [
  { value: 'model', label: '按模型' },
  { value: 'vendor', label: '按厂商' },
];

const VENDOR_RULES: { pattern: RegExp; vendor: string }[] = [
  { pattern: /deepseek/i, vendor: 'DeepSeek' },
  { pattern: /glm|zhipu|chatglm/i, vendor: 'GLM' },
  { pattern: /kimi|moonshot/i, vendor: 'Kimi' },
  { pattern: /claude|opus|sonnet|haiku|anthropic/i, vendor: 'Claude' },
  { pattern: /gpt|openai|^o[13]-/i, vendor: 'GPT' },
  { pattern: /minimax|abab/i, vendor: 'MiniMax' },
  { pattern: /gemini|palm/i, vendor: 'Gemini' },
  { pattern: /qwen|tongyi/i, vendor: 'Qwen' },
];

export function vendorOf(model: string): string {
  for (const rule of VENDOR_RULES) {
    if (rule.pattern.test(model)) {
      return rule.vendor;
    }
  }
  // 认不出的保留原始 id：归并成一个 "其他" 会把无关模型混在一起，反而更难排查
  return model;
}

/** 把一行 byModel 记录按维度归并成「维度键 → 四类分量」。 */
export function groupByDimension(
  byModel: Record<string, TokenComponents>,
  dimension: TokenDimension,
): Record<string, TokenComponents> {
  if (dimension === 'model') {
    return byModel;
  }
  const grouped: Record<string, TokenComponents> = {};
  for (const [model, components] of Object.entries(byModel)) {
    const key = vendorOf(model);
    grouped[key] = addComponents(grouped[key] ?? EMPTY_COMPONENTS, components);
  }
  return grouped;
}

/**
 * `buildChartRows` 的输入形状。
 *
 * 刻意不 import `useTokenStats.ts` 的 `TimeseriesBucket`：那会让 format.ts
 * （纯工具）反向依赖 hook（React），既产生 import cycle 也把纯函数测试拖进 React 环境。
 * 两者结构完全一致，调用方直接传 `TimeseriesBucket[]` 即可。
 */
export type DimensionInput = { ts: number; byModel: Record<string, TokenComponents> };

/**
 * 把 buckets 摊成 recharts 需要的扁平行：`{ ts, [维度键]: 该口径的桶内计数 }`。
 *
 * 注意返回的是**桶内原始计数**，不是 TPM —— TPM 归一化由卡片按
 * `值 / (bucketMs / 60000)` 做。后端返回的本来就是计数。
 */
export function buildChartRows(
  buckets: DimensionInput[],
  metric: TokenMetric,
  dimension: TokenDimension,
): { rows: Record<string, number>[]; keys: string[] } {
  const keys = new Set<string>();
  const perBucket = buckets.map((bucket) => groupByDimension(bucket.byModel, dimension));
  for (const grouped of perBucket) {
    for (const key of Object.keys(grouped)) keys.add(key);
  }
  // 维度键按 all-token 总量降序，保证堆叠顺序稳定、大头在底部
  const totals = new Map<string, number>();
  for (const grouped of perBucket) {
    for (const [key, components] of Object.entries(grouped)) {
      totals.set(key, (totals.get(key) ?? 0) + metricValue(components, 'all'));
    }
  }
  const ordered = [...keys].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const rows = perBucket.map((grouped, index) => {
    const row: Record<string, number> = { ts: buckets[index].ts };
    for (const key of ordered) {
      row[key] = metricValue(grouped[key] ?? EMPTY_COMPONENTS, metric);
    }
    return row;
  });
  return { rows, keys: ordered };
}

/**
 * `mergeSummaryByVendor` 的输入形状。
 *
 * 与 `buildChartRows` 的 `DimensionInput` 同理，刻意不 import
 * `useTokenStats.ts` 的 `SummaryModelEntry`：那会让纯工具反向依赖 React hook。
 * 两者结构完全一致，调用方直接传 `SummaryResponse['byModel']` 即可。
 */
export type SummaryRow = {
  model: string;
  tokens: TokenComponents;
  peakAll: number;
  peakNew: number;
  peakOutput: number;
  sessions: number;
  lastUsedAt: number;
};

/**
 * 把 summary 的 byModel 行按厂商归并，用于 `dimension === 'vendor'` 的排行表。
 *
 * 归并规则：`tokens` / `sessions` **相加**（可累加的计数）；
 * `peak*` 与 `lastUsedAt` 取 **max**（瞬时量，相加没有意义——把两个模型
 * 各自 1 分钟的峰值加起来会造出一个从未发生过的峰值）。
 *
 * 保持首次出现的顺序，排序交给调用方按当前口径做。
 */
export function mergeSummaryByVendor(rows: SummaryRow[]): SummaryRow[] {
  const merged = new Map<string, SummaryRow>();
  for (const row of rows) {
    const key = vendorOf(row.model);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, model: key });
      continue;
    }
    merged.set(key, {
      model: key,
      tokens: addComponents(existing.tokens, row.tokens),
      peakAll: Math.max(existing.peakAll, row.peakAll),
      peakNew: Math.max(existing.peakNew, row.peakNew),
      peakOutput: Math.max(existing.peakOutput, row.peakOutput),
      sessions: existing.sessions + row.sessions,
      lastUsedAt: Math.max(existing.lastUsedAt, row.lastUsedAt),
    });
  }
  return [...merged.values()];
}
