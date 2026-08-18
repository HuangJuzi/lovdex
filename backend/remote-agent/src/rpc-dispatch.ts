import { createAgentRunManager, type SessionStartParams } from './agent-run.js';
import { createAllowlistedFs } from './fs.js';
import type { RemoteAgentConfig } from './config.js';

/**
 * Bridge to the current WebSocket push bus. index.ts calls {@link setPushEmitter}
 * on each connection open so pushes are re-pointed at the live socket instead of
 * closing over a stale one across reconnects.
 */
let pushEmitter: (topic: string, payload: unknown) => void = () => {};

export function setPushEmitter(fn: (topic: string, payload: unknown) => void): void {
  pushEmitter = fn;
}

/** The process-wide agent-run manager. Pushes route through the live emitter. */
export const agentRuns = createAgentRunManager({
  push: (topic, payload) => pushEmitter(topic, payload),
});

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
 * Dispatches an `rpc_req` method to its handler.
 *
 * - `session/start`     → begin a claude run (resolves with providerSessionId).
 * - `session/interrupt` → signal the run to stop (`{ interrupted: boolean }`).
 * - `approval/respond`  → resolve a pending tool approval (`{ accepted: boolean }`).
 * - `fs/stat|list|read` → allowlisted fs ops scoped to `cfg.roots` (Task 10).
 * - anything else       → `unknown rpc method`.
 */
export async function handleRpc(
  method: string,
  params: unknown,
  cfg: RemoteAgentConfig,
): Promise<unknown> {
  if (method === 'session/start') {
    return agentRuns.start(params as SessionStartParams);
  }
  if (method === 'session/interrupt') {
    const { appSessionId } = params as { appSessionId: string };
    return { interrupted: agentRuns.interrupt(appSessionId) };
  }
  if (method === 'approval/respond') {
    const { requestId, decision } = params as { requestId: string; decision: unknown };
    return { accepted: agentRuns.respond(requestId, decision) };
  }
  if (method === 'fs/stat' || method === 'fs/list' || method === 'fs/read') {
    const fsApi = allowlistedFsFor(cfg);
    if (method === 'fs/stat') return fsApi.stat((params as { path: string }).path);
    if (method === 'fs/list') {
      const p = params as { path: string; maxEntries?: number };
      return fsApi.list(p.path, p.maxEntries);
    }
    const p = params as { path: string; maxBytes?: number };
    return fsApi.read(p.path, p.maxBytes);
  }
  throw new Error('unknown rpc method: ' + method);
}
