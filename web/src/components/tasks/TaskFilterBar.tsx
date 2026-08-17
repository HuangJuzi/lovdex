import { useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Pill, PillBar } from '../../shared/view/ui';

import type { TaskProjectOption } from './TaskCard';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { ProjectMultiSelect } from './ProjectMultiSelect';
import {
  EMPTY_TASK_FILTER,
  type TaskDateField,
  type TaskFilter,
  type TaskFilterPreset,
} from './taskFilter';

const DATE_FIELD_OPTIONS: { value: TaskDateField; label: string }[] = [
  { value: 'created', label: '创建时间' },
  { value: 'deadline', label: '截止时间' },
  { value: 'activity', label: '最近活动' },
];

const PRESET_OPTIONS: { value: TaskFilterPreset; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '今年' },
  { value: 'all', label: '全部' },
];

type TaskFilterBarProps = {
  projectOptions: TaskProjectOption[];
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
};

/** 项目维度的摘要文案：全部 / 单个标签 / N 个项目。 */
function projectFilterLabel(filter: TaskFilter, projectOptions: TaskProjectOption[]): string {
  const paths = filter.projectPaths;
  if (paths.length === 0) return '全部';
  if (paths.length === 1) {
    const v = paths[0];
    return v === ASSISTANT_OPTION_VALUE
      ? '🤖 Lovdex助手'
      : projectOptions.find((o) => o.value === v)?.label ?? v;
  }
  return `${paths.length} 个`;
}

/** 移动端触发行上的一句话摘要，例如「项目：全部 · 日期：今天」。 */
function filterSummary(filter: TaskFilter, projectOptions: TaskProjectOption[]): string {
  const projectLabel = projectFilterLabel(filter, projectOptions);
  const dateRange =
    filter.customFrom || filter.customTo
      ? `${filter.customFrom || '…'} ~ ${filter.customTo || '…'}`
      : PRESET_OPTIONS.find((p) => p.value === filter.preset)?.label ?? '全部';
  return `项目：${projectLabel} · 日期：${dateRange}`;
}

/**
 * Task 页筛选栏：项目多选 + 日期字段切换 + 快捷项 + 自定义范围。
 * 移动端（<sm）默认折叠为「筛选」触发行，点开展开全部控件；
 * 桌面端（≥sm）始终展开，分组 justify-between 铺满一行。
 */
export function TaskFilterBar({ projectOptions, filter, onChange }: TaskFilterBarProps) {
  const [open, setOpen] = useState(false);

  const hasFilter =
    filter.projectPaths.length > 0 ||
    filter.preset !== 'all' ||
    filter.customFrom !== '' ||
    filter.customTo !== '';

  const pickPreset = (preset: TaskFilterPreset) => {
    onChange({ ...filter, preset, customFrom: '', customTo: '' });
  };

  const presetActive = (preset: TaskFilterPreset) =>
    filter.preset === preset && filter.customFrom === '' && filter.customTo === '';

  const summary = filterSummary(filter, projectOptions);

  return (
    <div className="border-b border-border/60 sm:border-0">
      {/* 移动端触发行 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground sm:hidden"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
        筛选
        <span className="truncate text-muted-foreground/80">{summary}</span>
        {hasFilter && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />}
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>

      {/* 控件区：移动端折叠展开；桌面端固定一排（放不下时横向滚动），能放下则 mx-auto 居中留白 */}
      <div className="sm:overflow-x-auto">
        <div
          className={cn(
            'gap-x-3 gap-y-2 sm:mx-auto sm:flex sm:w-max sm:flex-row sm:flex-nowrap sm:items-center sm:gap-x-6 sm:px-4 sm:py-2',
            open ? 'flex flex-col px-3 pb-2 pt-1' : 'hidden sm:flex',
          )}
        >
          {/* 左簇：项目多选 */}
          <div className="flex flex-wrap items-center gap-2">
            <ProjectMultiSelect
              projectOptions={projectOptions}
              value={filter.projectPaths}
              onChange={(projectPaths) => onChange({ ...filter, projectPaths })}
            />
          </div>

          {/* 中左簇：日期字段 */}
          <PillBar>
            {DATE_FIELD_OPTIONS.map((o) => (
              <Pill
                key={o.value}
                isActive={filter.dateField === o.value}
                onClick={() => onChange({ ...filter, dateField: o.value })}
              >
                {o.label}
              </Pill>
            ))}
          </PillBar>

          {/* 中右簇：快捷项 */}
          <PillBar>
            {PRESET_OPTIONS.map((o) => (
              <Pill
                key={o.value}
                isActive={presetActive(o.value)}
                onClick={() => pickPreset(o.value)}
              >
                {o.label}
              </Pill>
            ))}
          </PillBar>

          {/* 右簇：自定义范围 + 清除 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-xl border-2 border-border bg-card px-2.5 py-1.5">
              <span className="text-sm text-muted-foreground">从</span>
              <input
                type="date"
                className={`bg-transparent text-sm text-foreground outline-none ${
                  filter.customFrom === '' ? 'date-empty' : ''
                }`}
                value={filter.customFrom}
                onChange={(e) => onChange({ ...filter, preset: 'all', customFrom: e.target.value })}
              />
              <span className="text-sm text-muted-foreground">至</span>
              <input
                type="date"
                className={`bg-transparent text-sm text-foreground outline-none ${
                  filter.customTo === '' ? 'date-empty' : ''
                }`}
                value={filter.customTo}
                onChange={(e) => onChange({ ...filter, preset: 'all', customTo: e.target.value })}
              />
            </div>

            {hasFilter && (
              <button
                type="button"
                className="rounded-lg px-2 py-1.5 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => onChange(EMPTY_TASK_FILTER)}
              >
                清除筛选
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
