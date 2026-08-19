import { createAllowlistedFs } from './fs.js';
import { createGitService } from './git.js';
import { probeRemoteHost } from './probe.js';
import { createRunManagerFor } from './providers/registry.js';
import type { RunManager } from './agent-run.js';
import type { RemoteAgentConfig } from './config.js';
import type { RemoteProvider } from '../../server/shared/agent-runtime/protocol.js';
import { makeGitExecParamsSchema, makeSessionStartParamsSchema } from '../../server/shared/agent-runtime/protocol.js';

/**
 * Bridge to the current WebSocket push bus. index.ts calls {@link setPushEmitter}
 * on each connection open so pushes are re-pointed at the live socket instead of
 * closing over a stale one across reconnects.
 */
let pushEmitter: (topic: string, payload: unknown) => void = () => {};

export function setPushEmitter(fn: (topic: string, payload: unknown) => void): void {
  pushEmitter = fn;
}

/** The process-wide run managers, cached per (provider, roots). `session/start`,
 * `session/interrupt`, `approval/respond` and session/messages MUST all hit the
 * SAME manager instance for a given (provider, roots) — the managers track
 * `runs`/`approvals` internally, keyed by appSessionId / requestId. */
const runManagers = new Map<string, RunManager>();

function runManagerFor(cfg: RemoteAgentConfig, provider: RemoteProvider): RunManager {
  const key = provider + '\0' + cfg.roots.join('\0');
  let m = runManagers.get(key);
  if (!m) {
    m = createRunManagerFor(provider, {
      push: (topic, payload) => pushEmitter(topic, payload),
      roots: cfg.roots,
    });
    runManagers.set(key, m);
  }
  return m;
}

/**
 * The (legacy) claude run manager for a config. Kept exported so index.ts and
 * any existing callers that pinned the single-provider surface keep working;
 * it is the same instance the (provider, roots) cache hands out for 'claude'.
 */
export function agentRunsFor(cfg: RemoteAgentConfig): RunManager {
  return runManagerFor(cfg, 'claude');
}

/**
 * Interrupt every active run across ALL provider managers — used when the ws
 * connection is dropped, so a later re-send with the same providerSessionId
 * does not collide with a stale run. Returns the total interrupted.
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
    // I3 note (Phase 2): session/messages (remote chat history) is NOT
    // implemented in v1 — remote history falls back to main's local
    // ~/.claude/projects (empty for a remote host). A Phase 2 lite
    // `session/messages` handler will serve the transcript over the rpc bus.
    const parsed = makeSessionStartParamsSchema().parse(params as unknown);
    // configEnv reaches the run per `start()` call (in the parsed params), NOT
    // baked into the cached manager — each session may carry its own env.
    return runManagerFor(cfg, parsed.provider).start(parsed);
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
