import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'dsh';

/**
 * Reads the `update` object out of one ACP `session/update` notification.
 *
 * The ACP notification shape is `{ sessionId, update: { sessionUpdate, ... } }`.
 * Returns null for anything that is not a well-formed object so callers can
 * treat it as "nothing to render".
 */
function readAcpUpdate(raw: unknown): { sessionId: string | null; update: Record<string, unknown> } | null {
  const event = readObjectRecord(raw);
  if (!event) {
    return null;
  }
  const update = readObjectRecord(event.update);
  if (!update) {
    return null;
  }
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : null;
  return { sessionId, update };
}

/** Pulls plain text out of an ACP content block, tolerating a bare string. */
function readAcpText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  const block = readObjectRecord(content);
  if (block && typeof block.text === 'string') {
    return block.text;
  }
  return null;
}

export class DshSessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const parsed = readAcpUpdate(raw);
    if (!parsed) {
      return [];
    }
    const { update } = parsed;
    const resolvedSessionId = parsed.sessionId ?? sessionId ?? '';
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk') {
      const text = readAcpText(update.content);
      if (text === null) {
        return [];
      }
      return [createNormalizedMessage({
        kind: 'text',
        role: 'assistant',
        content: text,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    if (kind === 'agent_thought_chunk') {
      const text = readAcpText(update.content);
      if (text === null) {
        return [];
      }
      return [createNormalizedMessage({
        kind: 'thinking',
        content: text,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    if (kind === 'tool_call') {
      return [createNormalizedMessage({
        kind: 'tool_use',
        toolName: typeof update.title === 'string' ? update.title : 'tool',
        toolInput: update.rawInput,
        toolId: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    if (kind === 'tool_call_update') {
      // Terminal tool results arrive as a tool_call_update with status set;
      // only surface the ones that carry a rendered result.
      const status = typeof update.status === 'string' ? update.status : null;
      if (status !== 'completed' && status !== 'failed') {
        return [];
      }
      return [createNormalizedMessage({
        kind: 'tool_result',
        toolId: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
        // A result with no rawOutput is a real, renderable outcome ("the tool
        // returned nothing"), not a missing value: emit '' rather than
        // `undefined`. `undefined` here is what crashed the web renderer once
        // (JSON.stringify(undefined).trim()), and an empty result is honest.
        content: typeof update.rawOutput === 'string'
          ? update.rawOutput
          : update.rawOutput === undefined || update.rawOutput === null
            ? ''
            : JSON.stringify(update.rawOutput),
        isError: status === 'failed',
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    return [];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    // dsh history is read over ACP (session/list + session/resume) in the
    // synchronizer/service layer, not from disk (logs are zstd by default).
    // This method is intentionally a no-op returning the shared empty shape.
    void sessionId;
    const limit = options.limit ?? null;
    const offset = options.offset ?? 0;
    const empty: NormalizedMessage[] = [];
    const { page, hasMore } = sliceTailPage(empty, limit, offset);
    return { messages: page, total: 0, hasMore, offset, limit };
  }
}
