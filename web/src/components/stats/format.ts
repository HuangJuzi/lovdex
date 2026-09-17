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

/**
 * 给模型分配稳定的颜色。同一个模型在同一会话内始终拿到同一个颜色，
 * 避免筛选后颜色跳变。
 */
const MODEL_COLORS = [
  '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444',
  '#14b8a6', '#ec4899', '#84cc16', '#6366f1', '#f97316',
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
    { key: 'input', label: '输入', color: '#0ea5e9' },
    { key: 'output', label: '输出', color: '#10b981' },
    { key: 'cacheRead', label: '缓存读取', color: '#f59e0b' },
    { key: 'cacheCreation', label: '缓存写入', color: '#8b5cf6' },
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
