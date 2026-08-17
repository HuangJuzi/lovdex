import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';

import type { TaskProjectOption } from './TaskCard';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { toggleProjectFilter } from './taskFilter';
import { computeDropdownPosition, type DropdownPosition } from './projectDropdown';

type ProjectMultiSelectProps = {
  projectOptions: TaskProjectOption[];
  value: string[];
  onChange: (next: string[]) => void;
};

function labelOf(value: string, projectOptions: TaskProjectOption[]): string {
  if (value === ASSISTANT_OPTION_VALUE) return '🤖 Lovdex助手';
  return projectOptions.find((o) => o.value === value)?.label ?? value;
}

/** 项目勾选列表 + 全选/清空。独立渲染，供触发器（固定定位 portal）复用。 */
export function ProjectMultiSelectPanel({
  projectOptions,
  value,
  onChange,
}: ProjectMultiSelectProps) {
  const allValues = [ASSISTANT_OPTION_VALUE, ...projectOptions.map((o) => o.value)];

  return (
    <div className="w-64 max-w-[80vw] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
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
  );
}

/**
 * 项目多选下拉：触发器显示摘要，展开为 portal 里的可勾选列表 + 全选/清空。
 * 面板用 fixed 定位渲染在 body 下——筛选栏的 `sm:overflow-x-auto` 会裁切
 * absolute 子元素（overflow-x 非 visible 时 overflow-y 会被计算成 auto），
 * portal 让它始终完整浮在内容上方。
 */
export function ProjectMultiSelect({ projectOptions, value, onChange }: ProjectMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DropdownPosition | null>(null);

  const updatePosition = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(computeDropdownPosition(rect, window.innerWidth, window.innerHeight));
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        wrapRef.current &&
        menuRef.current &&
        !wrapRef.current.contains(target) &&
        !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const summary =
    value.length === 0
      ? '全部项目'
      : value.length === 1
        ? labelOf(value[0], projectOptions)
        : `${value.length} 个项目`;

  return (
    <>
      <div ref={wrapRef} className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => {
            updatePosition();
            setOpen((o) => !o);
          }}
          className="flex items-center gap-1.5 rounded-xl border-2 border-border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none"
        >
          <span className="text-muted-foreground">项目</span>
          <span className="max-w-40 truncate">{summary}</span>
          <ChevronDown
            className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>
      </div>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100]"
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
        >
          <ProjectMultiSelectPanel projectOptions={projectOptions} value={value} onChange={onChange} />
        </div>,
        document.body,
      )}
    </>
  );
}
