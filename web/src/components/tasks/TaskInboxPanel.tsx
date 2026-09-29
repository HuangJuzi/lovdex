import { useMemo, useState, type CSSProperties } from 'react';

import type { Task } from '../../types/app';

import type { TaskProjectOption } from './TaskCard';
import { hasOpenableSession } from './taskActions';
import { attentionItems, type AttentionAction, type AttentionTone } from './taskInbox';
import { formatAbsoluteTime, formatRelativeTime } from './taskTimestamp';

type TaskInboxPanelProps = {
  tasks: Task[];
  now: Date;
  projectOptions?: TaskProjectOption[];
  onRetry?: (task: Task) => void;
  onStart?: (task: Task) => void;
  onAccept?: (task: Task) => void;
  onIgnore?: (task: Task) => void;
  onOpenSession?: (task: Task) => void;
  onOpenTask?: (task: Task) => void;
};

const TONE_STYLE: Record<AttentionTone, CSSProperties> = {
  wait:   { color: 'hsl(var(--warning))', backgroundColor: 'hsl(var(--warning) / 0.1)', borderColor: 'hsl(var(--warning) / 0.3)' },
  fail:   { color: 'hsl(var(--destructive))', backgroundColor: 'hsl(var(--destructive) / 0.1)', borderColor: 'hsl(var(--destructive) / 0.3)' },
  accept: { color: 'hsl(var(--chart-6))', backgroundColor: 'hsl(var(--chart-6) / 0.1)', borderColor: 'hsl(var(--chart-6) / 0.3)' },
  plan:   { color: 'hsl(var(--info))', backgroundColor: 'hsl(var(--info) / 0.1)', borderColor: 'hsl(var(--info) / 0.3)' },
  late:   { color: 'hsl(var(--destructive))', backgroundColor: 'hsl(var(--destructive) / 0.1)', borderColor: 'hsl(var(--destructive) / 0.3)' },
};

const ACTION_META: Record<AttentionAction, { label: string; className: string }> = {
  retry:       { label: '↻ 重试', className: 'bg-primary/10 text-primary hover:bg-primary/20' },
  start:       { label: '▶ 开始执行', className: 'bg-primary/10 text-primary hover:bg-primary/20' },
  accept:      { label: '✓ 标记完成', className: 'bg-success/10 text-success hover:bg-success/20' },
  ignore:      { label: '🗄 忽略', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
  openSession: { label: '打开会话', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
  openTask:    { label: '查看', className: 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary' },
};

function projectInfo(task: Task, projectOptions: TaskProjectOption[]): { label: string; remoteHost: string | null } {
  if (task.is_operator === 1) return { label: '🤖 Lovdex助手', remoteHost: null };
  const opt = projectOptions.find((o) => o.value === task.project_path);
  return { label: opt?.label ?? task.project_path, remoteHost: opt?.remoteHostName ?? null };
}

export function TaskInboxPanel({
  tasks, now, projectOptions = [], onRetry, onStart, onAccept, onIgnore, onOpenSession, onOpenTask,
}: TaskInboxPanelProps) {
  const items = useMemo(() => attentionItems(tasks, now), [tasks, now]);
  const [collapsed, setCollapsed] = useState(false);
  if (items.length === 0) return null;

  const handlers: Record<AttentionAction, ((task: Task) => void) | undefined> = {
    retry: onRetry,
    start: onStart,
    accept: onAccept,
    ignore: onIgnore,
    openSession: onOpenSession,
    openTask: onOpenTask,
  };

  return (
    <div data-testid="task-inbox" className="flex flex-shrink-0 flex-col border-b border-border/60 bg-card">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left sm:px-4"
      >
        <span className="text-sm font-semibold text-foreground">需要你处理</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">{items.length}</span>
        <span className="ml-auto text-xs text-muted-foreground">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
      <div className="flex max-h-64 flex-col divide-y divide-border/60 overflow-y-auto">
        {items.map((item) => {
          const handler = handlers[item.action];
          const info = projectInfo(item.task, projectOptions);
          const showOpenSession = item.action !== 'openSession' && hasOpenableSession(item.task);
          const showIgnore = item.signal === 'failed' && item.action !== 'ignore' && !!onIgnore;
          return (
            <div
              key={item.task.task_id}
              className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-2.5 sm:px-4"
            >
              {/* 窄屏两行：第一行「状态 + 标题」，第二行「来路 + 时间 + 动作」。
                  挤一行时标题只剩几十像素（长标题直接被截成一个词），状态与标题
                  也糊在一起；两行后标题独占一行能显示十几个字。sm 起恢复单行。 */}
              <div className="flex min-w-0 items-center gap-2 sm:contents">
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-semibold"
                  style={TONE_STYLE[item.tone]}
                >
                  {item.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">{item.task.title}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2 sm:contents">
                {/* 窄屏上给标题让位：来路可以收窄（项目名本来就有 max-w-40），
                    动作按钮不能被压 —— 它是这一行唯一能点的东西。 */}
                <span className="flex min-w-0 shrink items-center gap-1.5 text-xs font-semibold text-foreground sm:shrink-0">
                  <span className="max-w-40 truncate">{info.label}</span>
                  {item.task.source_schedule_id && (
                    <span className="shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-3xs font-semibold text-warning">
                      ⏰ 定时
                    </span>
                  )}
                  {info.remoteHost && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-semibold text-muted-foreground">
                      🌐 {info.remoteHost}
                    </span>
                  )}
                </span>
                {/* 这条提醒「什么时候产生的」。`since` 为 null 表示时刻不可知
                    （例如审批请求早于后端进程启动）——此时整颗元素不渲染，
                    不退回 task_id、也不编一个时间。窄屏同样显示：手机上
                    「不知道什么时候产生」一样成立，且时间文案比 36 字符的
                    UUID 短得多。相对时间由父级 TaskBoard 每分钟重算（now prop）。 */}
                {item.since && (
                  <span
                    className="ml-auto shrink-0 whitespace-nowrap text-2xs text-muted-foreground sm:ml-0 sm:font-normal"
                    title={formatAbsoluteTime(item.since)}
                  >
                    {formatRelativeTime(item.since, now)}
                  </span>
                )}
                {/* 主操作 + 「忽略/打开会话」并列：只要有会话就能点进会话页看现场（失败任务
                    因此同时出现「重试」和「打开会话」）。主操作本身就是「打开会话」时
                    不再重复渲染第二个。失败条目的「忽略」是次级动作——即便调用方没传
                    主 handler（无 onRetry），它也必须自己撑起整个动作区。 */}
                {(handler || showIgnore || showOpenSession) && (
                  <span className={`flex shrink-0 items-center gap-1.5 ${item.since ? '' : 'ml-auto sm:ml-0'}`}>
                    {handler && (
                      <button
                        type="button"
                        onClick={() => handler(item.task)}
                        className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold transition-colors ${ACTION_META[item.action].className}`}
                      >
                        {ACTION_META[item.action].label}
                      </button>
                    )}
                    {showIgnore && onIgnore && (
                      <button
                        type="button"
                        onClick={() => onIgnore(item.task)}
                        className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold transition-colors ${ACTION_META.ignore.className}`}
                      >
                        {ACTION_META.ignore.label}
                      </button>
                    )}
                    {showOpenSession && onOpenSession && (
                      <button
                        type="button"
                        onClick={() => onOpenSession(item.task)}
                        className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold transition-colors ${ACTION_META.openSession.className}`}
                      >
                        {ACTION_META.openSession.label}
                      </button>
                    )}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
