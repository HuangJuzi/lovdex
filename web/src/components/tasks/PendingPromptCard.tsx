import { useState, type ReactNode } from 'react';

import type { PendingPermissionRequest, Question } from '../chat/types/types';
import {
  buildClaudeToolPermissionEntry,
  formatToolInputForDisplay,
} from '../chat/utils/chatPermissions';

import { formatCountdown, remainingSeconds } from './panelPermission';
import type { PendingDecision } from './useSessionPendingRequests';

export interface PendingPromptCardProps {
  request: PendingPermissionRequest;
  /** 由父级注入的「现在」，好让倒计时可测且统一节拍。 */
  nowMs: number;
  timeoutMs: number;
  onRespond: (requestId: string, decision: PendingDecision) => void;
}

/** 交互类工具在 claude 通道下没有超时 —— 判据在 panelPermission，别在此另判。 */
const PLAN_TOOL_NAMES = new Set(['ExitPlanMode', 'exit_plan_mode']);

const cardShell = 'flex flex-col gap-2.5 rounded-lg border border-info/40 bg-info/5 p-3';

function Badge({ tone, children }: { tone: 'question' | 'plan' | 'approval'; children: ReactNode }) {
  const cls =
    tone === 'plan'
      ? 'bg-info text-info-foreground'
      : 'bg-warning text-warning-foreground';
  return <span className={`rounded-full px-2 py-0.5 text-3xs font-semibold ${cls}`}>{children}</span>;
}

/**
 * 超时提示。
 *
 * 只在这里出现「自动拒绝」四个字：交互类工具（AskUserQuestion / ExitPlanMode）
 * 与缺 `receivedAt` 的请求都拿不到剩余秒数，此时说一句「不会超时」比编一个
 * 倒计时诚实 —— 倒计时是「再不管就要失败」的告警，报错了比不报更坏。
 */
function TimeoutHint({ request, nowMs, timeoutMs }: { request: PendingPermissionRequest; nowMs: number; timeoutMs: number }) {
  const seconds = remainingSeconds(request, nowMs, timeoutMs);

  if (seconds === null) {
    return <span className="ml-auto text-3xs text-muted-foreground">不会超时 · 等着你</span>;
  }

  const urgent = seconds < 25;
  return (
    <span
      className={`ml-auto rounded-full border px-2 py-0.5 text-3xs font-semibold ${
        urgent
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-border bg-muted text-muted-foreground'
      }`}
    >
      {formatCountdown(seconds)}
    </span>
  );
}

/**
 * AskUserQuestion：逐题列选项。
 *
 * 答案形状 `Record<questionText, label>` 与聊天页的 `AskUserQuestionPanel` 一致
 * （那边多选会把多个 label 用 `', '` 拼起来，这里只做单选，故直接是 label 本身）。
 * 多问题时按顺序作答，**答满全部题目才提交** —— 提前提交会让后端拿到一份缺项
 * 的答案，模型的提问就等于被吞了。
 */
function AskUserQuestionBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { questions?: Question[] } | undefined;
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const [picked, setPicked] = useState<Record<string, string>>({});

  if (questions.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground">
        这条提问没有可选项，可以直接在下方输入回复。
      </p>
    );
  }

  const answer = (questionText: string, label: string) => {
    const next = { ...picked, [questionText]: label };
    setPicked(next);

    if (questions.every((question) => next[question.question])) {
      const answers: Record<string, string> = {};
      for (const question of questions) {
        answers[question.question] = next[question.question];
      }
      onRespond(request.requestId, {
        allow: true,
        updatedInput: { ...(input ?? {}), answers },
      });
    }
  };

  return (
    <>
      {questions.map((question) => (
        <div key={question.question}>
          <div className="text-xs font-semibold text-foreground">{question.question}</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {question.options.map((option) => {
              const selected = picked[question.question] === option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => answer(question.question, option.label)}
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary'
                  }`}
                >
                  <span
                    className={`mt-0.5 text-3xs ${selected ? 'text-primary' : 'text-muted-foreground'}`}
                    aria-hidden="true"
                  >
                    ●
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-foreground">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-2xs text-muted-foreground">{option.description}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** ExitPlanMode：计划原文 + 两个动作。文案与聊天页 `PlanDisplay` 逐字一致。 */
function PlanBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { plan?: string } | undefined;
  const plan = typeof input?.plan === 'string' ? input.plan : '';

  return (
    <>
      <div className="max-h-40 overflow-hidden whitespace-pre-wrap rounded-md border border-border bg-card p-2.5 text-2xs leading-relaxed text-card-foreground">
        {plan}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onRespond(request.requestId, { allow: false, message: 'User asked to revise the plan' })
          }
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          ↺ 让它改
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: true })}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          ✓ 开始执行
        </button>
      </div>
    </>
  );
}

/**
 * 通用工具授权。
 *
 * `rememberEntry` 不自己拼格式：用聊天页同一个
 * `buildClaudeToolPermissionEntry`，否则「总是允许」写进 `allowedTools` 的规则
 * 与聊天页写的不是同一条，用户的许可会在两处表现不一致。它只对 `Bash` 产出具
 * 体规则（`Bash(git commit:*)`），别的工具返回裸工具名（配合发送侧现有的
 * 行为一致），因此这里仅当它返回非空时启用按钮。
 */
function ToolApprovalBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { command?: string } | undefined;
  // command 是字符串就显示原文；否则回退到 JSON —— formatToolInputForDisplay 内
  // 部已 try/catch，循环引用不会让渲染炸掉。
  const commandText =
    typeof input?.command === 'string' ? input.command : formatToolInputForDisplay(request.input);
  const rememberEntry = buildClaudeToolPermissionEntry(
    request.toolName,
    formatToolInputForDisplay(request.input),
  );

  return (
    <>
      <div className="rounded-md border border-border bg-card p-2.5">
        <div className="text-xs font-semibold text-foreground">{request.toolName}</div>
        <pre className="mt-1.5 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-2xs text-card-foreground">
          {commandText}
        </pre>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onRespond(request.requestId, { allow: false, message: 'User denied tool use' })
          }
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-muted"
        >
          ✕ 拒绝
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: true })}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          ✓ 允许一次
        </button>
        <button
          type="button"
          disabled={!rememberEntry}
          onClick={() => {
            if (rememberEntry) {
              onRespond(request.requestId, { allow: true, rememberEntry });
            }
          }}
          className="rounded-md bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          ✓ 总是允许
        </button>
      </div>
      <div className="text-3xs text-muted-foreground">
        「总是允许」把它加进 <code className="rounded bg-muted px-1">allowedTools</code>，
        <strong className="font-semibold">仅本次会话有效</strong>，后续同类不再问。
      </div>
    </>
  );
}

/**
 * 单条待办。按 toolName 分派到三种形态。
 *
 * 为什么不用聊天页的 `AskUserQuestionPanel` / `PlanDisplay`：前者可以（纯 props
 * 驱动），后者不行 —— 它从 `PermissionContext` 取待办，而那个 Provider 只存在于
 * `ChatInterface` 内部，本面板在任务详情里，不在其组件树下。为了让两条路的行为
 * 一致、且给倒计时这类新信息一个落脚点，这里统一自绘。
 */
export function PendingPromptCard({ request, nowMs, timeoutMs, onRespond }: PendingPromptCardProps) {
  const isQuestion = request.toolName === 'AskUserQuestion';
  const isPlan = PLAN_TOOL_NAMES.has(request.toolName);

  const title = isQuestion
    ? '它在等你回答'
    : isPlan
      ? '它写好计划了，等你点头'
      : '要执行一个写操作';

  return (
    <div className={cardShell}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isQuestion ? 'question' : isPlan ? 'plan' : 'approval'}>
          {isQuestion ? '需要选择' : isPlan ? '计划待批准' : '需要授权'}
        </Badge>
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <TimeoutHint request={request} nowMs={nowMs} timeoutMs={timeoutMs} />
      </div>

      {isQuestion ? <AskUserQuestionBody request={request} onRespond={onRespond} /> : null}
      {isPlan ? <PlanBody request={request} onRespond={onRespond} /> : null}
      {isQuestion || isPlan ? null : <ToolApprovalBody request={request} onRespond={onRespond} />}
    </div>
  );
}

export default PendingPromptCard;
