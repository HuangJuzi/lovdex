import { useMemo } from 'react';

import {
  formatTokenCount,
  formatTpm,
  mergeSummaryByVendor,
  metricValue,
  type SummaryRow,
  type TokenDimension,
  type TokenMetric,
} from '../format';
import type { SummaryResponse } from '../useTokenStats';

const MINUTE_MS = 60_000;

function formatLastUsed(ts: number): string {
  if (!ts) {
    return '—';
  }
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 峰值按口径取对应字段：峰值是「某 1 分钟的瞬时量」，三口径各存一个。 */
function peakFor(row: SummaryRow, metric: TokenMetric): number {
  switch (metric) {
    case 'all':
      return row.peakAll;
    case 'new':
      return row.peakNew;
    case 'output':
      return row.peakOutput;
  }
}

/**
 * 模型/厂商排行卡片：区间内各维度的用量、TPM 均值/峰值与占比。
 *
 * 排行按**当前口径**的总量降序——固定用 all-token 排序会在切到「仅输出」时
 * 出现「排第一的行数字反而更小」的错乱。
 */
export function ModelRankCard({
  summary,
  metric,
  dimension,
}: {
  summary: SummaryResponse | null;
  metric: TokenMetric;
  dimension: TokenDimension;
}) {
  const rangeMs = summary ? summary.range.to - summary.range.from : 0;

  const rows = useMemo(() => {
    const source: SummaryRow[] = summary?.byModel ?? [];
    const merged = dimension === 'vendor' ? mergeSummaryByVendor(source) : source;
    return merged
      .map((row) => ({ row, total: metricValue(row.tokens, metric) }))
      .sort((a, b) => b.total - a.total);
  }, [summary, metric, dimension]);

  const grandTotal = rows.reduce((sum, entry) => sum + entry.total, 0);
  // 区间分钟数：至少 1，避免空区间除零。
  const rangeMinutes = Math.max(1, rangeMs / MINUTE_MS);
  const dimensionLabel = dimension === 'vendor' ? '厂商' : '模型';

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{dimensionLabel}用量排行</h2>
        <span className="text-xs text-muted-foreground">
          合计 {formatTokenCount(grandTotal)} tokens
        </span>
      </header>

      {rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          暂无用量数据
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-normal">{dimensionLabel}</th>
                <th className="py-2 pr-3 text-right font-normal">总量</th>
                <th className="py-2 pr-3 text-right font-normal">占比</th>
                <th className="py-2 pr-3 text-right font-normal">平均 TPM</th>
                <th className="py-2 pr-3 text-right font-normal">峰值 TPM</th>
                <th className="py-2 pr-3 text-right font-normal">会话数</th>
                <th className="py-2 text-right font-normal">最近使用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, total }) => (
                <tr key={row.model} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3">{row.model}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatTokenCount(total)}</td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {grandTotal > 0 ? `${((total / grandTotal) * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">{formatTpm(total / rangeMinutes)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatTpm(peakFor(row, metric))}</td>
                  <td className="py-2 pr-3 text-right font-mono">{row.sessions}</td>
                  <td className="py-2 text-right font-mono text-muted-foreground">
                    {formatLastUsed(row.lastUsedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
