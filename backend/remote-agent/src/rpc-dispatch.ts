import { createAgentRunManager, type SessionStartParams } from './agent-run.js';

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
 * Dispatches an `rpc_req` method to its handler.
 *
 * - `session/start`     → begin a claude run (resolves with providerSessionId).
 * - `session/interrupt` → signal the run to stop (`{ interrupted: boolean }`).
 * - `approval/respond`  → resolve a pending tool approval (`{ accepted: boolean }`).
 * - `fs/*`              → rejected until Task 10 wires the allowlisted fs.
 * - anything else       → `unknown rpc method`.
 */
export async function handleRpc(
  method: string,
  params: unknown,
  _cfg: unknown,
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
  if (method.startsWith('fs/')) {
    throw new Error('fs not implemented yet');
  }
  throw new Error('unknown rpc method: ' + method);
}
