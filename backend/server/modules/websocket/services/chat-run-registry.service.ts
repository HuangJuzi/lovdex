import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { writeCustomNameToDisk } from '@/modules/providers/services/write-custom-name-to-disk.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { isOperatorWorkspacePath } from '@/modules/operators/operator-workspace.service.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const isOperatorWorkspace = project ? await isOperatorWorkspacePath(project.project_path) : false;

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
        isOperatorWorkspace,
      }
      : null,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

/**
 * Broadcasts a lightweight cross-session status frame to EVERY connected
 * client — not just the run's attached connection. This is what lets a
 * client viewing session A learn that session B started/finished/failed/
 * aborted without subscribing to B's stream: the sidebar spinner turns on
 * for `running` and off for the terminal states, and a UI can toast on the
 * terminal transition.
 *
 * Provider-agnostic: both Claude and Codex runs funnel their terminal
 * `complete` through `decorateAndRecordEvent`, so a single emit site covers
 * both. The frame carries no `seq` and no stream content — it is a control
 * frame like `session_upserted`.
 */
type SessionStatusState = 'running' | 'completed' | 'failed' | 'aborted';

function broadcastSessionStatus(
  appSessionId: string,
  provider: LLMProvider,
  state: SessionStatusState,
  meta: { exitCode?: number | null; startedAt?: number | null; completedAt?: number | null } = {},
): void {
  const payload = JSON.stringify({
    kind: 'session_status',
    sessionId: appSessionId,
    provider,
    state,
    exitCode: meta.exitCode ?? null,
    startedAt: meta.startedAt ?? null,
    completedAt: meta.completedAt ?? null,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

/**
 * Task↔session linkage, injected (not imported) so the registry stays
 * decoupled from the tasks module and testable without a service instance.
 */
type TaskLinkage = {
  onSessionStatus: (sessionId: string, state: SessionStatusState) => void;
  /** Marks/unmarks the linked task's live "等你批准" overlay (status untouched). */
  onSessionApproval: (sessionId: string, pending: boolean) => void;
};

let taskLinkage: TaskLinkage | null = null;

/** Wire the task↔session linkage (set once at server startup). */
export function setTaskLinkage(linkage: TaskLinkage | null): void {
  taskLinkage = linkage;
}

/** Read the task↔session linkage (used by the approval-response clear path). */
export function getTaskLinkage(): TaskLinkage | null {
  return taskLinkage;
}

/**
 * Maps a pending permission requestId back to the app session that owns it, so
 * the `chat.permission-response` handler can clear the task approval marker.
 * Entries are added when `permission_request` flows through the registry and
 * removed on `permission_cancelled` or once the human responds.
 */
const approvalRequestToSession = new Map<string, string>();
/**
 * Parallel to `approvalRequestToSession`: the toolName for each pending
 * approval request, so the task board can classify the wait reason
 * (AskUserQuestion→"等你回答", ExitPlanMode→"等你确认计划", tool permission→"等你批准")
 * instead of a generic "等你批准". Cleared alongside the session map.
 */
const approvalRequestToTool = new Map<string, string>();

/**
 * Evicts every pending permission request owned by one app session. Called on
 * the terminal `complete` (including the synthetic one emitted on abort/crash)
 * so a request that can never be resolved does not leave its "等你批准" marker
 * stuck nor leak its requestId→appSessionId mapping entry.
 */
function clearApprovalRequestsForSession(appSessionId: string): void {
  for (const [requestId, ownerSessionId] of approvalRequestToSession) {
    if (ownerSessionId === appSessionId) {
      approvalRequestToSession.delete(requestId);
      approvalRequestToTool.delete(requestId);
    }
  }
}

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // A pending tool-approval prompt is surfaced as a live task marker (the
  // "等你批准" overlay) so the board reflects the session waiting on the human.
  // These events never change the task status — the marker is a realtime flag.
  if (message.kind === 'permission_request') {
    if (typeof message.requestId === 'string' && message.requestId) {
      approvalRequestToSession.set(message.requestId, run.appSessionId);
      if (typeof message.toolName === 'string' && message.toolName) {
        approvalRequestToTool.set(message.requestId, message.toolName);
      }
    }
    taskLinkage?.onSessionApproval(run.appSessionId, true);
  }
  if (message.kind === 'permission_cancelled') {
    if (typeof message.requestId === 'string' && message.requestId) {
      approvalRequestToSession.delete(message.requestId);
      approvalRequestToTool.delete(message.requestId);
    }
    taskLinkage?.onSessionApproval(run.appSessionId, false);
  }

  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);

    // Fan out the terminal state to every client so a viewer in another
    // session learns this one finished/failed/aborted without subscribing.
    const complete = message as { aborted?: boolean; exitCode?: number | null };
    const state: SessionStatusState = complete.aborted
      ? 'aborted'
      : (complete.exitCode === 0 ? 'completed' : 'failed');
    broadcastSessionStatus(run.appSessionId, run.provider, state, {
      exitCode: complete.exitCode ?? null,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    });
    taskLinkage?.onSessionStatus(run.appSessionId, state);
    // The run is over: a still-pending tool-approval can never be answered, so
    // drop its "等你批准" marker and forget the request mapping. This covers the
    // abort path and the crash safety-net, which only emit a synthetic
    // `complete` (no `permission_cancelled`) and would otherwise leave the task
    // marked pending forever.
    clearApprovalRequestsForSession(run.appSessionId);
    taskLinkage?.onSessionApproval(run.appSessionId, false);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
/**
 * Best-effort writeback of a previously-stored `custom_name` to the provider's
 * own disk artifacts once the provider session id (and transcript path) have
 * landed.
 *
 * Covers the "rename before the provider run starts" window: at rename time
 * `provider_session_id`/`jsonl_path` are still NULL so `writeCustomNameToDisk`
 * is a no-op; later, when the runtime announces its id and the transcript is
 * on disk, this replays the rename so the native CLI also shows the new title.
 */
export async function onProviderSessionAssigned(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || !row.custom_name) return;
  await writeCustomNameToDisk({
    provider: row.provider,
    provider_session_id: row.provider_session_id,
    jsonl_path: row.jsonl_path,
    custom_name: row.custom_name,
  });
}

function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void onProviderSessionAssigned(run.appSessionId).catch((error) => {
      console.error('[ChatRunRegistry] writeCustomNameToDisk after assign failed', {
        appSessionId: run.appSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection: RealtimeClientConnection;
    userId: string | number | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    // Fan out a `running` status so any client (not just the one that sent
    // chat.send) can flip the sidebar spinner for this session.
    broadcastSessionStatus(run.appSessionId, run.provider, 'running', { startedAt: run.startedAt });
    taskLinkage?.onSessionStatus(run.appSessionId, 'running');
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  /**
   * Returns a map of app session id → the toolName that session is currently
   * waiting on (the most recent pending request's tool). The task service
   * decorates task rows with this so the board can reconstruct its live
   * "等你回答/等你确认计划/等你批准" overlay on load/reconnect AND classify the wait
   * reason by tool — without it, a marker that fired while the board tab was
   * closed could never reappear (the chat page self-heals via
   * `getPendingApprovalsForSession` on subscribe, but the board only listened
   * to one-shot `task_upserted` events).
   */
  listPendingApprovalSessions(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [requestId, sessionId] of approvalRequestToSession) {
      const tool = approvalRequestToTool.get(requestId);
      // Keep the most recently-seen tool for a session with multiple pending
      // requests (last write wins via Map insertion order).
      result.set(sessionId, tool ?? result.get(sessionId ?? '') ?? 'UnknownTool');
    }
    return result;
  },

  /**
   * Resolves the app session id that owns a pending permission request and
   * forgets the mapping (the approval is being decided). Returns `null` when
   * the requestId is unknown — e.g. the request predates this server process.
   */
  takeApprovalRequestSession(requestId: string): string | null {
    if (!requestId) {
      return null;
    }
    const appSessionId = approvalRequestToSession.get(requestId) ?? null;
    if (appSessionId !== null) {
      approvalRequestToSession.delete(requestId);
      approvalRequestToTool.delete(requestId);
    }
    return appSessionId;
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Adds a websocket connection to a run's live fan-out set.
   *
   * Unlike the old single-socket writer, this is ADDITIVE, not a replacement:
   * every socket that subscribes to this session while it is running receives
   * the live stream. That is what prevents the multi-tab "connection steal" —
   * a later `chat.subscribe` from another tab used to re-bind the run to the
   * last subscriber, freezing the original tab with no self-heal until a
   * refresh. With fan-out both tabs stream; each tab still catches up via the
   * `lastSeq`-based replay that follows the ack.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.addConnection(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run and pending approval map.
   */
  clearAll(): void {
    runs.clear();
    approvalRequestToSession.clear();
    approvalRequestToTool.clear();
  },
};
