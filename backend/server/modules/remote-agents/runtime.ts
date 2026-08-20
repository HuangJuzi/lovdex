import type { RemoteAgentsRegistry } from './remote-agents.registry.js';
import type { RemoteFsClient } from './remote-fs.service.js';
import type { RemoteHistoryClient } from './remote-history.service.js';

/**
 * Late-bound runtime seam for the remote-agents module.
 *
 * `index.js` (Task 13) constructs the registry + fs client once at boot and
 * calls {@link setRemoteAgentsRuntime}. Route handlers pull the live instances
 * through {@link getRemoteAgentsRuntime} so they never value-import the
 * concrete modules (keeps the import graph acyclic — this file imports only
 * types). Tests inject fakes via {@link setRemoteAgentsRuntime}.
 */
export type RemoteAgentsRuntime = {
  registry: RemoteAgentsRegistry;
  fsClient: RemoteFsClient;
  historyClient: RemoteHistoryClient;
};

let runtime: RemoteAgentsRuntime | null = null;

export function setRemoteAgentsRuntime(r: RemoteAgentsRuntime): void {
  runtime = r;
}

export function getRemoteAgentsRuntime(): RemoteAgentsRuntime {
  if (!runtime) {
    throw new Error('remote agents runtime not configured');
  }
  return runtime;
}
