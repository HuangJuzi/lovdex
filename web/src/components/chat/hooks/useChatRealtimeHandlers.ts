import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import type { WorkflowEvent } from '../tools/workflowState';

import { useWorkflowState } from './useWorkflowState';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

const WORKFLOW_KINDS = ['task_started', 'task_progress', 'tool_progress', 'task_notification', 'background_tasks_changed'] as const;
const isWorkflowEventKind = (k: unknown): boolean => typeof k === 'string' && (WORKFLOW_KINDS as readonly string[]).includes(k);

/**
 * How often (ms) accumulated stream deltas are flushed to the store during a
 * live response. This throttles UI re-renders / merge-sorts, NOT text capture:
 * every delta is unconditionally appended to `accumulatedStreamRef`, and each
 * flush replaces the streaming row with the full accumulated text, so no
 * characters are ever dropped regardless of this value. `stream_end` /
 * `complete` always flush the tail. Higher = fewer merges/sec (cheaper on long
 * sessions), at the cost of slightly chunkier text reveal. 120ms ≈ 8 flushes/s,
 * still visually smooth.
 */
const STREAM_FLUSH_INTERVAL_MS = 120;

interface UseChatRealtimeHandlersArgs {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamTimerRef: MutableRefObject<number | null>;
  /**
   * Per-session accumulated stream text, keyed by app session id. The active
   * session's deltas land here too, so a single flush path serves every
   * streaming session and non-active ones collapse into one streaming row
   * instead of appending one row per 24-char delta chunk (which rendered a
   * chunked reply as dozens of duplicate-looking bubbles).
   */
  accumulatedStreamRef: MutableRefObject<Map<string, string>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  // Dispatches Workflow SDK edge/level events into the session store's
  // per-tool-use progress tree. The store is per-instance (not a singleton),
  // so this hook takes the same sessionStore instance that owns the messages.
  const { dispatch: workflowStateDispatch } = useWorkflowState(sessionStore);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      // Workflow SDK events are edge/level signals that never render as
      // standalone chat messages — they feed the Workflow card's progress tree
      // via the store. Handle them here so both switches below never see them.
      const k = msg.kind;
      if (isWorkflowEventKind(k)) {
        workflowStateDispatch((msg as { toolUseId?: string | null }).toolUseId ?? null, msg as unknown as WorkflowEvent);
        return;
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        // Cross-session lifecycle signal fanned out by the run registry to
        // EVERY client (not just the one that sent chat.send). Lets a viewer
        // in session A see session B start/finish/fail/abort: the processing
        // map (sidebar spinner) flips on `running` and off on terminal states.
        case 'session_status': {
          if (!sid) return;
          if (msg.state === 'running') {
            onSessionProcessing?.(sid);
          } else {
            onSessionIdle?.(sid);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              // Simplified edition: notification sound removed.
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer per session for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text) return;
        if (!sid) return;
        const buffers = accumulatedStreamRef.current;
        buffers.set(sid, (buffers.get(sid) ?? '') + text);
        if (!streamTimerRef.current) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            // Flush every buffered session — including ones streaming in the
            // background. updateStreaming is keyed by `__streaming_<sessionId>`
            // so each session collapses into exactly one row.
            for (const [sessionId, accumulatedText] of buffers) {
              sessionStore.updateStreaming(sessionId, accumulatedText, provider);
            }
          }, STREAM_FLUSH_INTERVAL_MS);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        if (sid) {
          const accumulatedText = accumulatedStreamRef.current.get(sid);
          if (accumulatedText) {
            sessionStore.updateStreaming(sid, accumulatedText, provider);
          }
          accumulatedStreamRef.current.delete(sid);
          sessionStore.finalizeStreaming(sid);
        }
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (streamTimerRef.current) {
            clearTimeout(streamTimerRef.current);
            streamTimerRef.current = null;
          }
          if (sid) {
            const accumulatedText = accumulatedStreamRef.current.get(sid);
            if (accumulatedText) {
              sessionStore.updateStreaming(sid, accumulatedText, provider);
              sessionStore.finalizeStreaming(sid);
            }
            accumulatedStreamRef.current.delete(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            // Simplified edition: title/sound notifications removed.
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void sessionStore.refreshFromServer(sid);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            // Simplified edition: notification sound removed.
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            setTokenBudget(msg.tokenBudget as Record<string, unknown>);
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    sessionStore,
    workflowStateDispatch,
  ]);
}
