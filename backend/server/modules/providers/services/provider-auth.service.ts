import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.auth.getStatus();
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};

/**
 * Probe function for one provider's install status. Injectable so tests can
 * drive {@link getInstalledProviders} deterministically without spawning CLIs.
 */
export type InstalledProviderProbe = (providerName: string) => Promise<ProviderAuthStatus>;

const ALL_INSTALLED_PROVIDERS = ['claude', 'codex', 'opencode', 'qoder'] as const;
const INSTALLED_TTL_MS = 60_000;

let installedCache: { at: number; data: { provider: string; installed: boolean }[] } | null = null;

/** Resets the module-level install cache (test hook). */
export function resetInstalledProvidersCache(): void {
  installedCache = null;
}

/**
 * Lists install status for every supported provider, with a 60s TTL cache so
 * the per-request `spawn.sync` probes (one per provider) only run once per
 * minute. A status lookup failure reports `installed: true` (optimistic,
 * mirroring {@link providerAuthService.isProviderInstalled}) so a transient
 * probe error never hides a provider that is actually usable.
 */
export async function getInstalledProviders(
  probe: InstalledProviderProbe = (p) => providerAuthService.getProviderAuthStatus(p),
): Promise<{ provider: string; installed: boolean }[]> {
  if (installedCache && Date.now() - installedCache.at < INSTALLED_TTL_MS) {
    return installedCache.data;
  }
  const data = await Promise.all(
    ALL_INSTALLED_PROVIDERS.map(async (p) => {
      try {
        const status = await probe(p);
        return { provider: p, installed: status.installed !== false };
      } catch {
        return { provider: p, installed: true };
      }
    }),
  );
  installedCache = { at: Date.now(), data };
  return data;
}
