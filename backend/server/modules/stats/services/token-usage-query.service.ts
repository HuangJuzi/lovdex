import {
  tokenUsageDb,
  type BucketAggregateRow,
  type ModelAggregateRow,
  type ModelPeakRow,
} from '@/modules/database/repositories/token-usage.db.js';

const MINUTE_MS = 60_000;
const DEFAULT_RANGE_MS = 24 * 60 * MINUTE_MS;

/** 桶大小阶梯：范围越大桶越粗，避免 7 天视图画出上万个点。 */
const BUCKET_STEPS: { maxRangeMs: number; bucketMs: number }[] = [
  { maxRangeMs: 6 * 60 * MINUTE_MS, bucketMs: MINUTE_MS },
  { maxRangeMs: 24 * 60 * MINUTE_MS, bucketMs: 5 * MINUTE_MS },
  { maxRangeMs: 7 * 24 * 60 * MINUTE_MS, bucketMs: 60 * MINUTE_MS },
];
const FALLBACK_BUCKET_MS = 24 * 60 * MINUTE_MS;

export type TimeseriesBucket = {
  ts: number;
  total: number;
  /** 归一化成「每分钟 token 数」，因此不同桶大小下 y 轴量级可比。 */
  tpm: number;
  byModel: Record<string, number>;
};

export type SummaryModelEntry = {
  model: string;
  tokens: number;
  share: number;
  tpmAvg: number;
  tpmPeak: number;
  sessions: number;
  lastUsedAt: number;
};

export type TimeseriesResult = {
  range: { from: number; to: number };
  bucketMs: number;
  models: string[];
  buckets: TimeseriesBucket[];
};

export type SummaryResult = {
  range: { from: number; to: number };
  totalTokens: number;
  byModel: SummaryModelEntry[];
};

export type TokenUsageQueryFilter = {
  from: number;
  to: number;
  projectPath?: string;
  models?: string[];
};

/** 按范围选桶大小。 */
export function pickBucketMs(rangeMs: number): number {
  for (const step of BUCKET_STEPS) {
    if (rangeMs <= step.maxRangeMs) {
      return step.bucketMs;
    }
  }
  return FALLBACK_BUCKET_MS;
}

/** 桶大小必须是 60000 的正整数倍，否则 `(ts/桶)*桶` 的对齐会失真。 */
export function isAllowedBucketMs(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value % MINUTE_MS === 0;
}

/**
 * 归一化 from/to。缺省为最近 24 小时；`from >= to` 属矛盾输入，同样回退默认窗口——
 * 否则会返回空数组，前端会误判成「没有数据」。
 */
export function resolveRange(
  from: number | undefined,
  to: number | undefined,
  now: number,
): { from: number; to: number } {
  const hasValidTo = typeof to === 'number' && Number.isFinite(to) && to > 0;
  const hasValidFrom = typeof from === 'number' && Number.isFinite(from) && from >= 0;

  if (hasValidFrom && hasValidTo && from < to) {
    return { from, to };
  }
  if (hasValidFrom && !hasValidTo) {
    return { from, to: now };
  }
  return { from: now - DEFAULT_RANGE_MS, to: now };
}

/**
 * 把聚合行摊成连续的时间桶。
 *
 * 空桶必须补 0：否则折线图会跨空洞直连，视觉上等于伪造了中间时段的用量。
 */
export function buildTimeseries(
  rows: BucketAggregateRow[],
  options: { from: number; to: number; bucketMs: number },
): TimeseriesBucket[] {
  const { from, to, bucketMs } = options;
  const totalsByBucket = new Map<number, Map<string, number>>();
  const modelTotals = new Map<string, number>();

  for (const row of rows) {
    let bucket = totalsByBucket.get(row.bucket_ts);
    if (!bucket) {
      bucket = new Map<string, number>();
      totalsByBucket.set(row.bucket_ts, bucket);
    }
    bucket.set(row.model, (bucket.get(row.model) ?? 0) + row.tokens);
    modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + row.tokens);
  }

  // 模型按用量降序，图表堆叠顺序稳定且把大头放底部
  const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  const minutesPerBucket = bucketMs / MINUTE_MS;
  const buckets: TimeseriesBucket[] = [];

  for (let ts = Math.floor(from / bucketMs) * bucketMs; ts < to; ts += bucketMs) {
    const bucket = totalsByBucket.get(ts);
    const byModel: Record<string, number> = {};
    let total = 0;
    for (const model of models) {
      const tokens = bucket?.get(model) ?? 0;
      byModel[model] = tokens;
      total += tokens;
    }
    buckets.push({ ts, total, tpm: total / minutesPerBucket, byModel });
  }

  return buckets;
}

/** 组装区间汇总；`tpmPeak` 来自独立的 1 分钟粒度查询。 */
export function buildSummary(
  rows: ModelAggregateRow[],
  peaks: ModelPeakRow[],
  range: { from: number; to: number },
): SummaryResult {
  const peakByModel = new Map(peaks.map((p) => [p.model, p.peak]));
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const rangeMinutes = Math.max(1, (range.to - range.from) / MINUTE_MS);

  return {
    range,
    totalTokens,
    byModel: rows.map((row) => ({
      model: row.model,
      tokens: row.tokens,
      share: totalTokens > 0 ? row.tokens / totalTokens : 0,
      tpmAvg: row.tokens / rangeMinutes,
      tpmPeak: peakByModel.get(row.model) ?? 0,
      sessions: row.sessions,
      lastUsedAt: row.last_used_at,
    })),
  };
}

export function createTokenUsageQueryService(deps: {
  getIngestStatus: () => unknown;
  triggerRefresh: () => void;
}) {
  function getTimeseries(
    filter: TokenUsageQueryFilter,
    bucketMsInput?: number,
  ): TimeseriesResult & { ingest: unknown } {
    const bucketMs = isAllowedBucketMs(bucketMsInput ?? Number.NaN)
      ? (bucketMsInput as number)
      : pickBucketMs(filter.to - filter.from);
    const rows = tokenUsageDb.aggregateBuckets({ ...filter, bucketMs });
    const buckets = buildTimeseries(rows, { ...filter, bucketMs });
    return {
      range: { from: filter.from, to: filter.to },
      bucketMs,
      models: buckets.length > 0 ? Object.keys(buckets[0].byModel) : [],
      buckets,
      ingest: deps.getIngestStatus(),
    };
  }

  function getSummary(filter: TokenUsageQueryFilter): SummaryResult {
    const rows = tokenUsageDb.aggregateByModel(filter);
    const peaks = tokenUsageDb.aggregateMinutePeaks(filter);
    return buildSummary(rows, peaks, { from: filter.from, to: filter.to });
  }

  function listModels(filter: { from: number; to: number; projectPath?: string }) {
    return tokenUsageDb
      .listModels(filter)
      .map((row) => ({ model: row.model, tokens: row.tokens, lastUsedAt: row.last_used_at }));
  }

  return { getTimeseries, getSummary, listModels, getIngestStatus: deps.getIngestStatus, triggerRefresh: deps.triggerRefresh };
}

export type TokenUsageQueryService = ReturnType<typeof createTokenUsageQueryService>;
