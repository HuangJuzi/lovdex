/**
 * 把一个 socket 帧折算进「本会话待办审批」状态的**纯函数**。
 *
 * 为什么独立成文件：这个仓库的前端测试是 `node:test` **无 jsdom**，钩子本体
 * 测不到。把折叠逻辑挤出来，语义（去重、跨会话过滤、重放水线、丢帧兜底）才
 * 测得到 —— 与 `panelPermission.ts` / `panelReply.ts` 同一分工。
 *
 * 线上契约（都在后端，别凭记忆改）：
 *  - 每个出站帧的 `sessionId` 都是**应用会话 id**：registry 构造出站事件时统一
 *    覆写 `sessionId: run.appSessionId`（`chat-run-registry.service.ts` 的
 *    `decorateAndRecordEvent`，经 `ChatSessionWriter` 发出），所以直接用任务/
 *    会话的 `session_id` 比就是对的。
 *  - `chat_subscribed`（`handleChatSubscribe`）带 `isProcessing`、`lastSeq` 与
 *    `pendingPermissions` 全量快照；`permission_request` / `permission_cancelled`
 *    是运行中的增量帧。
 *  - **ack 之后还会跟着整段重放，`lastSeq: 0` 拦不住它**：`handleChatSubscribe`
 *    在运行中时先 `attachConnection` 再 `replayEvents`，起点由 `readReplayStart`
 *    算，对**首次**订阅返回 `Math.max(clientLastSeq, -1)` —— 客户端发什么
 *    `lastSeq` 都没用。这是 `snapshotSeq` 水线存在的唯一理由。
 */

import type { PendingPermissionRequest } from '../chat/types/types';

export interface PendingRequestsState {
  pendingRequests: PendingPermissionRequest[];
  isProcessing: boolean;
  /**
   * 最近一次 `chat_subscribed` 的 `lastSeq`，即快照的**权威水线**：
   * `seq <= snapshotSeq` 的增量帧必然来自 ack 之后的重放，不是新状态。
   */
  snapshotSeq: number;
}

export type PendingRequestsEvent =
  | { kind: 'chat_subscribed'; sessionId?: string; isProcessing?: boolean; lastSeq?: number; pendingPermissions?: unknown }
  | { kind: 'permission_request'; sessionId?: string; requestId?: string; toolName?: string; input?: unknown; context?: unknown; seq?: number }
  | { kind: 'permission_cancelled'; sessionId?: string; requestId?: string; seq?: number }
  | { kind: 'complete'; sessionId?: string }
  | { kind: 'other' };

export const EMPTY_PENDING_STATE: PendingRequestsState = {
  pendingRequests: [],
  isProcessing: false,
  // 不是 0：`run.lastSeq` 从 0 起递增，**实时**帧的 seq 从 1 开始，用 0 会把
  // 首订阅（还没拿到 ack）之后的头几帧真事件当成重放丢掉。水线只该拦已知范围，
  // 未知时宁可不拦。
  snapshotSeq: -1,
};

export interface ApplyPendingEventOptions {
  /** 可注入的「现在」，缺省取真实时间；测试用它钉住打的点。 */
  now?: Date;
}

/**
 * 这一帧是不是 ack 之前就已经发生过、被 `replayEvents` 重放回来的旧事件？
 *
 * 不拦的后果不是「多显示一条」那么轻：答复一条审批**不会**发
 * `permission_cancelled`（`claude-sdk.js` 的 resolve 路径只
 * `pendingToolApprovals.delete(requestId)`，`permission_cancelled` 只走
 * timeout/abort 的 `onCancel`），所以已答的 `permission_request` 仍躺在 run
 * 的事件缓冲区里，重放会把它当成一条新待办加回来 —— 还带着新打的 `receivedAt`，
 * 于是倒计时也是全新的。点它则毫无反应：`resolveToolApproval` 对未知 requestId
 * 静默忽略。
 *
 * 这道判断看着像可以「简化」掉的冗余检查，别删：没有它，面板在每次刷新/重订阅后
 * 都会长出一条点了没反应的幽灵待办。
 *
 * 没有 `seq` 的帧一律放行：不是所有 provider 都盖 seq，把「没盖」当成「旧」会
 * 静默吞掉实时帧 —— 那是比幽灵按钮更糟的故障。
 */
function isReplayed(event: { seq?: number }, state: PendingRequestsState): boolean {
  return typeof event.seq === 'number' && event.seq <= state.snapshotSeq;
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

/** `lastSeq` 只有是有限数时才可信；缺失/脏值一律当 -1（= 不拦）。 */
function readSnapshotSeq(lastSeq: unknown): number {
  return typeof lastSeq === 'number' && Number.isFinite(lastSeq) ? lastSeq : -1;
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
        snapshotSeq: readSnapshotSeq(event.lastSeq),
      };
    }

    case 'permission_request': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      if (isReplayed(event, state)) {
        return state;
      }
      // 没有 requestId 就答不了，收下只会变成一个永远无法回应的按钮。
      if (!event.requestId) {
        return state;
      }
      // 同一 requestId 重复到达（重放或重订阅）不追加第二条。
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
        snapshotSeq: state.snapshotSeq,
      };
    }

    case 'permission_cancelled': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      if (isReplayed(event, state)) {
        return state;
      }
      if (!state.pendingRequests.some((request) => request.requestId === event.requestId)) {
        return state;
      }
      return {
        pendingRequests: state.pendingRequests.filter((request) => request.requestId !== event.requestId),
        isProcessing: state.isProcessing,
        snapshotSeq: state.snapshotSeq,
      };
    }

    case 'complete': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      // 本轮结束了，等待也就结束了。后端在正常路径上还会发 `permission_cancelled`，
      // 这里是丢帧时的兜底：否则面板会永远挂着一个答不了的回执按钮。
      //
      // 水线同时归零：run 结束意味着下一轮的 seq 从 1 重新数（`readReplayStart`
      // 也只在同一个 run 内比较）。不清掉的话，若下一轮开始时漏掉了重新订阅
      // （重连抖动、transition 判定失效），新 run 的实时帧会全部落在旧水线以下被
      // 静默丢掉 —— 那是「任务在等审批，面板却什么都不显示」。水线宁可失效放行，
      // 也不要误杀；何况此时待办本就被清空，没有可复活的幽灵。
      return {
        pendingRequests: [],
        isProcessing: false,
        snapshotSeq: -1,
      };
    }

    case 'other':
    default:
      return state;
  }
}
