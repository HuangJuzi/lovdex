import type { RemoteAgentConfig } from './config.js';

/**
 * Dispatches an `rpc_req` method to its handler.
 *
 * Stub for the skeleton milestone: every method is unknown. Task 9 fills in
 * the real routing (session/claude, fs/read, …).
 */
export async function handleRpc(
  method: string,
  _params: unknown,
  _cfg: RemoteAgentConfig,
): Promise<unknown> {
  throw new Error('unknown rpc method: ' + method);
}
