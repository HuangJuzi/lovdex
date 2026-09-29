import { useState, type ReactNode } from 'react';

import type { PendingPermissionRequest, Question } from '../chat/types/types';
import {
  buildClaudeToolPermissionEntry,
  formatToolInputForDisplay,
} from '../chat/utils/chatPermissions';

import { formatCountdown, remainingSeconds } from './panelPermission';
import { formatAnswers, nextSelection, type PickedState } from './pendingPromptAnswers';
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
 * 答案载荷 `Record<questionText, answer>` 与聊天页的 `AskUserQuestionPanel` 一致：
 * 多选把 label 用 `', '` 拼成一串，单选就是 label 本身（`formatAnswers`）。
 * 两种模式都**答满全部题目才提交** —— 提前提交会让后端拿到一份缺项的答案，模型
 * 的提问就等于被吞了。（这条比聊天页更严：那边可以带着未作答的前序题目前进，
 * 见 `pendingPromptAnswers.ts` 的文件头。）
 *
 * 交互**不是**聊天页的样子，这是刻意的：聊天页选项点击不提交（提交在页脚的
 * Submit/Next，见 `AskUserQuestionPanel.tsx:362`），因为它有常驻页脚与键盘层；
 * 本卡片没有页脚的位置，单选点一下即选中并提交（若其余题目也已答完）以省掉
 * 那第二下，多选点一下是**切换**（再点取消）、必须按「提交选择」才发出。会给
 * 模型一个多选问题时，用户的意图就是「可以选好几个」—— 单选式的一击即发会让
 * 模型拿到一个偏窄的答案，而界面上没有任何东西提示他本可以多选。
 *
 * 这些点击语义**全部**在 `pendingPromptAnswers.ts` 里（有 node:test 覆盖）——
 * 本文件只负责接线：本仓库的 web 测试没有 DOM、不能模拟点击，逻辑留在这个
 * `onClick` 闭包里就等于没有任何测试碰得到它。**代价**：接线本身（`pick` /
 * `respondWith`）测不到，见该文件与计划 Task 4 Step 6 的边界说明。
 *
 * 刻意**不**移植聊天页的键盘层（1-9 选号、0 = Other、Enter = 前进/提交、
 * Esc = 跳过）与 Back/Next 分步器：任务面板是鼠标优先、且还没有焦点模型，
 * 抄一套半吊子的键盘处理只会制造「有的键有效有的键没效」的错觉。
 *
 * 「Other」自由输入也不做：它需要一个受控 input + 焦点管理，超出本卡片的
 * 范围；聊天页那边仍然由 AskUserQuestionPanel 提供。
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
  /** 选择状态。题型差异与「该不该提交」的判断全在 pendingPromptAnswers（有测试）。 */
  const [picked, setPicked] = useState<PickedState>({});

  if (questions.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground">
        这条提问没有可选项，可以直接在下方输入回复。
      </p>
    );
  }

  const respondWith = (state: PickedState) => {
    onRespond(request.requestId, {
      allow: true,
      updatedInput: { ...(input ?? {}), answers: formatAnswers(state, questions) },
    });
  };

  const pick = (questionIndex: number, label: string) => {
    const result = nextSelection(picked, questions, questionIndex, label);
    setPicked(result.picked);
    if (!result.submit) {
      return;
    }
    respondWith(result.picked);
  };

  return (
    <>
      {questions.map((question, questionIndex) => {
        const current = picked[question.question] ?? [];
        const multi = question.multiSelect === true;
        const ready = current.length > 0;
        return (
          <div key={question.question}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs font-semibold text-foreground">{question.question}</span>
              {multi ? <span className="text-3xs text-muted-foreground">可多选</span> : null}
            </div>
            <div
              className="mt-1.5 flex flex-col gap-1"
              role={multi ? 'group' : 'radiogroup'}
              aria-label={question.question}
            >
              {question.options.map((option) => {
                const selected = current.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => pick(questionIndex, option.label)}
                    className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                      selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary'
                    }`}
                  >
                    <span
                      className={`mt-0.5 text-3xs ${selected ? 'text-primary' : 'text-muted-foreground'}`}
                      aria-hidden="true"
                    >
                      {multi ? (selected ? '☑' : '☐') : '●'}
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
            {multi ? (
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => respondWith(picked)}
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  提交选择
                </button>
                <span className="text-3xs text-muted-foreground">
                  已选 {current.length} 项 · 再点一下取消
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * ExitPlanMode：计划原文 + 两个动作。
 *
 * **决定的载荷**与聊天页 `PlanDisplay` 逐字一致：`{ allow: false, message:
 * 'User asked to revise the plan' }` 与 `{ allow: true }`。前者是给**模型**读的
 * 协议指令（`PlanDisplay.tsx` 的 `handleRevise` 同一串，模型据此知道要改计划），
 * 拼错一个字就会静默失效，所以它是本卡片里最不能自由发挥的一处。
 *
 * 按钮**标签**则不同：聊天页是英文 `Revise` / `Build`（`PlanDisplay.tsx` 页脚），
 * 这里按任务面板的中文口径写成「让它改 / 开始执行」。标签只给人看，不影响模型。
 */
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
 * 体规则（`git commit -m "..."` → `Bash(git commit:*)`，是**前缀**不是整条命令），
 * 别的工具返回裸工具名，因此这里仅当它返回非空时启用按钮。
 * 按钮**标签**不同（聊天页是 `Allow & remember` / `Allow (saved)`，本卡片是
 * 「总是允许」）—— 标签给人看，载荷才是契约。
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
 * 为什么不用聊天页的 `AskUserQuestionPanel` / `PlanDisplay`：前者是纯 props 驱动
 * 的、技术上能用（`permissionPanelRegistry` 就是按 props 接的），但它是带常驻
 * 页脚与键盘层的多步对话框，塞进 428px 侧栏就散架；后者根本不能用 —— 它从
 * `PermissionContext` 取待办，而那个 Provider 只存在于 `ChatInterface` 内部，
 * 本面板在任务详情里，不在其组件树下。为了给倒计时这类新信息一个落脚点、并
 * 让布局适配侧栏，这里统一自绘。
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
