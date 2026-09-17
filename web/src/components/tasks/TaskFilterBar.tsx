import { Pill, PillBar } from '../../shared/view/ui';

import type { TaskProjectOption } from './TaskCard';
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
  /** 展开 / 收起由 TaskBoard 的 header「筛选」按钮统一控制；收起时整个组件不渲染。 */
  open: boolean;
};

/**
 * Task 页筛选栏：项目多选 + 日期字段切换 + 快捷项 + 自定义范围。
 * 受控组件：`open` 由 TaskBoard 的 header 按钮驱动，收起时返回 null。
 * 移动端（<sm）控件竖排，桌面端（≥sm）一排居中；本组件不含折叠入口，两端都由
 * TaskBoard 的 header 按钮控制（原先那条仅供 <sm 使用的触发行已删除）。
 */
export function TaskFilterBar({ projectOptions, filter, onChange, open }: TaskFilterBarProps) {
  if (!open) return null;

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

  return (
    <div className="border-b border-border/60 sm:border-0">
      <div className="sm:overflow-x-auto">
        <div className="flex flex-col gap-x-3 gap-y-2 px-3 pb-2 pt-1 sm:mx-auto sm:flex sm:w-max sm:flex-row sm:flex-nowrap sm:items-center sm:gap-x-6 sm:px-4 sm:py-2">
          {/* 左簇：项目多选 */}
          <div className="flex flex-wrap items-center gap-2">
            <ProjectMultiSelect
              projectOptions={projectOptions}
              value={filter.projectPaths}
              onChange={(projectPaths) => onChange({ ...filter, projectPaths })}
            />
          </div>

          {/* 左二簇：显示归档开关（只控制是否展示 archived 任务，不点亮清除红点） */}
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              isActive={filter.showArchived}
              onClick={() => onChange({ ...filter, showArchived: !filter.showArchived })}
            >
              显示归档
            </Pill>
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
