import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';
import { formatRelativeTime } from '../tasks/taskTimestamp';

type InboxListProps = {
  items: InboxNotification[];
  selectedId: string | null;
  now: Date;
  onSelect: (id: string) => void;
};

const SEVERITY_ICON: Record<InboxSeverity, ReactNode> = {
  critical: <AlertCircle className="h-3.5 w-3.5" />,
  warning: <AlertTriangle className="h-3.5 w-3.5" />,
  info: <Info className="h-3.5 w-3.5" />,
};

const SEVERITY_ICON_CLASS: Record<InboxSeverity, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-muted text-muted-foreground',
};

/** 左栏通知列表。纯展示，筛选/选中状态由 InboxPage 持有。 */
export function InboxList({ items, selectedId, now, onSelect }: InboxListProps) {
  if (items.length === 0) {
    return <div className="py-16 text-center text-sm text-muted-foreground">暂无通知</div>;
  }

  return (
    <ul className="space-y-1.5">
      {items.map((it) => {
        const selected = it.notification_id === selectedId;
        const unread = !it.read_at;
        return (
          <li key={it.notification_id}>
            <button
              type="button"
              data-selected={selected ? 'true' : 'false'}
              data-unread={unread ? 'true' : 'false'}
              onClick={() => onSelect(it.notification_id)}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors',
                'hover:bg-muted/60',
                selected && 'border-primary/30 bg-primary/10',
                !unread && 'opacity-55',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                  SEVERITY_ICON_CLASS[it.severity],
                )}
              >
                {SEVERITY_ICON[it.severity]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  {unread ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{it.title}</span>
                  {it.occurrence_count > 1 ? (
                    <span className="shrink-0 text-2xs text-muted-foreground">×{it.occurrence_count}</span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
                  <span>{formatRelativeTime(it.last_seen_at ?? it.first_seen_at ?? '', now)}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
