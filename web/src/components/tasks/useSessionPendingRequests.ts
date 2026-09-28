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
      };
    case 'permission_cancelled':
      return {
        kind: 'permission_cancelled',
        sessionId: event.sessionId,
        requestId: event.requestId as string | undefined,
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
 * 不重放历史（`lastSeq: 0`）：ack 里的 `pendingPermissions` 是全量快照，够用；
 * 回放会把整个对话灌进来，而这里一个字都不显示。
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

  // 切会话立刻抹掉上一个会话的待办：否则新面板会挂着一个属于别人的按钮。
  useEffect(() => {
    setState(EMPTY_PENDING_STATE);
  }, [sessionId]);

  useEffect(() => {
    return subscribe((event: ServerEvent) => {
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
  }, [subscribe]);

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
      setState((previous) => ({
        pendingRequests: previous.pendingRequests.filter((request) => request.requestId !== requestId),
        isProcessing: previous.isProcessing,
      }));
    },
    [sendMessage],
  );

  return {
    pendingRequests: state.pendingRequests,
    isProcessing: state.isProcessing,
    respond,
  };
}
