import { useMemo, type CSSProperties } from 'react';

import type { Task } from '../../types/app';

import type { TaskProjectOption } from './TaskCard';
import { attentionItems, type AttentionAction, type AttentionTone } from './taskInbox';

type TaskInboxPanelProps = {
  tasks: Task[];
  now: Date;
  projectOptions?: TaskProjectOption[];
  onRetry?: (task: Task) => void;
  onStart?: (task: Task) => void;
  onAccept?: (task: Task) => void;
  onOpenSession?: (task: Task) => void;
  onOpenTask?: (task: Task) => void;
};

const TONE_STYLE: Record<AttentionTone, CSSProperties> = {
  wait:   { color: '#92400e', backgroundColor: '#fef3c7', borderColor: '#fde68a' },
  fail:   { color: '#991b1b', backgroundColor: '#fee2e2', borderColor: '#fecaca' },
  accept: { color: '#7e22ce', backgroundColor: '#f3e8ff', borderColor: '#e9d5ff' },
  plan:   { color: '#1e40af', backgroundColor: '#dbeafe', borderColor: '#bfdbfe' },
  late:   { color: '#991b1b', backgroundColor: '#fee2e2', borderColor: '#fecaca' },
};

const ACTION_META: Record<AttentionAction, { label: string; className: string }> = {
  retry:       { label: '↻ 重试', className: 'bg-primary/10 text-primary hover:bg-primary/20' },
  start:       { label: '▶ 开始执行', className: 'bg-primary/10 text-primary hover:bg-primary/20' },
  accept:      { label: '✓ 标记完成', className: 'bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400' },
  openSession: { label: '打开会话', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
  openTask:    { label: '查看', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
};

function projectInfo(task: Task, projectOptions: TaskProjectOption[]): { label: string; remoteHost: string | null } {
  if (task.is_operator === 1) return { label: '🤖 Lovdex助手', remoteHost: null };
  const opt = projectOptions.find((o) => o.value === task.project_path);
  return { label: opt?.label ?? task.project_path, remoteHost: opt?.remoteHostName ?? null };
}

export function TaskInboxPanel({
  tasks, now, projectOptions = [], onRetry, onStart, onAccept, onOpenSession, onOpenTask,
}: TaskInboxPanelProps) {
  const items = useMemo(() => attentionItems(tasks, now), [tasks, now]);
  if (items.length === 0) return null;

  const handlers: Record<AttentionAction, ((task: Task) => void) | undefined> = {
    retry: onRetry,
    start: onStart,
    accept: onAccept,
    openSession: onOpenSession,
    openTask: onOpenTask,
  };

  return (
    <div data-testid="task-inbox" className="flex flex-shrink-0 flex-col border-b border-border/60 bg-card">
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
        <span className="text-sm font-semibold text-foreground">需要你处理</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{items.length}</span>
      </div>
      <div className="flex max-h-64 flex-col divide-y divide-border/60 overflow-y-auto">
        {items.map((item) => {
          const handler = handlers[item.action];
          const info = projectInfo(item.task, projectOptions);
          return (
            <div key={item.task.task_id} className="flex items-center gap-2.5 px-3 py-2 sm:px-4">
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold"
                style={TONE_STYLE[item.tone]}
              >
                {item.label}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-card-foreground">
                <span className="min-w-0 truncate">{item.task.title}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-foreground">
                  <span className="max-w-40 truncate">{info.label}</span>
                  {info.remoteHost && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      🌐 {info.remoteHost}
                    </span>
                  )}
                </span>
              </span>
              <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                {item.task.task_id}
              </span>
              {handler && (
                <button
                  type="button"
                  onClick={() => handler(item.task)}
                  className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${ACTION_META[item.action].className}`}
                >
                  {ACTION_META[item.action].label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
