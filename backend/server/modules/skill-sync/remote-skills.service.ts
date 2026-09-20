import { SKILLS_CAPABILITY } from '@/shared/agent-runtime/protocol.js';
import type {
  RemoteSkillApplyResult,
  RemoteSkillBundle,
  RemoteSkillManifest,
} from '@/shared/agent-runtime/protocol.js';
import type { SkillApplyInput, SkillStore } from '@/shared/skill-store.js';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';

/**
 * RPC timeouts. `apply` mirrors `fs/write` (120s) because it moves a whole
 * directory over the wire; `manifest` is a metadata-only call.
 */
export const SKILL_RPC_TIMEOUTS = { manifest: 30_000, bundle: 60_000, apply: 120_000 } as const;

/**
 * Gate every skill RPC on the `skills/v1` capability.
 *
 * An older lite has no `skills/*` methods at all, so the RPC would come back as
 * `unknown rpc method` — a confusing error for what is really "this host needs
 * a deploy". Failing here names the actual remedy.
 */
export function assertSkillsCapable(registry: RemoteAgentsRegistry, hostId: string): void {
  const caps = registry.getCapabilities(hostId);
  if (!caps) {
    throw new Error(`远程主机 ${hostId} 不在线`);
  }
  if (!caps.includes(SKILLS_CAPABILITY)) {
    throw new Error(`目标主机 lite 版本过旧（缺少 ${SKILLS_CAPABILITY}），请先 deploy 升级`);
  }
}

export type RemoteSkillsClient = {
  manifest(hostId: string, root: string): Promise<RemoteSkillManifest>;
  bundle(hostId: string, root: string, name: string): Promise<RemoteSkillBundle>;
  apply(hostId: string, input: SkillApplyInput): Promise<RemoteSkillApplyResult>;
};

export function createRemoteSkillsClient(
  getRegistry: () => RemoteAgentsRegistry,
): RemoteSkillsClient {
  const reg = () => getRegistry();
  // Methods are `async` so the capability gate REJECTS rather than throws
  // synchronously: a {@link SkillStore} is a promise-shaped API, and a sync
  // throw would bypass `.catch()` in callers (and `assert.rejects`, which
  // skips its error handler for sync throws).
  return {
    async manifest(hostId, root) {
      assertSkillsCapable(reg(), hostId);
      return reg().rpc<RemoteSkillManifest>(hostId, 'skills/manifest', { root }, SKILL_RPC_TIMEOUTS.manifest);
    },
    async bundle(hostId, root, name) {
      assertSkillsCapable(reg(), hostId);
      return reg().rpc<RemoteSkillBundle>(hostId, 'skills/bundle', { root, name }, SKILL_RPC_TIMEOUTS.bundle);
    },
    async apply(hostId, input) {
      assertSkillsCapable(reg(), hostId);
      return reg().rpc<RemoteSkillApplyResult>(hostId, 'skills/apply', input, SKILL_RPC_TIMEOUTS.apply);
    },
  };
}

/** A {@link SkillStore} bound to one host — the node adapter's remote half. */
export function createRemoteSkillStore(
  getRegistry: () => RemoteAgentsRegistry,
  hostId: string,
): SkillStore {
  const client = createRemoteSkillsClient(getRegistry);
  return {
    async manifest(root) {
      return client.manifest(hostId, root);
    },
    async bundle(root, name) {
      return client.bundle(hostId, root, name);
    },
    async apply(input) {
      return client.apply(hostId, input);
    },
  };
}
