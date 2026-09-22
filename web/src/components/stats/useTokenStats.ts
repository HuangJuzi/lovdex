import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';

import { pickBucketMs } from './format';

export type TokenComponents = { input: number; output: number; cacheRead: number; cacheCreation: number };

export type TimeseriesBucket = { ts: number; byModel: Record<string, TokenComponents> };

export type IngestStatus = {
  scanning: boolean;
  filesTotal: number;
  filesDone: number;
  eventsIndexed: number;
  startedAt: string | null;
  lastScanAt: string | null;
};

export type TimeseriesResponse = {
  range: { from: number; to: number };
  bucketMs: number;
  models: string[];
  buckets: TimeseriesBucket[];
  ingest: IngestStatus;
};

export type SummaryModelEntry = {
  model: string;
  tokens: TokenComponents;
  peakAll: number;
  peakNew: number;
  peakInput: number;
  peakOutput: number;
  sessions: number;
  lastUsedAt: number;
};

export type SummaryResponse = { range: { from: number; to: number }; byModel: SummaryModelEntry[] };

const REFRESH_INTERVAL_MS = 30_000;

/**
 * `/stats` 页的数据层：拉取时间序列与汇总，30s 轮询。
 *
 * 页面隐藏时暂停轮询（后台标签页不该空转）；重新可见时立刻补拉一次。
 *
 * 口径（`TokenMetric`）与维度（`TokenDimension`）**不是**这个 hook 的参数：
 * 响应里已经带了四类分量，任何口径/维度都能在渲染时本地算出，切换不该触发重新请求。
 */
export function useTokenStats(options: {
  projectPath?: string;
  rangeMs: number;
  selectedModels: string[];
}) {
  const { projectPath, rangeMs, selectedModels } = options;
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const to = Date.now();
    const from = to - rangeMs;
    const models = selectedModels.length > 0 ? selectedModels : undefined;
    try {
      const [tsRes, sumRes] = await Promise.all([
        api.stats.tokenUsageTimeseries({ projectPath, from, to, bucketMs: pickBucketMs(rangeMs), models }),
        api.stats.tokenUsageSummary({ projectPath, from, to, models }),
      ]);
      if (!tsRes.ok || !sumRes.ok) {
        throw new Error(`token usage request failed: ${tsRes.status}/${sumRes.status}`);
      }
      const [tsData, sumData] = (await Promise.all([tsRes.json(), sumRes.json()])) as [
        TimeseriesResponse,
        SummaryResponse,
      ];
      if (mounted.current) {
        setTimeseries(tsData);
        setSummary(sumData);
        setError(false);
      }
    } catch {
      if (mounted.current) {
        setError(true);
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [projectPath, rangeMs, selectedModels]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, REFRESH_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { timeseries, summary, loading, error, refresh };
}
