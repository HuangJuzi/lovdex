/**
 * 待办审批的「谁先到期」推算。纯函数，无 React 依赖。
 *
 * 交互类工具的审批在 **claude provider** 下没有超时 —— `claude-sdk.js` 给它们的
 * `timeoutMs` 传 0，语义是「无限等待」（见该文件注释
 * ``timeoutMs 0 = wait indefinitely (interactive tools)``）。其余工具到点会被
 * **自动拒绝**，所以它们才是需要抢时间的那一类。
 *
 * 「永不超时」是 claude provider 的说法，不是全后端的普遍事实：qoder 没有这条
 * 分支，`qoder-runner.js` 对**每一个**审批都套 `QODER_APPROVAL_TIMEOUT_MS`，
 * 交互类工具在那边同样会到点被拒。本模块只驱动 claude 通道的倒计时展示。
 */

import { AUTO_APPROVE_INTERACTION_TOOLS } from '../chat/utils/autoApproveDeny';
import type { PendingPermissionRequest } from '../chat/types/types';

/** 哨兵：用 NaN 会被 Math.max / 比较运算悄悄吞掉，用 Infinity 排序自然沉到最后。 */
export const NEVER_TIMES_OUT = Number.POSITIVE_INFINITY;

/**
 * 判据直接复用 `autoApproveDeny.ts` 的 `AUTO_APPROVE_INTERACTION_TOOLS`，
 * 不在这里另抄一份字面量：那份是全前端唯一副本，且与后端
 * `TOOLS_REQUIRING_INTERACTION` 之间有一条对账测试钉着。抄第二份就绕过了那条
 * 守卫 —— 后端将来加第三个交互型工具时，这里会**静默**漂开。
 *
 * 注意别凭「名字看着像」往回加 `exit_plan_mode`：那个拼写匹配不到任何真实工具
 * （SDK 里叫 `ExitPlanMode`，见 `claude-sdk.js` 的相关注释），后端照样给它正常
 * 超时。把它当成交互类，等于向用户承诺一个根本不会发生的无限等待。
 */
export function isInteractiveTool(toolName: string): boolean {
  return AUTO_APPROVE_INTERACTION_TOOLS.has(toolName);
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
