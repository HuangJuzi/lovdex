import type { PendingPermissionRequest } from '../chat/types/types';

/**
 * 交互类工具的审批没有超时 —— 后端把它们的 `timeoutMs` 设为 0，
 * 语义是「无限等待」（见 backend/server/claude-sdk.js 的
 * ``timeoutMs 0 = wait indefinitely (interactive tools)``）。
 * 其余工具到点会被**自动拒绝**，所以它们才是需要抢时间的那一类。
 */
const INTERACTIVE_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'exit_plan_mode',
]);

/** 哨兵：用 NaN 会被 Math.max / 比较运算悄悄吞掉，用 Infinity 排序自然沉到最后。 */
export const NEVER_TIMES_OUT = Number.POSITIVE_INFINITY;

export function isInteractiveTool(toolName: string): boolean {
  return INTERACTIVE_TOOLS.has(toolName);
}

/**
 * 该请求会被自动拒绝的时刻（epoch ms）。永不超时返回 `NEVER_TIMES_OUT`。
 *
 * 缺 `receivedAt` 时按永不超时处理：倒计时是「再不管就要失败」的告警，
 * 宁可不报，也不要因为拿不到时间戳就编一个出来。
 */
export function timeoutAt(request: PendingPermissionRequest, timeoutMs: number): number {
  if (isInteractiveTool(request.toolName)) {
    return NEVER_TIMES_OUT;
  }
  const receivedAtMs = request.receivedAt instanceof Date ? request.receivedAt.getTime() : NaN;
  if (!Number.isFinite(receivedAtMs)) {
    return NEVER_TIMES_OUT;
  }
  return receivedAtMs + timeoutMs;
}

/**
 * 会超时的排前面（超时时刻升序），永不超时的排最后。
 * 返回新数组 —— 调用方可能持有原数组（React state），不能就地排序。
 */
export function sortPendingRequests(
  requests: readonly PendingPermissionRequest[],
  timeoutMs: number,
): PendingPermissionRequest[] {
  return [...requests].sort((a, b) => timeoutAt(a, timeoutMs) - timeoutAt(b, timeoutMs));
}

/** 剩余秒数（向上取整，下限 0）；永不超时返回 null。 */
export function remainingSeconds(
  request: PendingPermissionRequest,
  nowMs: number,
  timeoutMs: number,
): number | null {
  const at = timeoutAt(request, timeoutMs);
  if (at === NEVER_TIMES_OUT) {
    return null;
  }
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/**
 * 倒计时文案。最后 25 秒换成紧迫措辞 —— 单看数字递减不一定会让人意识到
 * 「到点会被自动拒绝、这次执行就没了」，而这不是能反悔的事。
 */
export function formatCountdown(seconds: number): string {
  return seconds > 24 ? `${seconds} 秒后自动拒绝` : `即将自动拒绝（${seconds} 秒）`;
}
