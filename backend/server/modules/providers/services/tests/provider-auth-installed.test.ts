import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProviderAuthStatus } from '@/shared/types.js';

import {
  getInstalledProviders,
  resetInstalledProvidersCache,
  type InstalledProviderProbe,
} from '../provider-auth.service.js';

function statusOf(installed: boolean): ProviderAuthStatus {
  return { provider: 'claude', installed, authenticated: true, email: null, method: null };
}

test('getInstalledProviders probes each provider once and caches within the TTL', async () => {
  resetInstalledProvidersCache();
  const probed: string[] = [];
  const probe: InstalledProviderProbe = async (p) => {
    probed.push(p);
    return statusOf(p !== 'opencode');
  };

  const first = await getInstalledProviders(probe);
  assert.deepEqual(first, [
    { provider: 'claude', installed: true },
    { provider: 'codex', installed: true },
    { provider: 'opencode', installed: false },
    { provider: 'qoder', installed: true },
  ]);
  assert.deepEqual(probed, ['claude', 'codex', 'opencode', 'qoder']);

  // Second call inside the TTL serves the cache; the probe is NOT re-invoked.
  const second = await getInstalledProviders(async () => {
    throw new Error('must not be probed again');
  });
  assert.deepEqual(second, first);
  assert.equal(probed.length, 4);
});

test('getInstalledProviders is optimistic (installed true) when the probe throws', async () => {
  resetInstalledProvidersCache();
  const data = await getInstalledProviders(async () => {
    throw new Error('probe failed');
  });
  assert.deepEqual(data, [
    { provider: 'claude', installed: true },
    { provider: 'codex', installed: true },
    { provider: 'opencode', installed: true },
    { provider: 'qoder', installed: true },
  ]);
});

test('getInstalledProviders re-probes after the 60s TTL expires', async () => {
  resetInstalledProvidersCache();
  let calls = 0;
  const probe: InstalledProviderProbe = async () => {
    calls += 1;
    return statusOf(true);
  };

  await getInstalledProviders(probe);
  assert.equal(calls, 4);

  const originalNow = Date.now;
  Date.now = () => originalNow() + 61_000;
  try {
    await getInstalledProviders(probe);
    assert.equal(calls, 8, 'TTL expired → each provider probed again');
  } finally {
    Date.now = originalNow;
  }
});

test('getInstalledProviders dedupes concurrent cache misses into one probe pass', async () => {
  resetInstalledProvidersCache();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe: InstalledProviderProbe = async (p) => {
    calls += 1;
    await gate; // hold every probe until both callers have arrived
    return statusOf(true);
  };

  const p1 = getInstalledProviders(probe);
  const p2 = getInstalledProviders(probe);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.deepEqual(r1, r2);
  assert.equal(calls, 4, 'two concurrent callers share ONE 4-provider probe pass');
});