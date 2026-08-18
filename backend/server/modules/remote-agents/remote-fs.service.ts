import type { RemoteStat } from '@/shared/agent-runtime/protocol.js';

import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

/**
 * Filesystem RPC client over a remote lite agent.
 *
 * Each method forwards to the registry's `rpc` for the given host, using the
 * `fs/*` methods the lite agent implements. `getRegistry` is a thunk so the
 * live registry is resolved lazily (the runtime seam is wired at boot, after
 * this client is constructed).
 */
export type RemoteFsClient = {
  stat(hostId: string, pathText: string): Promise<RemoteStat>;
  list(
    hostId: string,
    pathText: string,
    maxEntries?: number,
  ): Promise<{ name: string; type: 'dir' | 'file' | 'symlink'; size: number | null }[]>;
  read(hostId: string, pathText: string, maxBytes?: number): Promise<{ content: string; truncated: boolean }>;
};

export function createRemoteFsClient(getRegistry: () => RemoteAgentsRegistry): RemoteFsClient {
  const reg = () => getRegistry();
  return {
    stat: (h, p) => reg().rpc<RemoteStat>(h, 'fs/stat', { path: p }),
    list(h, p, maxEntries = 200) {
      return reg().rpc(h, 'fs/list', { path: p, maxEntries });
    },
    read(h, p, maxBytes = 1024 * 1024) {
      return reg().rpc(h, 'fs/read', { path: p, maxBytes });
    },
  };
}
