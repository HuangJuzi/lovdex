/**
 * Codex run manager — remote-lite port of `backend/server/openai-codex.js`'s
 * `queryCodex`.
 *
 * The port contract (Task 12) changes only the sink and the run lifecycle:
 * - every message the local runner would `sendMessage(ws, x)` is pushed as
 *   `deps.push('session:<appSessionId>', { _remoteNorm: true, message: x })`
 *   with `message` shaped EXACTLY like the local normalized message (all
 *   `createNormalizedMessage` / `createCompleteMessage` envelopes come from
 *   `lite-normalize.ts`, which mirrors `shared/utils.ts`);
 * - the terminal marker `{ type: 'complete', exitCode }` (top-level `error`
 *   string on failure — see `makeCompleteMarker`) is pushed last so main's
 *   routing finish()es the run;
 * - `providerSessionId`/`cwd`/`env` come from `SessionStartParams` (configEnv
 *   merged OVER `process.env` — the SDK strips inherited env whenever `env` is
 *   set, so a bare configEnv would drop PATH);
 * - interrupts abort the SDK stream via the per-run AbortController.
 *
 * Approval surface: the pinned SDK (`@openai/codex-sdk@^0.144.0`) exposes no
 * `canUseTool`-style callback (and the local `queryCodex` has no approval
 * wiring either) — permissions are governed solely by `approvalPolicy`
 * (`untrusted`/`never`), so no interactive approval push is wired here.
 */
import { Codex } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk';

import type { RunManager, SessionStartParams } from '../agent-run.js';
import type { RunManagerDeps } from './registry.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  type LiteNormalizedMessage,
} from './lite-normalize.js';
import { buildRunEnv, makeCompleteMarker, makeRunRecord, validateRunCwd } from './run-shared.js';

type CodexEntry = { type: string; [key: string]: unknown };

function readUsageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readCodexItemText(item: CodexEntry | null | undefined): string {
  if (!item || typeof item !== 'object') {
    return '';
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (!part || typeof part !== 'object') {
          return '';
        }
        if (typeof (part as CodexEntry).text === 'string') {
          return (part as CodexEntry).text as string;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function readCodexItemStreamKey(item: CodexEntry | null | undefined): string | null {
  if (!item || typeof item !== 'object') {
    return null;
  }
  if (typeof item.id === 'string' && item.id) {
    return item.id;
  }
  if (typeof item.call_id === 'string' && item.call_id) {
    return item.call_id;
  }
  return null;
}

type CodexStreamingUpdate = {
  delta: string;
  shouldEnd: boolean;
  suppressCompletedText: boolean;
  streamKey: string;
};

/** Mirror of `openai-codex.js` `extractCodexStreamingUpdate`. */
function extractCodexStreamingUpdate(
  event: Record<string, unknown>,
  streamState: Map<string, string>,
): CodexStreamingUpdate | null {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if ((event.type !== 'item.updated' && event.type !== 'item.completed') || !event.item) {
    return null;
  }
  const item = event.item as Record<string, unknown>;
  if (item?.type !== 'agent_message') {
    return null;
  }
  const streamKey = readCodexItemStreamKey(item as CodexEntry);
  if (!streamKey) {
    return null;
  }
  const nextText = readCodexItemText(item as CodexEntry);
  const previousText = streamState.get(streamKey) || '';
  const hasStreamed = streamState.has(streamKey);

  if (nextText.length < previousText.length) {
    streamState.set(streamKey, nextText);
    return {
      delta: nextText,
      shouldEnd: event.type === 'item.completed',
      suppressCompletedText: nextText.length > 0,
      streamKey,
    };
  }

  const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
  streamState.set(streamKey, nextText);

  return {
    delta,
    shouldEnd: event.type === 'item.completed' && (hasStreamed || nextText.length > 0),
    suppressCompletedText: event.type === 'item.completed' && nextText.length > 0,
    streamKey,
  };
}

type CodexTokenBudget = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: { input: number; output: number };
};

/** Mirror of `openai-codex.js` `extractCodexTokenBudget`. */
function extractCodexTokenBudget(event: Record<string, unknown>): CodexTokenBudget | null {
  const payload = event.payload as CodexEntry | undefined;
  const usageEvent = event.usage as CodexEntry | undefined;
  const info =
    (event.info as CodexEntry | undefined)
    ?? (payload?.info as CodexEntry | undefined)
    ?? (usageEvent?.info as CodexEntry | undefined);
  let usage =
    (info?.total_token_usage as CodexEntry | undefined)
    ?? (usageEvent?.total_token_usage as CodexEntry | undefined)
    ?? usageEvent;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  usage = usage as CodexEntry;
  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info?.model_context_window || (usageEvent?.model_context_window as unknown)) || 200000,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/** Mirror of `openai-codex.js` `transformCodexEvent`. */
function transformCodexEvent(event: Record<string, unknown>): CodexEntry {
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item as CodexEntry | null | undefined;
      if (!item) {
        return { type: event.type as string, item: null };
      }
      switch (item.type) {
        case 'agent_message':
          return { type: 'item', itemType: 'agent_message', message: { role: 'assistant', content: item.text } };
        case 'reasoning':
          return { type: 'item', itemType: 'reasoning', message: { role: 'assistant', content: item.text, isReasoning: true } };
        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status,
          };
        case 'file_change':
          return { type: 'item', itemType: 'file_change', changes: item.changes, status: item.status };
        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status,
          };
        case 'web_search':
          return { type: 'item', itemType: 'web_search', query: item.query };
        case 'todo_list':
          return { type: 'item', itemType: 'todo_list', items: item.items };
        case 'error':
          return { type: 'item', itemType: 'error', message: { role: 'error', content: item.message } };
        default:
          return { type: 'item', itemType: item.type as string, item: item as Record<string, unknown> };
      }
    }
    case 'turn.started':
      return { type: 'turn_started' };
    case 'turn.completed':
      return { type: 'turn_complete', usage: event.usage };
    case 'turn.failed':
      return { type: 'turn_failed', error: event.error };
    case 'thread.started':
      return { type: 'thread_started', threadId: event.thread_id || event.id };
    case 'error':
      return { type: 'error', message: event.message };
    default:
      return { type: event.type as string, data: event };
  }
}

/**
 * Live-event normalization mirror of `CodexSessionsProvider.normalizeMessage`
 * (`backend/server/modules/providers/list/codex/codex-sessions.provider.ts`),
 * trimmed to the branches the LIVE path exercises (its `raw.type === 'item'`
 * switch plus `turn_complete`/`turn_failed`). History-row branches
 * (`raw.message?.role`, tool linking) are main-side concerns served by the
 * `session/messages` RPC, not the live stream, so they are intentionally absent.
 */
function normalizeCodexLiveEvent(rawValue: unknown, sessionId: string | null): LiteNormalizedMessage[] {
  const raw = readObjectRecord(rawValue);
  if (!raw) {
    return [];
  }
  const ts = (raw.timestamp as string | undefined) || new Date().toISOString();
  const baseId = (raw.uuid as string | undefined) || generateMessageId('codex');

  if (raw.type === 'item') {
    switch (raw.itemType) {
      case 'agent_message':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'text',
          role: 'assistant',
          content: (raw.message as Record<string, unknown> | undefined)?.content ?? '',
        })];
      case 'reasoning':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'thinking',
          content: (raw.message as Record<string, unknown> | undefined)?.content ?? '',
        })];
      case 'command_execution':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'tool_use',
          toolName: 'Bash', toolInput: { command: raw.command }, toolId: baseId,
          output: raw.output, exitCode: raw.exitCode, status: raw.status,
        })];
      case 'file_change':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'tool_use',
          toolName: 'FileChanges', toolInput: raw.changes, toolId: baseId, status: raw.status,
        })];
      case 'mcp_tool_call':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'tool_use',
          toolName: raw.tool ?? 'MCP', toolInput: raw.arguments, toolId: baseId,
          server: raw.server, result: raw.result, error: raw.error, status: raw.status,
        })];
      case 'web_search':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'tool_use',
          toolName: 'WebSearch', toolInput: { query: raw.query }, toolId: baseId,
        })];
      case 'todo_list':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'tool_use',
          toolName: 'TodoList', toolInput: { items: raw.items }, toolId: baseId,
        })];
      case 'error':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'error',
          content: (raw.message as Record<string, unknown> | undefined)?.content ?? 'Unknown error',
        })];
      default:
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'tool_use',
          toolName: (raw.itemType as string) ?? 'Unknown', toolInput: raw.item ?? raw, toolId: baseId,
        })];
    }
  }

  if (raw.type === 'turn_complete') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'complete',
    })];
  }
  if (raw.type === 'turn_failed') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: 'codex', kind: 'error',
      content: (raw.error as Record<string, unknown> | undefined)?.message ?? 'Turn failed',
    })];
  }

  return [];
}

/** Mirror of `openai-codex.js` `mapPermissionModeToCodexOptions`. */
function mapPermissionModeToCodexOptions(permissionMode: string | undefined): {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
} {
  switch (permissionMode) {
    case 'acceptEdits':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
    case 'bypassPermissions':
      return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
    case 'default':
    default:
      return { sandboxMode: 'workspace-write', approvalPolicy: 'untrusted' };
  }
}

export function createCodexRunManager(deps: RunManagerDeps): RunManager {
  const runs = new Map<string, ReturnType<typeof makeRunRecord>['run']>();

  function pushNorm(appSessionId: string, message: unknown): void {
    deps.push(`session:${appSessionId}`, { _remoteNorm: true, message });
  }

  async function start(params: SessionStartParams): Promise<{ providerSessionId: string }> {
    const { appSessionId } = params;
    if (runs.has(appSessionId)) {
      throw new Error(`session already running: ${appSessionId}`);
    }
    await validateRunCwd(deps.roots, params.cwd);

    const { run, established, settleEstablished } = makeRunRecord(params);
    let providerSessionId = params.providerSessionId ?? '';
    runs.set(appSessionId, run);

    void (async () => {
      let runFailed = false;
      let runError = '';
      try {
        // CODEX_PATH_OVERRIDE mirrors the local runner: an externally installed
        // Codex (npm/pnpm global, brew, ...) wins over the SDK's bundled binary.
        const configEnvPresent = Boolean(params.configEnv && Object.keys(params.configEnv).length > 0);
        const codex = new Codex({
          ...(process.env.CODEX_PATH_OVERRIDE?.trim()
            ? { codexPathOverride: process.env.CODEX_PATH_OVERRIDE.trim() }
            : {}),
          // The SDK does NOT inherit process.env when `env` is present, so a
          // merged env (PATH etc.) must be handed over explicitly whenever a
          // per-session configEnv exists (a bare configEnv would strip PATH).
          ...(configEnvPresent ? { env: buildRunEnv(undefined, params.configEnv) } : {}),
        });

        const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(params.permissionMode);
        const threadOptions: ThreadOptions = {
          workingDirectory: params.cwd,
          skipGitRepoCheck: true,
          sandboxMode,
          approvalPolicy,
          ...(params.model !== undefined && params.model !== null ? { model: params.model } : {}),
        };

        const thread = providerSessionId
          ? codex.resumeThread(providerSessionId, threadOptions)
          : codex.startThread(threadOptions);

        const streamedTurn = await thread.runStreamed(params.command, { signal: run.controller.signal });
        const streamedAgentMessages = new Map<string, string>();
        let sessionCreatedSent = false;
        let terminalFailure: unknown = null;

        for await (const event of streamedTurn.events as AsyncIterable<ThreadEvent>) {
          if (run.aborted) {
            break;
          }
          const eventRecord = event as unknown as Record<string, unknown>;

          // Capture the thread/session id lazily (Codex emits it asynchronously).
          if (event.type === 'thread.started' && !run.establishedSid) {
            const discovered = (eventRecord.thread_id as string | undefined) || (eventRecord.id as string | undefined) || null;
            if (discovered) {
              run.establishedSid = true;
              providerSessionId = discovered;
              settleEstablished(discovered);
              if (!sessionCreatedSent) {
                sessionCreatedSent = true;
                pushNorm(appSessionId, createNormalizedMessage({
                  kind: 'session_created',
                  newSessionId: discovered,
                  sessionId: discovered,
                  provider: 'codex',
                }));
              }
            }
          }

          if (run.controller.signal.aborted) {
            break;
          }

          const sid = providerSessionId || null;
          const streamingUpdate = extractCodexStreamingUpdate(eventRecord, streamedAgentMessages);
          if (streamingUpdate?.delta) {
            pushNorm(appSessionId, createNormalizedMessage({
              kind: 'stream_delta',
              content: streamingUpdate.delta,
              sessionId: sid,
              provider: 'codex',
            }));
          }
          if (streamingUpdate?.shouldEnd) {
            pushNorm(appSessionId, createNormalizedMessage({
              kind: 'stream_end',
              sessionId: sid,
              provider: 'codex',
            }));
            if (streamingUpdate.streamKey) {
              streamedAgentMessages.delete(streamingUpdate.streamKey);
            }
          }

          if (event.type === 'item.started' || event.type === 'item.updated') {
            continue;
          }

          const transformed = transformCodexEvent(eventRecord);
          const normalizedMsgs = normalizeCodexLiveEvent(transformed, sid);
          for (const msg of normalizedMsgs) {
            if (
              streamingUpdate?.suppressCompletedText
              && event.type === 'item.completed'
              && msg.kind === 'text'
              && msg.role === 'assistant'
            ) {
              continue;
            }
            pushNorm(appSessionId, msg);
          }

          if (event.type === 'turn.failed' && !terminalFailure) {
            terminalFailure = event.error ?? new Error('Turn failed');
          }

          if (event.type === 'turn.completed') {
            const tokenBudget = extractCodexTokenBudget(eventRecord);
            if (tokenBudget) {
              pushNorm(appSessionId, createNormalizedMessage({
                kind: 'status',
                text: 'token_budget',
                tokenBudget,
                sessionId: sid,
                provider: 'codex',
              }));
            }
          }
        }

        // Terminal complete — the local runner skips it for aborted runs (the
        // abort path already surfaced its terminal marker).
        if (!run.aborted && !run.controller.signal.aborted) {
          pushNorm(appSessionId, createCompleteMessage({
            provider: 'codex',
            sessionId: providerSessionId || null,
            actualSessionId: providerSessionId || thread.id || null,
            exitCode: terminalFailure ? 1 : 0,
          }));
        }
      } catch (err) {
        const wasAborted =
          (err as Error)?.name === 'AbortError'
          || String((err as Error)?.message || '').toLowerCase().includes('aborted');
        if (!run.aborted && !wasAborted) {
          runFailed = true;
          runError = err instanceof Error ? err.message : String(err);
          console.error(`[codex-runner] session ${appSessionId} failed:`, runError);
          pushNorm(appSessionId, createNormalizedMessage({
            kind: 'error',
            content: runError,
            sessionId: providerSessionId || null,
            provider: 'codex',
          }));
          pushNorm(appSessionId, createCompleteMessage({
            provider: 'codex',
            sessionId: providerSessionId || null,
            exitCode: 1,
          }));
        }
      } finally {
        run.doneResolve();
        runs.delete(appSessionId);
      }
      deps.push(`session:${appSessionId}`, makeCompleteMarker(!runFailed, runFailed ? runError : undefined));
      settleEstablished(providerSessionId);
    })();

    return { providerSessionId: await established };
  }

  function whenDone(appSessionId: string): Promise<void> {
    return runs.get(appSessionId)?.done ?? Promise.resolve();
  }

  function interrupt(appSessionId: string): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }
    run.aborted = true;
    try {
      run.controller.abort();
    } catch {
      /* ignore */
    }
    return true;
  }

  function interruptAll(): number {
    const ids = Array.from(runs.keys());
    for (const id of ids) interrupt(id);
    return ids.length;
  }

  return { start, respond: () => false, whenDone, interrupt, interruptAll };
}