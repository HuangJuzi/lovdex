import { createAllowlistedFs } from './fs.js';
import { createGitService } from './git.js';
import { probeRemoteHost } from './probe.js';
import { createRunManagerFor } from './providers/registry.js';
import { readSessionMessagesDir } from './transcript.js';
import type { QuerySdkLike, RunManager } from './agent-run.js';
import type { RemoteAgentConfig } from './config.js';
import type { RemoteProvider } from '../../server/shared/agent-runtime/protocol.js';
import { makeGitExecParamsSchema, makeSessionMessagesParamsSchema, makeSessionStartParamsSchema } from '../../server/shared/agent-runtime/protocol.js';

/**
 * Bridge to the current WebSocket push bus. index.ts calls {@link setPushEmitter}
 * on each connection open so pushes are re-pointed at the live socket instead of
 * closing over a stale one across reconnects.
 */
let pushEmitter: (topic: string, payload: unknown) => void = () => {};

export function setPushEmitter(fn: (topic: string, payload: unknown) => void): void {
  pushEmitter = fn;
}

/**
 * The process-wide run managers, cached per (provider, roots). `session/start`,
 * `session/interrupt`, `approval/respond` and session/messages MUST all hit the
 * SAME manager instance for a given (provider, roots) — the managers track
 * `runs`/`approvals` internally, keyed by appSessionId / requestId.
 *
 * Known caveats (I2 reproducing surface, to be tightened in T12/T13):
 *  - Disconnect race: `createAgentRunManager.start()` runs the allowlisted-roots
 *    `stat` BEFORE `runs.set(appSessionId, …)`, so a ws drop inside that window
 *    leaves a run invisible to `interruptAllFor` until it registers — a stale
 *    run can survive a reconnect (the pre-existing I2 failure mode).
 *  - Same appSessionId under two different providers would run in parallel
 *    (each provider has its own manager). Today only `claude` exists and main
 *    generates globally-unique appSessionIds, so this is inert — revisit once
 *    Task 12 adds the other providers.
 */
const runManagers = new Map<string, RunManager>();

/** Test-only SDK injection; see {@link __setDispatchQuerySdkForTests}. */
let dispatchQuerySdk: QuerySdkLike | null = null;

/**
 * TEST SEAM ONLY — inject a fake SDK so dispatch-level tests can drive
 * `session/start` → `session/interrupt` / `approval/respond` through a real
 * cached manager without spawning the actual claude subprocess. Pass `null` to
 * restore the real SDK bridge. Double underscore marks it test-only; do not
 * call from production code.
 */
export function __setDispatchQuerySdkForTests(fn: QuerySdkLike | null): void {
  dispatchQuerySdk = fn;
}

/**
 * TEST SEAM ONLY — drop every cached manager so a later `runManagerFor` rebuilds
 * one (picking up the currently injected querySdk). Double underscore marks it
 * test-only.
 */
export function __resetRunManagersForTests(): void {
  runManagers.clear();
}

function runManagerFor(cfg: RemoteAgentConfig, provider: RemoteProvider): RunManager {
  const key = provider + '\0' + cfg.roots.join('\0');
  let m = runManagers.get(key);
  if (!m) {
    m = createRunManagerFor(provider, {
      push: (topic, payload) => pushEmitter(topic, payload),
      roots: cfg.roots,
      ...(dispatchQuerySdk ? { querySdk: dispatchQuerySdk } : {}),
    });
    runManagers.set(key, m);
  }
  return m;
}

/**
 * Interrupt every active run across ALL provider managers — used when the ws
 * connection is dropped, so a later re-send with the same providerSessionId
 * does not collide with a stale run. Returns the total interrupted.
 *
 * `cfg` is retained for signature symmetry with the other dispatch helpers
 * (`runManagerFor`, `handleRpc`), but the sweep covers every cached manager
 * regardless of which roots or provider it belongs to — a dropped connection
 * means every in-flight run on this lite must stop.
 */
export function interruptAllFor(cfg: RemoteAgentConfig): number {
  let interrupted = 0;
  for (const m of runManagers.values()) interrupted += m.interruptAll();
  return interrupted;
}

/**
 * Lazy memoized allowlisted fs, keyed by the joined roots. The parsed config is
 * immutable at startup, so a live process builds this exactly once; the keyed
 * memo (rather than a single global slot) keeps unit tests with distinct roots
 * isolated.
 */
let cachedRootsKey: string | null = null;
let cachedFs: ReturnType<typeof createAllowlistedFs> | null = null;

function allowlistedFsFor(cfg: RemoteAgentConfig): ReturnType<typeof createAllowlistedFs> {
  const key = cfg.roots.join('\0');
  if (cachedRootsKey !== null && cachedRootsKey === key && cachedFs !== null) return cachedFs;
  cachedRootsKey = key;
  cachedFs = createAllowlistedFs({ roots: cfg.roots });
  return cachedFs;
}

/**
 * Accessor for lite-side capabilities reporting. The probe runs the installed
 * provider CLIs located on the host; main-side hello processing and provider
 * filtering consume it over `providers/probe` (and later hello `providers`).
 */
export function makeProbeAccessor() {
  return { probe: probeRemoteHost };
}

/**
 * Dispatches an `rpc_req` method to its handler.
 *
 * - `session/start`     → begin a provider run (claude today; codex/opencode/qoder land Task 12), resolves with providerSessionId. configEnv is injected per start() call.
 * - `session/messages`  → read a session's transcript ON THIS HOST and return the raw file contents (remote chat history; claude/qoder).
 * - `session/interrupt` → signal the run to stop (`{ interrupted: boolean }`).
 * - `approval/respond`  → resolve a pending tool approval (`{ accepted: boolean }`).
 * - `fs/stat|list|read|write|tree|create|rename|delete` → allowlisted fs ops scoped to `cfg.roots`.
 * - `git/exec`          → roots-allowlisted git subprocess (abortable via controller).
 * - `providers/probe`   → probe installed provider CLIs + git + node.
 * - anything else       → `unknown rpc method`.
 */
export async function handleRpc(
  method: string,
  params: unknown,
  cfg: RemoteAgentConfig,
  controller?: AbortController,
): Promise<unknown> {
  if (method === 'session/start') {
    const parsed = makeSessionStartParamsSchema().parse(params as unknown);
    // configEnv reaches the run per `start()` call (in the parsed params), NOT
    // baked into the cached manager — each session may carry its own env.
    return runManagerFor(cfg, parsed.provider).start(parsed);
  }
  if (method === 'session/messages') {
    // Remote chat history: the transcript is written by the provider CLI on
    // THIS host, so the lite reads it and ships the raw file contents back.
    // Main-side `fetchHistory` decodes them with the shared parser — no parse
    // logic lives here, so local and remote history stay in sync.
    const parsed = makeSessionMessagesParamsSchema().parse(params as unknown);
    const { transcript, agentFiles } = readSessionMessagesDir(
      parsed.provider,
      parsed.projectPath,
      parsed.providerSessionId,
    );
    return { transcript, agentFiles };
  }
  if (method === 'session/interrupt') {
    const { appSessionId } = params as { appSessionId: string };
    // The interrupt target is identified by appSessionId, which only the run's
    // OWN provider manager holds — try each cached manager in turn (a given
    // appSessionId belongs to exactly one run).
    for (const m of runManagers.values()) {
      if (m.interrupt(appSessionId)) return { interrupted: true };
    }
    return { interrupted: false };
  }
  if (method === 'approval/respond') {
    const { requestId, decision } = params as { requestId: string; decision: unknown };
    for (const m of runManagers.values()) {
      if (m.respond(requestId, decision)) return { accepted: true };
    }
    return { accepted: false };
  }
  if (method === 'fs/stat' || method === 'fs/list' || method === 'fs/read') {
    const fsApi = allowlistedFsFor(cfg);
    if (method === 'fs/stat') return fsApi.stat((params as { path: string }).path);
    if (method === 'fs/list') {
      const p = params as { path: string; maxEntries?: number };
      return fsApi.list(p.path, p.maxEntries);
    }
    const p = params as { path: string; maxBytes?: number; encoding?: 'utf8' | 'base64' };
    return fsApi.read(p.path, p.maxBytes, p.encoding ?? 'utf8');
  }
  if (method === 'fs/write' || method === 'fs/create' || method === 'fs/rename' || method === 'fs/delete' || method === 'fs/tree') {
    const fsApi = allowlistedFsFor(cfg);
    if (method === 'fs/write') {
      const p = params as { path: string; content: string; encoding?: 'utf8' | 'base64' };
      return fsApi.write(p.path, p.content, p.encoding ?? 'utf8');
    }
    if (method === 'fs/tree') {
      const p = params as { path: string; maxDepth?: number; showHidden?: boolean };
      return fsApi.tree(p.path, p.maxDepth, p.showHidden);
    }
    if (method === 'fs/create') {
      const p = params as { parentPath: string; type: 'file' | 'directory'; name: string };
      return fsApi.create(p.parentPath, p.type, p.name);
    }
    if (method === 'fs/rename') {
      const p = params as { oldPath: string; newName: string };
      return fsApi.rename(p.oldPath, p.newName);
    }
    const p = params as { path: string; type: 'file' | 'directory' };
    return fsApi.delete(p.path, p.type);
  }
  if (method === 'git/exec') {
    const req = makeGitExecParamsSchema().parse(params);
    return createGitService({ roots: cfg.roots }).exec(req, controller?.signal);
  }
  if (method === 'providers/probe') {
    return probeRemoteHost();
  }
  throw new Error('unknown rpc method: ' + method);
}
