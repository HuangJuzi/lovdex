/**
 * Shared SDK-event → writer-event normalizer for the remote agent path.
 *
 * The local server (`claude-sdk.js`) turns raw Claude Code SDK events into the
 * rich `NormalizedMessage` envelope consumed by the chat websocket. The remote
 * "remote-lite" path needs a *small*, transport-friendly normalizer that emits
 * the assistant / tool_use / complete / error events (plus a passthrough for
 * anything else) with stable field names so both producers agree on the shape.
 *
 * Field contract (must stay aligned with the live writer output):
 * - every event gets a unique `eventId`
 * - `providerSessionId` mirrors the SDK's `sessionId`
 * - assistant events carry `role`, `content` (the message content array), `model`
 * - terminal events use `type: 'complete'` with `done: true`
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
  const base = { ...extra, eventId: createEventId() };

  if (sdkEvent.type === 'assistant') {
    const message = (sdkEvent.message ?? {}) as AnyRecord;
    return {
      ...base,
      type: 'assistant',
      providerSessionId: sdkEvent.sessionId,
      role: 'assistant',
      content: (message.content ?? []) as unknown[],
      model: message.model ?? undefined,
    };
  }

  if (sdkEvent.type === 'result') {
    return { ...base, type: 'complete', providerSessionId: sdkEvent.sessionId, done: true };
  }

  if (sdkEvent.type === 'tool_use') {
    return {
      ...base,
      type: 'tool_use',
      providerSessionId: sdkEvent.sessionId,
      toolUseId: sdkEvent.toolUseId,
      name: sdkEvent.name,
      input: sdkEvent.input ?? {},
    };
  }

  if (sdkEvent.type === 'error') {
    return { ...base, type: 'error', providerSessionId: sdkEvent.sessionId, error: sdkEvent.error };
  }

  // Passthrough: unknown event types keep their fields and type, gain an eventId.
  return { ...base, ...sdkEvent, type: sdkEvent.type as string, eventId: base.eventId };
}

export function terminalCompleteEvent(
  providerSessionId: string,
  extra: AnyRecord = {},
): AnyRecord {
  return { ...extra, type: 'complete', eventId: createEventId(), providerSessionId, done: true };
}
