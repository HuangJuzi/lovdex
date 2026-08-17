import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';

import type { TaskProjectOption } from './TaskCard';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { toggleProjectFilter } from './taskFilter';

type ProjectMultiSelectProps = {
  projectOptions: TaskProjectOption[];
  value: string[];
  onChange: (next: string[]) => void;
};

function labelOf(value: string, projectOptions: TaskProjectOption[]): string {
  if (value === ASSISTANT_OPTION_VALUE) return '🤖 Lovdex助手';
  return projectOptions.find((o) => o.value === value)?.label ?? value;
}

/** 项目多选下拉：触发器显示摘要，展开为可勾选列表 + 全选/清空。 */
export function ProjectMultiSelect({ projectOptions, value, onChange }: ProjectMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const allValues = [ASSISTANT_OPTION_VALUE, ...projectOptions.map((o) => o.value)];

  const summary =
    value.length === 0
      ? '全部项目'
      : value.length === 1
        ? labelOf(value[0], projectOptions)
        : `${value.length} 个项目`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-xl border-2 border-border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none"
      >
        <span className="text-muted-foreground">项目</span>
        <span className="max-w-40 truncate">{summary}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      <div
        className={cn(
          'absolute left-0 top-full z-20 mt-1 w-64 max-w-[80vw] rounded-xl border border-border bg-popover p-1.5 shadow-lg',
          open ? '' : 'hidden',
        )}
      >
        <div className="max-h-64 overflow-y-auto">
          {allValues.map((v) => {
            const checked = value.includes(v);
            return (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/60"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(toggleProjectFilter(value, v))}
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
                <span className="flex-1 truncate">{labelOf(v, projectOptions)}</span>
                {checked && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </label>
            );
          })}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-border/60 px-1 pt-1.5 text-xs">
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange(allValues)}>
            全选
          </button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange([])}>
            清空
          </button>
        </div>
      </div>
    </div>
  );
}
