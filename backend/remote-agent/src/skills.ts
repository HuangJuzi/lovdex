import { createSkillStore, type SkillStore } from '../../server/shared/skill-store.js';
import { skillRootsOf, type RemoteAgentConfig } from './config.js';

/**
 * The lite's skill store: the SHARED implementation, scoped to this host's
 * allowlist (project roots + the dedicated skill roots).
 *
 * Deliberately thin — the main server's local node calls the exact same
 * `createSkillStore`, so a skill written here and one written there are
 * indistinguishable by construction. There is no lite-specific write logic to
 * drift out of sync.
 */
let cachedKey: string | null = null;
let cached: SkillStore | null = null;

export function skillStoreFor(cfg: RemoteAgentConfig): SkillStore {
  const roots = skillRootsOf(cfg);
  const key = roots.join('\0');
  if (cachedKey !== null && cachedKey === key && cached !== null) return cached;
  cachedKey = key;
  cached = createSkillStore({ roots });
  return cached;
}

/** TEST SEAM ONLY — drop the memoized store so a test with different roots
 * builds a fresh one. Double underscore marks it test-only. */
export function __resetSkillStoreForTests(): void {
  cachedKey = null;
  cached = null;
}
