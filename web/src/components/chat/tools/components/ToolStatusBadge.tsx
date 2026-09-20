import { cn } from '../../../../lib/utils';

export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

const STATUS_CONFIG: Record<ToolStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-primary/10 text-primary',
  },
  completed: {
    label: 'Completed',
    className: 'bg-success/10 text-success',
  },
  error: {
    label: 'Error',
    className: 'bg-destructive/10 text-destructive',
  },
  denied: {
    label: 'Denied',
    className: 'bg-warning/10 text-warning',
  },
};

interface ToolStatusBadgeProps {
  status: ToolStatus;
  className?: string;
}

export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-px text-3xs font-medium',
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  );
}
