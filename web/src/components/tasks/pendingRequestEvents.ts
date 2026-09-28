/**
 * 把一个 socket 帧折算进「本会话待办审批」状态的**纯函数**。
 *
 * 为什么独立成文件：这个仓库的前端测试是 `node:test` **无 jsdom**，钩子本体
 * 测不到。把折叠逻辑挤出来，语义（去重、跨会话过滤、丢帧兜底）才测得到 ——
 * 与 `panelPermission.ts` / `panelReply.ts` 同一分工。
 *
 * 线上契约（都在后端，别凭记忆改）：
 *  - 每个出站帧的 `sessionId` 都是**应用会话 id**：registry 在 `publishMessage`
 *    里统一覆写 `sessionId: run.appSessionId`（`chat-run-registry.service.ts`，
 *    出站构造处），所以直接用任务/会话的 `session_id` 比就是对的。
 *  - `chat_subscribed`（`handleChatSubscribe`）带 `isProcessing` 与
 *    `pendingPermissions` 全量快照；`permission_request` / `permission_cancelled`
 *    是运行中的增量帧。
 */

import type { PendingPermissionRequest } from '../chat/types/types';

export interface PendingRequestsState {
  pendingRequests: PendingPermissionRequest[];
  isProcessing: boolean;
}

export type PendingRequestsEvent =
  | { kind: 'chat_subscribed'; sessionId?: string; isProcessing?: boolean; pendingPermissions?: unknown }
  | { kind: 'permission_request'; sessionId?: string; requestId?: string; toolName?: string; input?: unknown; context?: unknown }
  | { kind: 'permission_cancelled'; sessionId?: string; requestId?: string }
  | { kind: 'complete'; sessionId?: string }
  | { kind: 'other' };

export const EMPTY_PENDING_STATE: PendingRequestsState = { pendingRequests: [], isProcessing: false };

export interface ApplyPendingEventOptions {
  /** 可注入的「现在」，缺省取真实时间；测试用它钉住打的点。 */
  now?: Date;
}

/**
 * `chat_subscribed` 快照里的条目已经带了 `receivedAt`，但它**不是 Date**：
 * 帧经由 `JSON.stringify` 出去，Date 会序列化成 ISO 字符串。不在这里转回来，
 * 倒计时（`panelPermission.timeoutAt` 只认 `instanceof Date`）会静默失效 ——
 * 刷新页面后所有待办都变成「永不超时」。
 *
 * 缺时间戳时才打 `now`：调用方注入的时钟优先，否则每次刷新都会把快照里已有
 * 的真实等待时长冲掉，倒计时从头开始。
 */
function stampReceivedAt(item: PendingPermissionRequest, now: Date): PendingPermissionRequest {
  if (item.receivedAt === undefined || item.receivedAt === null) {
    return { ...item, receivedAt: now };
  }
  return { ...item, receivedAt: new Date(item.receivedAt as unknown as string | number | Date) };
}

export function applyPendingEvent(
  state: PendingRequestsState,
  event: PendingRequestsEvent,
  sessionId: string | null,
  options: ApplyPendingEventOptions = {},
): PendingRequestsState {
  // 没选中会话就没什么可跟踪的 —— 所有帧一律原样返回同一引用。
  if (!sessionId) {
    return state;
  }

  const now = options.now ?? new Date();

  switch (event.kind) {
    case 'chat_subscribed': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      // 快照是权威的：整体替换，且非数组时归零 —— 留着上个会话的条目会让面板
      // 显示一个答不了的按钮。
      const items = Array.isArray(event.pendingPermissions)
        ? (event.pendingPermissions as PendingPermissionRequest[]).map((item) => stampReceivedAt(item, now))
        : [];
      return {
        pendingRequests: items,
        isProcessing: Boolean(event.isProcessing),
      };
    }

    case 'permission_request': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      // 没有 requestId 就答不了，收下只会变成一个永远无法回应的按钮。
      if (!event.requestId) {
        return state;
      }
      // 同一 requestId 重复到达（重连重放）不追加第二条。
      if (state.pendingRequests.some((request) => request.requestId === event.requestId)) {
        return state;
      }
      const request: PendingPermissionRequest = {
        requestId: event.requestId,
        toolName: event.toolName || 'UnknownTool',
        input: event.input,
        context: event.context,
        sessionId,
        receivedAt: now,
      };
      return {
        pendingRequests: [...state.pendingRequests, request],
        isProcessing: true,
      };
    }

    case 'permission_cancelled': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      if (!state.pendingRequests.some((request) => request.requestId === event.requestId)) {
        return state;
      }
      return {
        pendingRequests: state.pendingRequests.filter((request) => request.requestId !== event.requestId),
        isProcessing: state.isProcessing,
      };
    }

    case 'complete': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      // 本轮结束了，等待也就结束了。后端在正常路径上还会发 `permission_cancelled`，
      // 这里是丢帧时的兜底：否则面板会永远挂着一个答不了的回执按钮。
      return {
        pendingRequests: [],
        isProcessing: false,
      };
    }

    case 'other':
    default:
      return state;
  }
}
