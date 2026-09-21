import { cn } from '../../../lib/utils';

type SwitchProps = {
  checked: boolean;
  onToggle: () => void;
  ariaLabel: string;
};

/**
 * 受控开关：状态与操作二合一（当前用于定时任务启用/停用）。
 * 视觉参考 DarkModeToggle，尺寸缩小以适配表格行高；开=bg-success，关=bg-muted。
 * mobile-touch-target + -my-2：保证 44px 触控面积的同时不撑高所在行/卡片。
 */
function Switch({ checked, onToggle, ariaLabel }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
      className="mobile-touch-target -my-2 inline-flex flex-shrink-0 items-center rounded-full p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span
        className={cn(
          'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200',
          checked ? 'bg-success' : 'border border-border bg-muted',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-card shadow-sm transition-transform duration-200',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}

export default Switch;
