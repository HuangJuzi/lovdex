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
 * - every event gains a unique `eventId` (always forced LAST, so neither
 *   `sdkEvent` nor `extra` can clobber it, and it is fresh per call)
 * - passthrough events keep the SDK's snake-case `session_id`; only
 *   `terminalCompleteEvent` emits the camel-case `providerSessionId`
 * - `terminalCompleteEvent` synthesizes the terminal `complete` event for the
 *   remote loop end (carries `providerSessionId` + `done: true`)
 *
 * Main-side caveat: `type: 'complete'` is NOT an SDK event — the claude
 * `normalizeMessage` falls through to `[]` for unknown types, which would
 * silently DROP it. The remote-spawn path must special-case the synthesized
 * `complete` (e.g. map it to `createCompleteMessage`) BEFORE re-running
 * `transformMessage` + `normalizeMessage` on the passthrough events.
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
  // `extra` is spread AFTER `sdkEvent`, so a colliding key in `extra` overrides
  // the SDK field; only `eventId` is guaranteed fresh (forced last).
  return { ...sdkEvent, ...extra, eventId: createEventId() };
}

export function terminalCompleteEvent(
  providerSessionId: string,
  extra: AnyRecord = {},
): AnyRecord {
  return { ...extra, type: 'complete', eventId: createEventId(), providerSessionId, done: true };
}