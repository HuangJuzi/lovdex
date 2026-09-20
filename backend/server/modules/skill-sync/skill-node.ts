import { getClaudeHomePath, getClaudeSkillsDir } from '@/shared/claude-paths.js';
import { createSkillStore, type SkillStore } from '@/shared/skill-store.js';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';
import { createRemoteSkillStore } from './remote-skills.service.js';
import type { SkillNode } from './types.js';

/**
 * Wire format for a node: `local` | `remote:<hostId>`. Used in the API surface
 * and in audit rows, where a structured value would be noisy.
 */
export function skillNodeLabel(node: SkillNode): string {
  return node.kind === 'local' ? 'local' : `remote:${node.hostId}`;
}

export function parseSkillNode(label: string): SkillNode {
  if (label === 'local') return { kind: 'local' };
  if (label.startsWith('remote:')) {
    const hostId = label.slice('remote:'.length);
    if (hostId.length > 0) return { kind: 'remote', hostId };
  }
  throw new Error(`invalid skill node: ${label}`);
}

/**
 * User-level skill root for a node.
 *
 * For a REMOTE node this is the literal `~/.claude/skills`, expanded by the
 * lite against ITS OWN home directory: main has no idea where the remote user's
 * home is (the `hello` frame carries `os`, not `homedir`). The lite's
 * `skillRoots` default is exactly `join(homedir(), '.claude/skills')`, so the
 * expanded path lands inside its allowlist.
 */
export const REMOTE_USER_SKILL_ROOT = '~/.claude/skills';

export function userSkillRoot(node: SkillNode): string {
  return node.kind === 'local' ? getClaudeSkillsDir() : REMOTE_USER_SKILL_ROOT;
}

/**
 * The local node's store. Allowlist is `~/.claude` (not `~/.claude/skills`) so
 * the project-level root `<project>/.claude/skills` can be resolved by the same
 * store when the project lives under the home directory.
 */
export function createLocalSkillStore(): SkillStore {
  return createSkillStore({ roots: [getClaudeHomePath()] });
}

/** The store for a node, given the registry for remote lookups. */
export function skillStoreForNode(
  node: SkillNode,
  getRegistry: () => RemoteAgentsRegistry,
): SkillStore {
  return node.kind === 'local'
    ? createLocalSkillStore()
    : createRemoteSkillStore(getRegistry, node.hostId);
}
