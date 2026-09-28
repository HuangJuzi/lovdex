/**
 * 待办队列的派生：谁是当前那一条、要不要画队列条、每行写什么。
 *
 * 纯函数，无 React 依赖 —— 本仓库的 web 测试没有 DOM、不能模拟点击，任何留在
 * 组件 `onClick` / 组件状态里的决定都测不到。Task 4 的点击语义就是这么被逼进
 * `pendingPromptAnswers.ts` 的，这里同理。
 *
 * **当前项的推导**：队头（排序后的第一项），不引入任何下标状态。
 * 曾经的计划稿用「入参下标 + clamp effect」：下标从一个从不变化的状态出发，
 * 只有 `handleRespond` 里那行乐观推进动过它 —— 但乐观推进读的又是同一个
 * `index`，它恒为 0，所以整台状态机是死的，队头永远是「当前」。而真正让队列
 * 前移的是**父级**：`useSessionPendingRequests.respond` 已把答掉的那条从
 * `pendingRequests` 里摘掉（乐观移除），父级重渲染即新的入参，队头自然换人。
 * 派生队头既是同一个结果，又不必假设「本地状态」与「父级真源」不会打架 ——
 * 摘除由父级负责时，本地下标还会在父级改主意（比如后端纠正）时错位。
 */

import type { PendingPermissionRequest } from '../chat/types/types';

import { formatCountdown, remainingSeconds, sortPendingRequests } from './panelPermission';

/**
 * 计划类工具的**分派**拼写。这与 `PendingPromptCard.tsx` 里的 `PLAN_TOOL_NAMES`
 * 是同一对：SDK 实际发的是 `ExitPlanMode`，`exit_plan_mode` 是历史/别处的拼写，
 * 前端一律两种都认（见该卡片、`ToolRenderer.tsx:50`、`PlanDisplay.tsx:43`）。
 * 它不是「交互型工具」契约 —— 那份名单在 `autoApproveDeny.ts`，与此无关，
 * 别把两者并成一个。
 */
const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(['ExitPlanMode', 'exit_plan_mode']);

export interface PendingQueueView {
  /** 排序后的队列：会超时的在前（超时时刻升序），永不超时的沉底。 */
  sorted: PendingPermissionRequest[];
  /** 当前要完整渲染的那一条；空队为 null。 */
  current: PendingPermissionRequest | null;
  /** 队列条只在**两条及以上**时画：一条的「队」是噪音。 */
  showQueue: boolean;
}

/** 把一队待办折成「当前项 + 要不要画队列条」。 */
export function pendingQueueView(
  requests: readonly PendingPermissionRequest[],
  timeoutMs: number,
): PendingQueueView {
  const sorted = sortPendingRequests(requests, timeoutMs);
  return {
    sorted,
    current: sorted[0] ?? null,
    showQueue: sorted.length > 1,
  };
}

/**
 * 队列里一行的短描述（非当前项用）。
 *
 * `input` 的形状不可信（它一路从后端帧透传过来），所以每一层都当可能是任意值
 * 来收：拿不到题面就退化成「回答一个问题」，不把 `undefined` 或空串拼进界面。
 */
export function summarizePendingRequest(request: PendingPermissionRequest): string {
  if (request.toolName === 'AskUserQuestion') {
    const input = request.input as { questions?: unknown } | undefined;
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const first = (questions[0] as { question?: unknown } | undefined)?.question;
    return typeof first === 'string' && first ? `回答「${first}」` : '回答一个问题';
  }
  if (PLAN_TOOL_NAMES.has(request.toolName)) {
    return '确认它写的计划';
  }
  return `允许 ${request.toolName} 执行`;
}

/**
 * 队列一行的剩余时间文案。永不超时的请求与卡片口径一致说「不会超时」——
 * 这里刻意不复用卡片的 `TimeoutHint`（那是带边框的胶囊，塞进 11px 的行里会撑破），
 * 但文案复用 `formatCountdown`，免得「自动拒绝」的措辞分头漂开。
 */
export function pendingTimeText(
  request: PendingPermissionRequest,
  nowMs: number,
  timeoutMs: number,
): string {
  const seconds = remainingSeconds(request, nowMs, timeoutMs);
  return seconds === null ? '不会超时' : formatCountdown(seconds);
}
