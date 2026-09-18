import { useEffect, useMemo, useState } from 'react';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { HomeButton } from '../tasks/TaskBackNav';
import { projectPathOf, taskFormProjects } from '../tasks/projectOptions';

import { DIMENSIONS, METRICS, TIME_RANGES, type TokenDimension, type TokenMetric } from './format';
import { ModelRankCard } from './widgets/ModelRankCard';
import { TpmChartCard } from './widgets/TpmChartCard';
import { useTokenStats } from './useTokenStats';

const ALL_PROJECTS = '__all__';

const SEGMENT_ACTIVE =
  'rounded-lg bg-card px-2 py-1 text-xs font-normal text-card-foreground shadow-sm';
const SEGMENT_IDLE =
  'rounded-lg px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground';

/**
 * Token 用量统计页。
 *
 * 用卡片网格承载各个统计卡片；后续追加新卡片时只需新建
 * `widgets/XxxCard.tsx` 并在下面的网格里插一行，页面骨架不用改。
 *
 * 口径（`metric`）与维度（`dimension`）是**纯前端状态**：后端返回的是四类
 * token 分量，任何口径/维度都能从同一份响应本地算出，所以两者都不进
 * `useTokenStats` 的依赖——切换它们不触发重新请求。
 */
export function StatsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectPath, setProjectPath] = useState<string>(ALL_PROJECTS);
  const [rangeIndex, setRangeIndex] = useState(2); // 默认 24 小时
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [metric, setMetric] = useState<TokenMetric>('all');
  const [dimension, setDimension] = useState<TokenDimension>('model');

  // 项目列表只在挂载时拉一次（与 TaskBoard.tsx:162-180 同一做法）。
  // 没有全局 project store，`api.projects()` 是函数不是对象。
  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then(async (res) => {
        if (!res.ok) throw new Error(`projects failed: ${res.status}`);
        const data = (await res.json()) as Project[];
        if (!cancelled) setProjects(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projectOptions = useMemo(
    () =>
      taskFormProjects(projects).map((project) => ({
        value: projectPathOf(project),
        label: project.displayName || projectPathOf(project),
      })),
    [projects],
  );

  const rangeMs = TIME_RANGES[rangeIndex].ms;
  // useTokenStats 的 refresh 依赖 selectedModels，必须保持稳定引用
  const stableModels = useMemo(() => selectedModels, [selectedModels]);

  const { timeseries, summary, loading, error } = useTokenStats({
    projectPath: projectPath === ALL_PROJECTS ? undefined : projectPath,
    rangeMs,
    selectedModels: stableModels,
  });

  const allModels = timeseries?.models ?? [];

  return (
    // 外壳与 TaskBoard / SettingsPage 对齐：整页不滚，只有内容区滚。
    // `/stats` 是 `AppContent` 的兄弟路由，不渲染侧边栏，所以返回入口必须在这里。
    <div className="flex h-dvh flex-col bg-background">
      <header className="pwa-header-safe flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <HomeButton />
        <h1 className="ml-2 text-sm font-semibold text-foreground">Token 统计</h1>

        <select
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
          className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
        >
          <option value={ALL_PROJECTS}>全部项目</option>
          {projectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
          {TIME_RANGES.map((range, index) => (
            <button
              key={range.label}
              type="button"
              aria-pressed={index === rangeIndex}
              onClick={() => setRangeIndex(index)}
              className={index === rangeIndex ? SEGMENT_ACTIVE : SEGMENT_IDLE}
            >
              {range.label}
            </button>
          ))}
        </div>

        {/* 口径：决定「什么算一个 token」 */}
        <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
          {METRICS.map((m) => (
            <button
              key={m.value}
              type="button"
              title={m.hint}
              aria-pressed={metric === m.value}
              onClick={() => setMetric(m.value)}
              className={metric === m.value ? SEGMENT_ACTIVE : SEGMENT_IDLE}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* 维度：模型原始 id 还是厂商归并 */}
        <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
          {DIMENSIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              aria-pressed={dimension === d.value}
              onClick={() => setDimension(d.value)}
              className={dimension === d.value ? SEGMENT_ACTIVE : SEGMENT_IDLE}
            >
              {d.label}
            </button>
          ))}
        </div>

        {/* 模型筛选按原始 model id 传参，与厂商维度语义冲突，故在厂商维度下隐藏 */}
        {dimension === 'model' && allModels.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {allModels.map((model) => {
              const active = selectedModels.includes(model);
              return (
                <button
                  key={model}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setSelectedModels((current) =>
                      current.includes(model) ? current.filter((m) => m !== model) : [...current, model],
                    )
                  }
                  className={
                    active
                      ? 'rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-xs text-primary'
                      : 'rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground'
                  }
                >
                  {model}
                </button>
              );
            })}
          </div>
        )}

        {error && <span className="text-xs text-destructive">加载失败，稍后重试</span>}
        {loading && !timeseries && <span className="text-xs text-muted-foreground">加载中…</span>}
      </header>

      {/* 内容区独立滚动：外层 h-dvh 不滚，长表格/多卡片时整页不跟着滚 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* 卡片网格：后续统计卡片直接往这里加 */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="xl:col-span-2">
            <TpmChartCard
              timeseries={timeseries}
              ingest={timeseries?.ingest ?? null}
              metric={metric}
              dimension={dimension}
            />
          </div>
          <ModelRankCard summary={summary} metric={metric} dimension={dimension} />
        </div>
      </div>
    </div>
  );
}
