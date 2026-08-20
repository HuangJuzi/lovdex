import type {
  RemoteSessionMessagesResult,
  SessionMessagesParams,
} from '@/shared/agent-runtime/protocol.js';

import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

/**
 * Remote chat history client for the `session/messages` RPC.
 *
 * The lite agent holds the only copy of a remote session's transcript (it is
 * written by the provider CLI on the remote host). `fetchHistory` on the main
 * side routes through here when a session's project path resolves to a remote
 * host: the lite reads the transcript directory and returns the raw file
 * contents, which main then decodes with the same shared parsing it uses for
 * local transcripts. `getRegistry` is a thunk so the live registry is resolved
 * lazily (the seam is wired at boot; provider modules never value-import the
 * registry).
 */
export type RemoteHistoryClient = {
  fetchMessages(hostId: string, params: SessionMessagesParams): Promise<RemoteSessionMessagesResult>;
};

export function createRemoteHistoryClient(getRegistry: () => RemoteAgentsRegistry): RemoteHistoryClient {
  const reg = () => getRegistry();
  return {
    fetchMessages(hostId, params) {
      return reg().rpc<RemoteSessionMessagesResult>(hostId, 'session/messages', params, 30_000);
    },
  };
}