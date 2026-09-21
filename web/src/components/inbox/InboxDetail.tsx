import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';
import { formatAbsoluteTime, formatRelativeTime } from '../tasks/taskTimestamp';

import { inboxTargetPath, severityLabel, sourceLabel } from './inboxTarget';

type InboxDetailProps = {
  item: InboxNotification | null;
  now: Date;
  onMarkRead: (id: string) => void;
  onNavigate: (path: string) => void;
};

const SEVERITY_ICON: Record<InboxSeverity, ReactNode> = {
  critical: <AlertCircle className="h-4 w-4" />,
  warning: <AlertTriangle className="h-4 w-4" />,
  info: <Info className="h-4 w-4" />,
};

const SEVERITY_ICON_CLASS: Record<InboxSeverity, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-muted text-muted-foreground',
};

/** 单条通知详情。桌面端作为右栏，移动端塞进底部 sheet —— 同一个组件两种容器。 */
export function InboxDetail({ item, now, onMarkRead, onNavigate }: InboxDetailProps) {
  if (!item) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        从左侧选一条通知
      </div>
    );
  }

  const target = inboxTargetPath(item);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-start gap-2.5">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${SEVERITY_ICON_CLASS[item.severity]}`}
        >
          {SEVERITY_ICON[item.severity]}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{item.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-semibold">
              {severityLabel(item.severity)}
            </span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-semibold">
              {sourceLabel(item)}
            </span>
            {item.code ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{item.code}</span>
            ) : null}
            {item.occurrence_count > 1 ? <span>×{item.occurrence_count}</span> : null}
          </div>
        </div>
      </div>

      <p className="mt-3 text-2xs text-muted-foreground">
        首次 {formatAbsoluteTime(item.first_seen_at ?? '')}（{formatRelativeTime(item.first_seen_at ?? '', now)}）
        {item.last_seen_at && item.last_seen_at !== item.first_seen_at
          ? ` · 最近 ${formatAbsoluteTime(item.last_seen_at)}（${formatRelativeTime(item.last_seen_at, now)}）`
          : ''}
      </p>

      {item.body ? (
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground">{item.body}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">（无详细内容）</p>
      )}

      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {item.session_id ? (
          <Button size="sm" onClick={() => target && onNavigate(`/session/${item.session_id}`)}>
            打开会话
          </Button>
        ) : null}
        {item.task_id ? (
          <Button size="sm" variant="outline" onClick={() => target && onNavigate(`/task/${item.task_id}`)}>
            查看任务
          </Button>
        ) : null}
        {item.code === 'skill_update' ? (
          <Button size="sm" variant="outline" onClick={() => onNavigate('/settings?tab=skills')}>
            去更新技能
          </Button>
        ) : null}
        {!item.read_at ? (
          <Button size="sm" variant="ghost" onClick={() => onMarkRead(item.notification_id)}>
            标记已读
          </Button>
        ) : null}
      </div>
    </div>
  );
}
