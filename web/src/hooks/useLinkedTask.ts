import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../contexts/WebSocketContext';
import { api } from '../utils/api';
import type { Task } from '../types/app';

type LinkedTaskEvent =
  | { kind: 'task_upserted'; task: Task }
  | { kind: 'websocket_reconnected' }
  | { kind?: string };

/**
 * Whether a realtime frame should replace the cached linked task for the given
 * session. Pure so it can be unit-tested without a React renderer.
 */
export function shouldApplyUpsert(
  event: { kind?: string; task?: Task | null },
  sessionId: string | null,
): boolean {
  if (event.kind !== 'task_upserted' || !event.task) return false;
  if (!sessionId) return false;
  return event.task.session_id === sessionId;
}

/**
 * Reverse-lookup the task (if any) linked to a session, and keep it fresh via
 * `task_upserted` / `websocket_reconnected`. A session that isn't linked to any
 * task returns `{ task: null }` (the normal case for an ad-hoc chat) — the 404
 * is expected and silenced.
 */
export function useLinkedTask(sessionId: string | null | undefined): { task: Task | null } {
  const { subscribe } = useWebSocket();
  const [task, setTask] = useState<Task | null>(null);
  const mounted = useRef(true);
  const reqSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback((sid: string) => {
    const seq = ++reqSeq.current;
    api
      .tasks
      .bySession(sid)
      .then(async (res) => {
        if (seq !== reqSeq.current || !mounted.current) return;
        if (!res.ok) {
          setTask(null);
          return;
        }
        const body = (await res.json()) as { task?: Task };
        if (seq !== reqSeq.current || !mounted.current) return;
        setTask(body.task ?? null);
      })
      .catch(() => {
        if (seq === reqSeq.current && mounted.current) setTask(null);
      });
  }, []);

  // Initial / on-session-change fetch. Clear first so switching from a
  // task-linked session to a plain one doesn't briefly leave the previous
  // task's button pointing at the wrong task while the 404 resolves.
  useEffect(() => {
    setTask(null);
    if (!sessionId) return;
    refetch(sessionId);
  }, [sessionId, refetch]);

  // Live updates + reconnect replay.
  useEffect(() => {
    if (!subscribe || !sessionId) return;
    return subscribe((event) => {
      const e = event as unknown as LinkedTaskEvent;
      if (shouldApplyUpsert(e, sessionId)) {
        setTask((e as { task: Task }).task);
      } else if (e.kind === 'websocket_reconnected') {
        refetch(sessionId);
      }
    });
  }, [subscribe, sessionId, refetch]);

  return { task };
}
