/**
 * Shared SDK-event → writer-event helper for the remote agent path.
 *
 * The browser-facing event shape is produced ON the main server: the local
 * path (`claude-sdk.js`) passes each raw SDK message through
 * `transformMessage` + `sessionsService.normalizeMessage('claude', ...)` to
 * build the heavy `NormalizedMessage` envelope. Remote parity therefore means
 * the remote-lite service forwards the RAW SDK event over the WS and main's
 * remote-spawn path runs the same `transformMessage` + `normalizeMessage`
 * pipeline before `writer.send`.
 *
 * Consequently `normalizeAgentEvent` is deliberately NON-destructive: it must
 * NOT remap/reshape fields (that would corrupt main's re-normalization). It
 * spreads the SDK event verbatim and only adds a unique `eventId`.
 *
 * Field contract:
 * - every event gains a unique `eventId`
 * - all original SDK fields (including `session_id`, `parent_tool_use_id`) are
 *   preserved untouched
 * - `terminalCompleteEvent` synthesizes the terminal `complete` event for the
 *   remote loop end (carries `providerSessionId` + `done: true`)
 */

type AnyRecord = Record<string, unknown>;

export function createEventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeAgentEvent(
  sdkEvent: AnyRecord,
  extra: AnyRecord = {},
): AnyRecord {
  return { ...sdkEvent, ...extra, eventId: createEventId() };
}

export function terminalCompleteEvent(
  providerSessionId: string,
  extra: AnyRecord = {},
): AnyRecord {
  return { ...extra, type: 'complete', eventId: createEventId(), providerSessionId, done: true };
}