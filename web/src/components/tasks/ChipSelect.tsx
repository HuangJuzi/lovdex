import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';

import { AnchorPopover } from './AnchorPopover';

export type ChipSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  hint?: string; // 行内右侧辅助文字（如远端主机名）
};

/**
 * 胶囊芯片 + 弹层单选。label 显示当前选中项；disabled 时整个芯片灰置。
 */
export function ChipSelect({
  label,
  options,
  value,
  onChange,
  disabled,
  isMobile,
  ariaLabel,
}: {
  label: string;
  options: ChipSelectOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  isMobile: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 items-center gap-1 rounded-full border border-border/80 bg-card px-3 text-sm text-foreground transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <span className="max-w-[190px] truncate">{current?.label ?? label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      <AnchorPopover open={open} onOpenChange={setOpen} anchorRef={anchorRef} isMobile={isMobile} ariaLabel={ariaLabel ?? label}>
        <div className="flex flex-col">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={o.disabled}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                'flex items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                'hover:bg-accent focus-visible:outline-none',
                o.disabled ? 'cursor-not-allowed opacity-50' : '',
                o.value === value ? 'bg-accent font-medium' : '',
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
            </button>
          ))}
        </div>
      </AnchorPopover>
    </>
  );
}
