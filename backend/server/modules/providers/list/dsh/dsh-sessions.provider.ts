import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appConfig } from '@/modules/config/config.js';
import { sessionsDb } from '@/modules/database/index.js';
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
import {
  decodeDshSessionLog,
  findDshSessionLogFile,
  parseDshSessionRecords,
} from '@/modules/providers/list/dsh/dsh-session-log.js';

const PROVIDER = 'dsh';

/** The shared "nothing to show" page every provider returns on a missing log. */
const EMPTY_HISTORY: FetchHistoryResult = {
  messages: [],
  total: 0,
  hasMore: false,
  offset: 0,
  limit: null,
};

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

// ---------------------------------------------------------------------------
// Session-log (disk) history decoding
// ---------------------------------------------------------------------------

/**
 * Joins the `text` parts of a dsh content block array into display text.
 *
 * dsh content blocks are `{ type: 'text', text }` (every tool/result observed
 * on real logs uses text blocks); a bare string is tolerated, and anything
 * else stringifies so the user still sees something.
 */
function joinDshContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? '' : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    const record = readObjectRecord(block);
    if (record && typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('\n');
}

/**
 * Parses a dsh tool-call `arguments` value into the normalized `toolInput`.
 *
 * dsh stores arguments as a JSON string; unparsable strings are kept verbatim
 * (the live ACP path forwards `rawInput` objects, and history should not
 * silently drop what cannot be decoded).
 */
function parseDshToolArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== 'string') {
    return argumentsValue ?? {};
  }
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return argumentsValue;
  }
}

/** Stable per-read message ids so repeated history fetches keep React keys. */
function historyMessageId(providerSessionId: string, seq: unknown, part: string): string {
  return `dsh_${providerSessionId}_${typeof seq === 'number' ? seq : 'x'}_${part}`;
}

/** Record timestamp → ISO string (dsh records carry epoch-ms `time`). */
function dshRecordTimestamp(record: Record<string, unknown>): string {
  const time = record.time;
  return typeof time === 'number' && Number.isFinite(time)
    ? new Date(time).toISOString()
    : new Date().toISOString();
}

type DshToolResultInfo = { content: string; isError: boolean };

export class DshSessionsProvider implements IProviderSessions {
  /**
   * Sessions root override (tests). Production resolves it per fetch from
   * config so a `dshHome` change applies without restarting the provider
   * registry: `$DSH_HOME || ~/.dsh` + `/sessions`, exactly where `dsh`
   * itself persists (`providers.dsh.dshHome` wins when set, mirroring the
   * env the runner hands the child).
   */
  private readonly sessionsRootOverride: string | null;

  constructor(options: { sessionsRoot?: string } = {}) {
    this.sessionsRootOverride = options.sessionsRoot?.trim() || null;
  }

  private resolveSessionsRoot(): string {
    if (this.sessionsRootOverride) {
      return this.sessionsRootOverride;
    }
    const configuredHome = appConfig().get().providers.dsh.dshHome?.trim();
    const home = configuredHome || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    return path.join(home, 'sessions');
  }

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

  /**
   * Replays one persisted dsh session from its on-disk log.
   *
   * History is read from `<dsh home>/sessions/<munged cwd>/<session id>/session.vN.jsonl.zstd`
   * (or the plain `.jsonl` a `compression: none` deployment writes), NOT over
   * ACP: the design doc originally planned `session/list` + `session/resume`,
   * but a live probe showed a resume replays zero `session/update`
   * notifications, so the protocol route cannot serve history at all. The log
   * is a sequence of independent zstd frames decoded frame-by-frame (see
   * `dsh-session-log.ts`).
   *
   * Record mapping (v4 log):
   * - `user/message` (source `user`)          → `text` role user
   * - `user/message` (source `runtime-context`) → skipped (injected env text)
   * - `assistant/message` content `reasoning` → `thinking`
   * - `assistant/message` content `text`      → `text` role assistant
   * - `assistant/message` content `tool-call` → `tool_use` (the standalone
   *   `tool/call` record duplicates these and is only used as a fallback for
   *   calls with no embedded counterpart)
   * - `tool/result`                           → `tool_result` + attached onto
   *   the paired `tool_use.toolResult` (claude/qoder contract)
   *
   * On a successful read the session row's empty `summary` (from the log's
   * `session/title`) and `jsonl_path` are backfilled; a user rename
   * (`custom_name`) is never touched.
   */
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    let filePath: string | null;
    let records: Array<Record<string, unknown>>;
    try {
      filePath = await findDshSessionLogFile(
        this.resolveSessionsRoot(),
        options.projectPath,
        providerSessionId,
      );
      if (!filePath) {
        return { ...EMPTY_HISTORY };
      }
      records = parseDshSessionRecords(decodeDshSessionLog(await fsp.readFile(filePath)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DshProvider] Failed to load session ${sessionId}:`, message);
      return { ...EMPTY_HISTORY };
    }

    if (records.length === 0) {
      return { ...EMPTY_HISTORY };
    }

    // Pair tool results onto their tool_use before normalizing (qoder contract:
    // the frontend renders the result inside the tool card).
    const toolResults = new Map<string, DshToolResultInfo>();
    for (const record of records) {
      if (record.type !== 'tool/result') {
        continue;
      }
      const data = readObjectRecord(record.data);
      const resultMessage = data ? readObjectRecord(data.message) : null;
      const toolCallId = resultMessage
        ? (typeof resultMessage.toolCallId === 'string' ? resultMessage.toolCallId : null)
        : null;
      if (toolCallId) {
        toolResults.set(toolCallId, {
          content: joinDshContentText(resultMessage?.content),
          isError: Boolean(resultMessage?.isError),
        });
      }
    }

    const normalized: NormalizedMessage[] = [];
    const emittedToolCalls = new Set<string>();

    const emitToolUse = (
      toolCallId: string | undefined,
      name: unknown,
      argumentsValue: unknown,
      record: Record<string, unknown>,
      part: string,
    ): void => {
      const id = typeof toolCallId === 'string' && toolCallId ? toolCallId : `nocall_${part}`;
      if (emittedToolCalls.has(id)) {
        return;
      }
      emittedToolCalls.add(id);
      const message = createNormalizedMessage({
        id: historyMessageId(providerSessionId, record.seq, part),
        kind: 'tool_use',
        toolName: typeof name === 'string' && name ? name : 'tool',
        toolInput: parseDshToolArguments(argumentsValue),
        toolId: typeof toolCallId === 'string' && toolCallId ? toolCallId : undefined,
        sessionId,
        timestamp: dshRecordTimestamp(record),
        provider: PROVIDER,
      });
      const paired = toolCallId ? toolResults.get(toolCallId) : undefined;
      if (paired) {
        message.toolResult = { content: paired.content, isError: paired.isError };
      }
      normalized.push(message);
    };

    for (const record of records) {
      const data = readObjectRecord(record.data);
      if (!data) {
        continue;
      }

      if (record.type === 'user/message') {
        const source = readObjectRecord(data.source);
        // runtime-context snapshots are dsh-injected environment text, not a
        // human turn — replaying them would bury the conversation in noise.
        if (source?.kind === 'runtime-context') {
          continue;
        }
        const text = joinDshContentText(data.content);
        if (!text) {
          continue;
        }
        normalized.push(createNormalizedMessage({
          id: historyMessageId(providerSessionId, record.seq, 'u'),
          kind: 'text',
          role: 'user',
          content: text,
          sessionId,
          timestamp: dshRecordTimestamp(record),
          provider: PROVIDER,
        }));
        continue;
      }

      if (record.type === 'assistant/message') {
        const message = readObjectRecord(data.message);
        const content = message?.content;
        const blocks = Array.isArray(content) ? content : null;
        if (blocks) {
          let partIndex = 0;
          for (const block of blocks) {
            const blockRecord = readObjectRecord(block);
            const blockType = blockRecord?.type;
            if (blockType === 'reasoning' && typeof blockRecord?.text === 'string' && blockRecord.text) {
              normalized.push(createNormalizedMessage({
                id: historyMessageId(providerSessionId, record.seq, `a${partIndex}`),
                kind: 'thinking',
                content: blockRecord.text,
                sessionId,
                timestamp: dshRecordTimestamp(record),
                provider: PROVIDER,
              }));
            } else if (blockType === 'text' && typeof blockRecord?.text === 'string' && blockRecord.text) {
              normalized.push(createNormalizedMessage({
                id: historyMessageId(providerSessionId, record.seq, `a${partIndex}`),
                kind: 'text',
                role: 'assistant',
                content: blockRecord.text,
                sessionId,
                timestamp: dshRecordTimestamp(record),
                provider: PROVIDER,
              }));
            } else if (blockType === 'tool-call') {
              emitToolUse(
                typeof blockRecord?.id === 'string' ? blockRecord.id : undefined,
                blockRecord?.name,
                blockRecord?.arguments,
                record,
                `a${partIndex}`,
              );
            }
            partIndex += 1;
          }
        } else {
          const text = joinDshContentText(content);
          if (text) {
            normalized.push(createNormalizedMessage({
              id: historyMessageId(providerSessionId, record.seq, 'a'),
              kind: 'text',
              role: 'assistant',
              content: text,
              sessionId,
              timestamp: dshRecordTimestamp(record),
              provider: PROVIDER,
            }));
          }
        }
        continue;
      }

      if (record.type === 'tool/call') {
        // Standalone tool/call records duplicate the tool-call blocks embedded
        // in assistant/message; only calls never seen embedded are emitted.
        emitToolUse(
          typeof data.callId === 'string' ? data.callId : undefined,
          data.name,
          data.arguments,
          record,
          `c${records.indexOf(record)}`,
        );
        continue;
      }

      if (record.type === 'tool/result') {
        const resultMessage = readObjectRecord(data.message);
        const toolCallId = typeof resultMessage?.toolCallId === 'string' ? resultMessage.toolCallId : undefined;
        const paired = toolCallId ? toolResults.get(toolCallId) : undefined;
        if (!paired) {
          continue;
        }
        normalized.push(createNormalizedMessage({
          id: historyMessageId(providerSessionId, record.seq, 'r'),
          kind: 'tool_result',
          toolId: toolCallId,
          content: paired.content,
          isError: paired.isError,
          sessionId,
          timestamp: dshRecordTimestamp(record),
          provider: PROVIDER,
        }));
      }
    }

    this.backfillSessionMetadata(sessionId, filePath, records);

    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }

  /**
   * Best-effort metadata backfill after a successful history read.
   *
   * dsh rows are created by the app gateway with NULL summary/jsonl_path (the
   * dsh synchronizer deliberately scans nothing), so the first history read is
   * the natural moment to fill both: the sidebar gets a readable title from
   * the log's `session/title`, and future reads could shortcut via
   * `jsonl_path`. `custom_name` (a user rename) is never touched, and an
   * existing summary is preserved.
   */
  private backfillSessionMetadata(
    sessionId: string,
    filePath: string,
    records: Array<Record<string, unknown>>,
  ): void {
    try {
      const row = sessionsDb.getSessionById(sessionId);
      if (!row) {
        return;
      }
      if (!row.jsonl_path) {
        sessionsDb.updateSessionJsonlPath(sessionId, filePath);
      }
      if (!row.summary) {
        const titleRecord = records.find((record) => record.type === 'session/title');
        const titleData = titleRecord ? readObjectRecord(titleRecord.data) : null;
        const title = typeof titleData?.title === 'string' ? titleData.title.trim() : '';
        if (title) {
          sessionsDb.updateSessionSummary(sessionId, title);
        }
      }
    } catch (error) {
      // A metadata backfill failure must not fail the history read.
      console.warn('[DshProvider] session metadata backfill failed:', error instanceof Error ? error.message : error);
    }
  }
}
