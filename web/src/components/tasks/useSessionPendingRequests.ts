import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket, type ServerEvent } from '../../contexts/WebSocketContext';
import type { PendingPermissionRequest } from '../chat/types/types';

import {
  EMPTY_PENDING_STATE,
  applyPendingEvent,
  type PendingRequestsEvent,
  type PendingRequestsState,
} from './pendingRequestEvents';

export interface PendingDecision {
  allow?: boolean;
  message?: string;
  rememberEntry?: string | null;
  updatedInput?: unknown;
}

export interface UseSessionPendingRequestsResult {
  pendingRequests: PendingPermissionRequest[];
  isProcessing: boolean;
  respond: (requestId: string, decision: PendingDecision) => void;
}

/**
 * 把一帧 `ServerEvent` 折成 reducer 认识的 `PendingRequestsEvent`。
 *
 * 不认识的 kind 一律落到 `'other'` —— reducer 会原样返回同一引用，不触发渲染。
 * 这正是「网关将来加帧类型时，本钩子不会瞎认」的边界。
 */
function toPendingEvent(event: ServerEvent): PendingRequestsEvent {
  switch (event.kind) {
    case 'chat_subscribed':
      return {
        kind: 'chat_subscribed',
        sessionId: event.sessionId,
        isProcessing: event.isProcessing as boolean | undefined,
        lastSeq: event.lastSeq as number | undefined,
        pendingPermissions: event.pendingPermissions,
      };
    case 'permission_request':
      return {
        kind: 'permission_request',
        sessionId: event.sessionId,
        requestId: event.requestId as string | undefined,
        toolName: event.toolName as string | undefined,
        input: event.input,
        context: event.context,
        seq: event.seq,
      };
    case 'permission_cancelled':
      return {
        kind: 'permission_cancelled',
        sessionId: event.sessionId,
        requestId: event.requestId as string | undefined,
        seq: event.seq,
      };
    case 'complete':
      return { kind: 'complete', sessionId: event.sessionId };
    default:
      return { kind: 'other' };
  }
}

/**
 * 订阅**一个会话**的待办工具审批。
 *
 * 与聊天页的区别：那边是自己发起对话、只关心正被查看的会话；这里是一块
 * 「任务详情」面板，挂在后台运行的任务会话上。两者用同一个共享 socket，
 * 各自 `chat.subscribe`，所以可以并存。
 *
 * `lastSeq: 0` 不是「不回放」的开关 —— 后端对首次订阅照样把整个 run 缓冲区
 * 重放回来（`readReplayStart` 返回 `Math.max(clientLastSeq, -1)`）。真正挡住
 * 重放里那些已答待办的是 `snapshotSeq` 水线，见 `pendingRequestEvents.ts`。
 * 这里给 0 只是声明「我不要历史」；反正本面板一个字的历史都不渲染。
 */
export function useSessionPendingRequests(
  sessionId: string | null | undefined,
): UseSessionPendingRequestsResult {
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  const [state, setState] = useState<PendingRequestsState>(EMPTY_PENDING_STATE);

  /**
   * socket 回调是异步的，闭包里的 `sessionId` 会过期 —— 切了会话之后旧的监听器
   * 还会拿老 id 去比。ref 每次渲染都重指，监听器读 ref 拿到的永远是最新的那个。
   */
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  sessionIdRef.current = sessionId ?? null;

  /**
   * 「上次为哪个会话的哪次 run 补过订阅」。见 `session_status` 分支的注释：
   * 只在**状态发生变化**时补订阅，否则会和补订阅引发的 `chat_subscribed` 互相
   * 触发成死循环。
   */
  const lastStatusRef = useRef<{ sessionId: string; state: string } | null>(null);

  // 切会话立刻抹掉上一个会话的待办：否则新面板会挂着一个属于别人的按钮。
  useEffect(() => {
    setState(EMPTY_PENDING_STATE);
    lastStatusRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    return subscribe((event: ServerEvent) => {
      // 会话在**空闲时**被订阅、之后才起跑：`attachConnection` 只发生在
      // `handleChatSubscribe` 里（那时还没 run），而 `startRun` 只把发起方那条
      // 连接放进 writer 的 socket 集合。于是本 socket 收不到任何
      // `permission_request`，面板永远是空的，直到下次重连。
      //
      // `session_status` 是广播给**所有**已连接客户端的（registry 的
      // `broadcastSessionStatus` → `connectedClients.forEach`），所以拿它当
      // 「该重新订阅了」的可靠信号：此刻再订阅一次就会命中 `isProcessing: true`
      // → `attachConnection`，从而接上这一轮的实时帧。
      //
      // 看着像多余的「我们不是已经订阅过了吗」—— 不知道 attach 只在订阅时发生
      // 的人一定会想删掉它。别删：删了就是后台任务的审批弹不出来。
      if (event.kind === 'session_status') {
        const statusSessionId = event.sessionId;
        if (!statusSessionId || statusSessionId !== sessionIdRef.current) {
          return;
        }
        const status = String(event.state ?? '');
        const previous = lastStatusRef.current;
        // 只在**迁移进** running 的那一帧补订阅：同一轮里重复到达的 running 帧
        // （或 StrictMode 下的重复派发）会白白多订阅一次，而每次订阅都会换来一段
        // 重放。状态没变就跳过。
        const alreadyRunning =
          previous !== null && previous.sessionId === statusSessionId && previous.state === status;
        lastStatusRef.current = { sessionId: statusSessionId, state: status };
        if (status !== 'running' || alreadyRunning || !isConnected) {
          return;
        }
        sendMessage({
          type: 'chat.subscribe',
          sessions: [{ sessionId: statusSessionId, lastSeq: 0 }],
        });
        return;
      }

      const pendingEvent = toPendingEvent(event);
      if (pendingEvent.kind === 'other') {
        // 快路径：绝大多数帧与本面板无关，连 setState 都不进。
        return;
      }
      setState((previous) => {
        const next = applyPendingEvent(previous, pendingEvent, sessionIdRef.current);
        // reducer 用「同一引用」表示无变化，这里把它变成 React 的 bail-out。
        return next === previous ? previous : next;
      });
    });
  }, [subscribe, sendMessage, isConnected]);

  // 选中会话且 socket 已连上才订阅。依赖 isConnected 是刻意的：每次重连都要
  // 重新订阅一遍（旧连接的订阅随连接一起没了），否则断线重连后待办永远不刷新。
  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{ sessionId, lastSeq: 0 }],
    });
  }, [sessionId, isConnected, sendMessage]);

  const respond = useCallback(
    (requestId: string, decision: PendingDecision) => {
      if (!requestId) {
        return;
      }
      // 字段名与聊天页 `handlePermissionDecision` 逐字一致 —— 后端
      // `handlePermissionResponse` 认的就是这几个名字。
      sendMessage({
        type: 'chat.permission-response',
        requestId,
        allow: Boolean(decision.allow),
        updatedInput: decision.updatedInput,
        message: decision.message,
        rememberEntry: decision.rememberEntry,
      });
      // 乐观移除：决定已发出，按钮不该再等一个来回才消失。后端若判失败会经
      // `permission_cancelled` / 重订阅的 ack 纠正回来。
      setState((previous) => {
        const next = previous.pendingRequests.filter((request) => request.requestId !== requestId);
        // 没移掉任何东西就别造新对象：setState 拿到同一引用时 React 直接跳过
        // 这次渲染（与 reducer 的引用纪律一致）。
        return next.length === previous.pendingRequests.length ? previous : { ...previous, pendingRequests: next };
      });
    },
    [sendMessage],
  );

  return {
    pendingRequests: state.pendingRequests,
    isProcessing: state.isProcessing,
    respond,
  };
}
