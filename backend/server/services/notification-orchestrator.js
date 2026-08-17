// Notification orchestrator.
//
// The chat runtimes (claude-sdk.js, openai-codex.js) call into this module when
// a provider raises an in-band signal that the user should know about — e.g.
// Claude's `Notification` / `Stop` / `SessionEnd` hooks, or a tool that needs
// approval. The orchestrator turns each into a single `notification`
// NormalizedMessage and dispatches it on the run's writer so the connected
// client can surface a toast/badge.
//
// This is the SAME-SESSION, in-band channel. Cross-session "session B
// finished" signalling is handled by `chatRunRegistry.broadcastSessionStatus`
// (`kind: 'session_status'`), which fans out to every client regardless of
// which run they are viewing. The two are complementary:
//   - `session_status`  → lifecycle (running/completed/failed/aborted), cross-session
//   - `notification`    → agent-raised attention events, same-session
//
// `notifyRunFailed` / `notifyRunStopped` remain no-ops: push/web delivery was
// removed, and the registry's `session_status` broadcast already covers the
// cross-session "run ended" signal. They are kept as call sites so the runtimes
// stay unchanged.

import { createNormalizedMessage } from '../shared/utils.js';

const DEDUPE_TTL_MS = 5 * 60 * 1000;
const seenDedupeKeys = new Map();

function shouldDispatch(dedupeKey) {
  if (!dedupeKey) {
    return true;
  }
  const now = Date.now();
  // Sweep expired entries on every call to keep the set bounded.
  for (const [key, at] of seenDedupeKeys) {
    if (now - at > DEDUPE_TTL_MS) {
      seenDedupeKeys.delete(key);
    }
  }
  if (seenDedupeKeys.has(dedupeKey)) {
    return false;
  }
  seenDedupeKeys.set(dedupeKey, now);
  return true;
}

export async function notifyRunFailed(_payload) {
  // no-op: cross-session failure is signalled via `session_status{state:'failed'}`.
}

export async function notifyRunStopped(_payload) {
  // no-op: cross-session completion is signalled via `session_status{state:'completed'}`.
}

/**
 * Dispatches a `notification` frame on the run's writer (the ChatSessionWriter
 * passed in as `writer`). The writer remaps the session id, assigns a `seq`,
 * and forwards it to the attached client — so this reaches the client viewing
 * THIS session, not every client.
 */
export async function notifyUserIfEnabled(payload) {
  const { writer, event } = payload || {};
  if (!event || !writer || typeof writer.send !== 'function') {
    return;
  }
  if (!shouldDispatch(event.dedupeKey)) {
    return;
  }
  try {
    writer.send(event);
  } catch (error) {
    console.error('[Notifications] Failed to dispatch notification:', error?.message || error);
  }
}

/**
 * Builds a `notification` NormalizedMessage from the structured payload the
 * runtimes pass in. The fields are passed through verbatim so the frontend can
 * render severity / message / requiresUserAction without provider branching.
 */
export function createNotificationEvent(payload) {
  if (!payload) {
    return null;
  }
  const message = (payload.meta && (payload.meta.message || payload.meta.toolName)) || payload.message || '';
  return createNormalizedMessage({
    kind: 'notification',
    provider: payload.provider || 'claude',
    sessionId: payload.sessionId || null,
    notificationKind: payload.kind || 'info',
    code: payload.code || null,
    severity: payload.severity || 'info',
    message,
    meta: payload.meta || null,
    requiresUserAction: Boolean(payload.requiresUserAction),
    dedupeKey: payload.dedupeKey || null,
  });
}
