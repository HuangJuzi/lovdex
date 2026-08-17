/**
 * Headless task-run launcher — the server-side counterpart to the browser's
 * `chat.send` frame. Used by the Operator's `start_task_execution` tool, which
 * runs in a headless SDK query (no WebSocket client): it creates + links a
 * session via `tasksService.startExecution` and then calls this to actually
 * start the agent run.
 *
 * Without this, `start_task_execution` only allocated the session and the task
 * sat forever in `todo` with `started_at = null` — the run was never kicked
 * off. See `chat-websocket.service.ts handleChatSend` for the interactive path
 * this mirrors.
 */
import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from './chat-run-registry.service.js';
import type { LLMProvider, RealtimeClientConnection } from '@/shared/types.js';

type ProviderSpawnFn = (
  command: string,
  options: Record<string, unknown>,
  writer: unknown,
) => Promise<unknown>;

export type HeadlessTaskRunOptions = {
  /** The prompt to send to the agent (task description falling back to title). */
  content: string;
  /** Task executor model override, if any. */
  model?: string | null;
  /** Provider runtimes keyed by provider id (same map the WS server uses). */
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
};

/** Injectable seams so the launcher is unit-testable without a real DB/registry. */
type HeadlessTaskRunDeps = {
  getSessionById?: (sessionId: string) => {
    provider: string;
    provider_session_id: string | null;
    project_path: string | null;
    is_operator: number;
  } | null;
  startRun?: (input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection: RealtimeClientConnection;
    userId: string | number | null;
  }) => { writer: unknown } | null;
  completeRunIfCurrent?: (run: { writer: unknown }, opts: { exitCode: number }) => void;
};

/**
 * Start a provider run for an existing app session with NO websocket client.
 *
 * Mirrors `handleChatSend` but with `connection: null`: the run is registered
 * (which synchronously flips the linked task to `in_progress` via
 * `taskLinkage.onSessionStatus('running')`, setting `started_at` and the
 * `running` badge), then the provider runtime is dispatched fire-and-forget.
 * Live frames fan out to whatever board tabs are subscribed; the run streams
 * and persists server-side exactly like an interactive task run.
 *
 * Returns `true` if the run was started, `false` if the session/provider is
 * unknown or a run is already in progress for the session.
 */
export function startHeadlessTaskRun(
  sessionId: string,
  options: HeadlessTaskRunOptions,
  deps: HeadlessTaskRunDeps = {},
): boolean {
  const getSessionById = deps.getSessionById ?? ((id) => sessionsDb.getSessionById(id));
  const startRun = deps.startRun ?? ((input) => chatRunRegistry.startRun(input));
  const completeRunIfCurrent =
    deps.completeRunIfCurrent ?? ((run, opts) => chatRunRegistry.completeRunIfCurrent(run as never, opts));

  const session = getSessionById(sessionId);
  if (!session) {
    console.error('[headless-task-run] session not found:', sessionId);
    return false;
  }
  const provider = session.provider as LLMProvider;
  const spawnFn = options.spawnFns[provider];
  if (!spawnFn) {
    console.error('[headless-task-run] unsupported provider:', provider);
    return false;
  }

  const run = startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    // No browser socket: the writer's addConnection no-ops on a falsy
    // connection, and broadcastSessionStatus still fans out to subscribed
    // board tabs. This is what makes a server-side dispatch possible.
    connection: null as unknown as RealtimeClientConnection,
    userId: null,
  });
  if (!run) {
    // A run is already in progress for this session — leave it alone.
    return false;
  }

  // Same runtimeOptions shape as handleChatSend (chat-websocket.service.ts).
  // provider id / project path / is_operator all come from the DB row, never
  // the caller — same trust boundary as the interactive path.
  const runtimeOptions: Record<string, unknown> = {
    model: options.model || undefined,
    // 'default' so permission prompts surface as the board's "等你批准" marker
    // for the user to decide — identical to the manual "开始执行" button.
    permissionMode: 'default',
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    skipPermissions: false,
    includePartialMessages: true,
    sessionId: session.provider_session_id ?? undefined,
    resume: Boolean(session.provider_session_id),
    cwd: session.project_path ?? undefined,
    projectPath: session.project_path ?? undefined,
    isOperator: Boolean(session.is_operator),
  };

  // Fire-and-forget: the operator tool call must return immediately so the
  // operator can continue; the run streams and persists server-side. Mirror
  // handleChatSend's safety net so a crashed runtime cannot leave the session
  // stuck in "processing" forever on every subscribed client.
  void (async () => {
    try {
      await spawnFn(options.content, runtimeOptions, run.writer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[headless-task-run] provider runtime "${provider}" failed`, {
        sessionId,
        error: message,
      });
    } finally {
      completeRunIfCurrent(run, { exitCode: 1 });
    }
  })();

  return true;
}
