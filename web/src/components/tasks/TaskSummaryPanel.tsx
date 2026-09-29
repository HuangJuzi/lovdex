import { useMemo, useState, type ReactNode } from 'react';

import type { Task } from '../../types/app';
import type { PendingPermissionRequest } from '../chat/types/types';

import { replyState } from './panelReply';
import { PendingPromptList } from './PendingPromptList';
import { LABEL_META, PRIORITY_META, STATUS_META, SUB_STATUS_META } from './taskStatus';
import { TaskPanelReplyBox, type QuickReplyItem } from './TaskPanelReplyBox';
import { formatAbsoluteTime, formatRelativeTime } from './taskTimestamp';
import type { PendingDecision } from './useSessionPendingRequests';

export interface TaskSummaryPanelProps {
  task: Task;
  isProcessing: boolean;
  pendingRequests: PendingPermissionRequest[];
  /** 由父级注入的「现在」，统一面板内所有相对时间与倒计时的节拍，也让测试可钉。 */
  nowMs: number;
  timeoutMs: number;
  resultText: string;
  replyValue: string;
  onReplyChange: (next: string) => void;
  onReplySend: () => void;
  quickReplies: QuickReplyItem[];
  onInsertQuickReply: (item: QuickReplyItem) => void;
  onRespond: (requestId: string, decision: PendingDecision) => void;
  onClose: () => void;
  onOpenSession: () => void;
  onOpenDetail: () => void;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-4xs uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/**
 * chip 行里的一枚小胶囊。`style` 走 META 的配色（`PRIORITY_META.bg` /
 * `LABEL_META.bg` 是 `hsl(var(--x) / 0.1)` 这种**合法**的 CSS 颜色值）。
 *
 * 状态 chip 例外：`SUB_STATUS_META.color` / `STATUS_META.color` 是
 * `hsl(var(--warning))` —— 它**不能**直接塞进 `backgroundColor`，拼不出合法颜色。
 * 所以状态 chip 只取 `color` 染字，底色留给 `className`（默认 `bg-muted`，
 * 与 SubStatusBadge 同款）。
 */
function Chip({
  children,
  style,
  className = 'bg-muted',
}: {
  children: ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold ${className}`} style={style}>
      {children}
    </span>
  );
}

/**
 * 任务缩略面板。
 *
 * 面板本身**不取数** —— 所有数据由 TaskBoardPage 传入。两个原因：一是可静态渲染
 * 测试（本仓库前端无 jsdom，组件测试只能断言 markup）；二是面板要跟随列表的选中
 * 行切换，「选中哪一条」天然属于父级，面板自己再存一份就会与列表打架。
 *
 * 「任务详情 →」是唯一跳转到全页详情的入口。在此之前，点列表行只会**展开面板**
 * —— 把「看一眼」和「进入」这两件事分开，是这次改造的全部目的。
 */
export function TaskSummaryPanel({
  task,
  isProcessing,
  pendingRequests,
  nowMs,
  timeoutMs,
  resultText,
  replyValue,
  onReplyChange,
  onReplySend,
  quickReplies,
  onInsertQuickReply,
  onRespond,
  onClose,
  onOpenSession,
  onOpenDetail,
}: TaskSummaryPanelProps) {
  const [resultExpanded, setResultExpanded] = useState(false);

  const state = useMemo(
    () => replyState({ task, isProcessing, hasPendingPrompt: pendingRequests.length > 0 }),
    [task, isProcessing, pendingRequests.length],
  );

  /**
   * 头部状态点 / chip 的取值：细标签（sub_status）优先，没有才退回粗标签（status）。
   *
   * 计划稿写的是 `SUB_STATUS_META[task.sub_status ?? 'running']`，那在 `sub_status`
   * 为 null 时会**凭空**报出「会话运行中」—— 而 null 恰恰是 todo / done 列的常态
   * （后端只在有实时或持久细标签时才置值），一条待办任务会被显示成正在跑。回退到
   * `STATUS_META[task.status]` 才是它真正的状态。
   */
  const subMeta = task.sub_status ? SUB_STATUS_META[task.sub_status] : undefined;
  const statusLabel = subMeta?.label ?? STATUS_META[task.status].label;
  const statusColor = subMeta?.color ?? STATUS_META[task.status].color;

  /**
   * 会话能不能用由 `panelReply.ts` 的 `hasOpenableSession` 独家判定（同时覆盖
   * 「没有 session_id」与「session_id 指向被硬删的会话行」两种形态）。这里只把它
   * 的结果取出来给底部按钮复用，**不另抄一份判据** —— 抄第二份就等于绕过了那唯一
   * 副本，将来多出一种「会话不可用」的形态时会静默放行。
   */
  const hasSession = state.mode !== 'no-session';

  return (
    <>
      <div className="flex items-start gap-2 border-b border-border px-3.5 py-2.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor }} />
        <span className="min-w-0 flex-1 break-words text-xs font-semibold leading-snug text-foreground">
          {task.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭面板"
          className="rounded px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3.5 py-3">
        <div className="flex flex-wrap gap-1.5">
          <Chip style={{ color: statusColor }}>
            {statusLabel}
          </Chip>
          {task.priority ? (
            <Chip
              style={{
                color: PRIORITY_META[task.priority].color,
                backgroundColor: PRIORITY_META[task.priority].bg,
              }}
            >
              {PRIORITY_META[task.priority].label}
            </Chip>
          ) : null}
          {LABEL_META[task.label] ? (
            <Chip style={{ color: LABEL_META[task.label].color, backgroundColor: LABEL_META[task.label].bg }}>
              {LABEL_META[task.label].label}
            </Chip>
          ) : null}
        </div>

        {/* 待办区是条件渲染的 —— 无待办时它连空壳都不留（PendingPromptList 自己
            返回 null）。`auto` / `bypassPermissions` 模式与无人值守任务下，SDK 根本
            不会发 `can_useTool`，这里就是常态。 */}
        <PendingPromptList
          requests={pendingRequests}
          nowMs={nowMs}
          timeoutMs={timeoutMs}
          onRespond={onRespond}
        />

        {task.ai_summary ? (
          <Section label="完成度">
            <div className="rounded-lg border border-border bg-muted p-2.5 text-xs leading-relaxed text-card-foreground">
              {task.ai_summary}
            </div>
          </Section>
        ) : null}

        {resultText ? (
          <Section label="最近结果">
            <div
              className={`rounded-lg border border-border bg-muted p-2.5 text-xs leading-relaxed text-card-foreground ${
                resultExpanded ? '' : 'max-h-24 overflow-hidden'
              }`}
            >
              {resultText}
            </div>
            <button
              type="button"
              onClick={() => setResultExpanded((previous) => !previous)}
              className="mt-1 text-2xs font-medium text-primary"
            >
              {resultExpanded ? '收起 ↑' : '展开全部 ↓'}
            </button>
          </Section>
        ) : null}

        <section className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-xs">
          <span className="text-muted-foreground">引擎</span>
          <span className="text-foreground">
            {task.executor_provider}
            {task.executor_model ? ` · ${task.executor_model}` : ''}
          </span>
          <span className="text-muted-foreground">创建</span>
          <span className="text-foreground">{formatAbsoluteTime(task.created_at)}</span>
          <span className="text-muted-foreground">活动</span>
          <span className="text-foreground">{formatRelativeTime(task.updated_at, new Date(nowMs))}</span>
        </section>
      </div>

      {/* 常用语不在这里预筛：`TaskPanelReplyBox` 内部的 `showQuickReplies` 已经
          用同一个 `canType` 判定过（会话被清理时整行都不画）。在这里再写一遍
          `hasSession ? … : []` 是同一条件的第二份副本 —— 下层已经是唯一副本了，
          上层这份不产生任何可见差异（mutation 存活率测试证实），只会诱使后来的
          人以为「面板筛了一道」，挪走下层的判断时才发现两处都在管。 */}
      <TaskPanelReplyBox
        value={replyValue}
        onChange={onReplyChange}
        onSend={onReplySend}
        quickReplies={quickReplies}
        replyState={state}
        onInsertQuickReply={onInsertQuickReply}
      />

      <div className="flex gap-2 border-t border-border px-3.5 py-2.5">
        <button
          type="button"
          disabled={!hasSession}
          onClick={onOpenSession}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-foreground hover:bg-accent disabled:opacity-40"
        >
          在会话里处理 →
        </button>
        <button
          type="button"
          onClick={onOpenDetail}
          className="ml-auto rounded-md bg-primary px-3 py-1.5 text-2xs text-primary-foreground hover:opacity-90"
        >
          任务详情 →
        </button>
      </div>
    </>
  );
}

export default TaskSummaryPanel;
