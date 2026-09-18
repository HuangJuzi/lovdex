import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  addComponents,
  buildChartRows,
  colorForModel,
  componentShares,
  EMPTY_COMPONENTS,
  formatBucketLabel,
  formatFullTime,
  formatTpm,
  metricValue,
  type TokenComponents,
  type TokenDimension,
  type TokenMetric,
} from '../format';
import type { IngestStatus, TimeseriesResponse } from '../useTokenStats';

const MINUTE_MS = 60_000;

type ChartRow = { ts: number } & Record<string, number>;

/** 悬浮提示：按 TPM 降序列出各维度键 + 合计。 */
function ChartTooltip({
  active,
  payload,
  label,
  keys,
  bucketMs,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number }[];
  label?: number;
  keys: string[];
  bucketMs: number;
}) {
  if (!active || !payload || payload.length === 0 || typeof label !== 'number') {
    return null;
  }
  const rows = payload
    .filter((item) => keys.includes(String(item.dataKey)))
    .map((item) => ({ key: String(item.dataKey), tpm: item.value ?? 0 }))
    .sort((a, b) => b.tpm - a.tpm);
  const total = rows.reduce((sum, row) => sum + row.tpm, 0);

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 text-muted-foreground">
        {formatFullTime(label)} · {formatBucketLabel(label, bucketMs)}
      </div>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: colorForModel(row.key, keys) }}
            />
            {row.key}
          </span>
          <span className="font-mono">{formatTpm(row.tpm)} TPM</span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border pt-1.5 font-medium">
        <span>合计</span>
        <span className="font-mono">{formatTpm(total)} TPM</span>
      </div>
    </div>
  );
}

/**
 * 构成条：四类 token 分量在整个区间里的占比。
 *
 * 这条是「cache_read 占大头」这件事的落点——真实数据里 cacheRead 占 74%、
 * output 仅 0.3%，没有它，堆叠面积图会让人以为「干了 74% 的活」。
 * 占比与所选口径/维度无关（构成永远是四类分量之间的关系）。
 */
function CompositionBar({ components }: { components: TokenComponents }) {
  const shares = componentShares(components);
  const total = shares.reduce((sum, row) => sum + row.share, 0);
  if (total <= 0) {
    return null;
  }

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-2 text-xs text-muted-foreground">Token 构成（区间内合计）</div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {shares.map((row) => (
          <span
            key={row.key}
            className="h-full"
            style={{ width: `${row.share * 100}%`, backgroundColor: row.color }}
            title={`${row.label} ${(row.share * 100).toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {shares.map((row) => (
          <span key={row.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: row.color }} />
            {row.label}
            <span className="font-mono text-foreground">{(row.share * 100).toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * TPM 时间序列卡片：按维度键（模型或厂商）堆叠的面积图。
 *
 * y 轴是「每分钟 token 数」。后端返回的是**桶内原始计数**，这里按
 * `bucketMs / 60000` 归一化，因此切换时间范围时曲线量级可比。
 *
 * 口径（`metric`）与维度（`dimension`）都由 `StatsPage` 持有——切换它们
 * 不触发重新请求，同一份响应能本地算出任意口径/维度。
 */
export function TpmChartCard({
  timeseries,
  ingest,
  metric,
  dimension,
}: {
  timeseries: TimeseriesResponse | null;
  ingest: IngestStatus | null;
  metric: TokenMetric;
  dimension: TokenDimension;
}) {
  // `timeseries?.buckets ?? []` 每次渲染都是新数组，必须 memo 后再进 useMemo 依赖
  const buckets = useMemo(() => timeseries?.buckets ?? [], [timeseries]);
  const bucketMs = timeseries?.bucketMs ?? MINUTE_MS;

  const { rows, keys } = useMemo(
    () => buildChartRows(buckets, metric, dimension),
    [buckets, metric, dimension],
  );

  // 后端给的是桶内计数，TPM 需要前端归一化（附录 A.4 的注释）。
  const perMinute = bucketMs > 0 ? bucketMs / MINUTE_MS : 1;
  const tpmRows = useMemo<ChartRow[]>(
    () =>
      rows.map((row) => {
        const next: ChartRow = { ts: row.ts };
        for (const key of keys) {
          next[key] = (row[key] ?? 0) / perMinute;
        }
        return next;
      }),
    [rows, keys, perMinute],
  );

  // 构成条的口径是「四类分量」，与维度无关，所以直接对原始 byModel 求和。
  const totalComponents = useMemo(
    () =>
      buckets.reduce(
        (sum, bucket) =>
          Object.values(bucket.byModel).reduce(
            (bucketSum, components) => addComponents(bucketSum, components),
            sum,
          ),
        EMPTY_COMPONENTS,
      ),
    [buckets],
  );

  // 空态判据是「区间内有没有任何用量」，不是「当前口径下有没有值」——
  // 选「仅输出」而区间里恰好没有输出时，图表该画成贴地的 0（构成条也仍有意义），
  // 而不是整卡片变成空态把 cache 占比这件事藏掉。
  const hasData = metricValue(totalComponents, 'all') > 0;
  const backfilling = Boolean(ingest?.scanning);
  // 扫描刚启动、目录还没遍历完时 filesTotal 为 0，此时显示「0/0 个文件」看起来像坏了，
  // 所以没有计数就只说「正在回填」，等有计数了再带上 x/y。
  const hasFileCount = Boolean(ingest && ingest.filesTotal > 0);

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">
          TPM 变化（{dimension === 'vendor' ? '按厂商' : '按模型'}）
        </h2>
        {backfilling && ingest && (
          <span className="text-xs text-muted-foreground">
            {hasFileCount
              ? `正在回填历史 ${ingest.filesDone}/${ingest.filesTotal} 个文件…`
              : '正在回填历史…'}
          </span>
        )}
      </header>

      {!hasData ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>暂无用量数据</span>
          {backfilling && ingest && (
            <span className="text-xs">
              {hasFileCount
                ? `首次回填进行中（${ingest.filesDone}/${ingest.filesTotal} 个文件，已入库 ${ingest.eventsIndexed} 条）`
                : '首次回填进行中…'}
            </span>
          )}
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={tpmRows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                className="text-border"
                vertical={false}
              />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(value: number) => formatBucketLabel(value, bucketMs)}
                tick={{ fontSize: 11 }}
                stroke="currentColor"
                className="text-muted-foreground"
                minTickGap={40}
              />
              <YAxis
                tickFormatter={(value: number) => formatTpm(value)}
                tick={{ fontSize: 11 }}
                stroke="currentColor"
                className="text-muted-foreground"
                width={48}
              />
              <Tooltip content={<ChartTooltip keys={keys} bucketMs={bucketMs} />} />
              {keys.map((key) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stackId="tpm"
                  stroke={colorForModel(key, keys)}
                  fill={colorForModel(key, keys)}
                  fillOpacity={0.35}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {keys.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {keys.map((key) => (
            <span key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorForModel(key, keys) }} />
              {key}
            </span>
          ))}
        </div>
      )}

      <CompositionBar components={totalComponents} />
    </section>
  );
}
