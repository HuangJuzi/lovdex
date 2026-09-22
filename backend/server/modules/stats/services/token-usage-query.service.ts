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

/**
 * 查询跨度的上界（366 天）。`from`/`to` 来自 query string，若不设上界，
 * `?from=0&to=1e18` 会让补零循环迭代约 1.16e10 次并撑爆堆。
 * 前端最大预设是 30 天，正常使用碰不到；超界夹取而非报错。
 */
export const MAX_RANGE_MS = 366 * 24 * 60 * MINUTE_MS;

/**
 * 单次时间序列的桶数上界。纵深防御：service 路径已被 `resolveRange` 夹住，
 * 但 `buildTimeseries` 是模块导出，直接调用时同样不该能挂死进程。
 */
export const MAX_BUCKETS = 20_000;

/**
 * 桶内的四类 token 分量。口径（全部 / 仅新增 / 仅输出）由前端本地换算，
 * 后端只保证分量齐全——实测 cache_read 占 74.2%、output 仅 0.3%，
 * 任何单一口径的数字都会把这件事藏起来。
 */
export type TokenComponents = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type TimeseriesBucket = {
  ts: number;
  byModel: Record<string, TokenComponents>;
};

export type SummaryModelEntry = {
  model: string;
  tokens: TokenComponents;
  /** 1 分钟粒度峰值，四档口径各一个（前端按当前口径选）。 */
  peakAll: number;
  peakNew: number;
  peakInput: number;
  peakOutput: number;
  sessions: number;
  lastUsedAt: number;
};

export type TimeseriesResult = {
  range: { from: number; to: number };
  bucketMs: number;
  models: string[];
  buckets: TimeseriesBucket[];
};

/** 不含 totalTokens / share / tpmAvg：它们都随口径变化，由前端按分量算。 */
export type SummaryResult = {
  range: { from: number; to: number };
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
    // 夹取上界：超大跨度会让补零循环的迭代次数与内存占用无界增长。
    return { from: Math.max(from, to - MAX_RANGE_MS), to };
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
 * 补零是补**四类分量**的零值，且每个已知模型在每个桶里都要有 key，
 * 否则堆叠图会错位。
 */
export function buildTimeseries(
  rows: BucketAggregateRow[],
  options: { from: number; to: number; bucketMs: number },
): TimeseriesBucket[] {
  const { from, to, bucketMs } = options;

  // 非法桶大小必须早退：负桶会让 `ts += bucketMs` 朝 to 的反方向走，
  // 循环永不终止且无限分配（实测直接把进程撑到 OOM）。返回空数组而非抛错，
  // 与这个纯函数的宽容风格一致。
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    return [];
  }

  // 桶数上界：与上面的非法桶守卫同风格，返回空数组而非抛错。
  // 用与循环完全相同的对齐起点估算，保证守卫和实际迭代次数一致。
  const firstTs = Math.floor(from / bucketMs) * bucketMs;
  const projectedBuckets = Math.ceil((to - firstTs) / bucketMs);
  if (!Number.isFinite(projectedBuckets) || projectedBuckets > MAX_BUCKETS) {
    return [];
  }

  const componentsByBucket = new Map<number, Map<string, TokenComponents>>();
  const modelTotals = new Map<string, number>();

  for (const row of rows) {
    let bucket = componentsByBucket.get(row.bucket_ts);
    if (!bucket) {
      bucket = new Map<string, TokenComponents>();
      componentsByBucket.set(row.bucket_ts, bucket);
    }
    const current = bucket.get(row.model) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    current.input += row.input_tokens;
    current.output += row.output_tokens;
    current.cacheRead += row.cache_read_tokens;
    current.cacheCreation += row.cache_creation_tokens;
    bucket.set(row.model, current);

    // 排序只看「全部 token」这一个口径，与前端选哪个口径无关，切换时顺序不跳
    modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + allTokens(row));
  }

  // 模型按用量降序，图表堆叠顺序稳定且把大头放底部
  const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  const buckets: TimeseriesBucket[] = [];

  for (let ts = firstTs; ts < to; ts += bucketMs) {
    const bucket = componentsByBucket.get(ts);
    const byModel: Record<string, TokenComponents> = {};
    for (const model of models) {
      byModel[model] = bucket?.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    }
    buckets.push({ ts, byModel });
  }

  return buckets;
}

/** 四类分量之和，即「全部 token」口径。 */
function allTokens(row: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): number {
  return row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens;
}

/** 组装区间汇总；三档峰值来自独立的 1 分钟粒度查询。 */
export function buildSummary(
  rows: ModelAggregateRow[],
  peaks: ModelPeakRow[],
  range: { from: number; to: number },
): SummaryResult {
  const peakByModel = new Map(peaks.map((p) => [p.model, p]));

  return {
    range,
    byModel: rows.map((row) => {
      const peak = peakByModel.get(row.model);
      return {
        model: row.model,
        tokens: {
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cacheCreation: row.cache_creation_tokens,
        },
        peakAll: peak?.peak_all ?? 0,
        peakNew: peak?.peak_new ?? 0,
        peakInput: peak?.peak_input ?? 0,
        peakOutput: peak?.peak_output ?? 0,
        sessions: row.sessions,
        lastUsedAt: row.last_used_at,
      };
    }),
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
    return tokenUsageDb.listModels(filter).map((row) => ({
      model: row.model,
      tokens: {
        input: row.input_tokens,
        output: row.output_tokens,
        cacheRead: row.cache_read_tokens,
        cacheCreation: row.cache_creation_tokens,
      },
      lastUsedAt: row.last_used_at,
    }));
  }

  return { getTimeseries, getSummary, listModels, getIngestStatus: deps.getIngestStatus, triggerRefresh: deps.triggerRefresh };
}

export type TokenUsageQueryService = ReturnType<typeof createTokenUsageQueryService>;
