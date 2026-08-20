import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { refreshRemoteProjectsIndex } from '@/modules/remote-agents/remote-projects.index.js';
import { setRemoteAgentsRuntime } from '@/modules/remote-agents/runtime.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import providerRouter from '../provider.routes.js';
import { getInstalledProviders, resetInstalledProvidersCache } from '../services/provider-auth.service.js';

/**
 * The POST /api/providers/sessions install guard consults, in order:
 *   1. a remote host owning the project path (registry probe cache), or
 *   2. this host's installed providers (provider-auth.service, 60s TTL cache).
 * This harness isolates the DB, pre-seeds the module-level paths index / runtime
 * / install cache, and mounts the real provider router.
 */

function statusOf(installed: boolean): ProviderAuthStatus {
  return { provider: 'claude', installed, authenticated: true, email: null, method: null };
}

type Harness = {
  base: string;
  setHostProviders: (hostId: string, providers: unknown[]) => void;
  /** Re-probe fallback knobs: isOnline flag + what `providers/probe` returns. */
  setHostOnline: (online: boolean) => void;
  setProbeResult: (providers: unknown[]) => void;
  close: () => Promise<void>;
};

async function makeHarness(): Promise<Harness> {
  const dbDir = await mkdtemp(path.join(tmpdir(), 'lovdex-install-guard-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
  await initializeDatabase();

  const hostProviders = new Map<string, unknown[]>();
  let hostOnline = false;
  let probeResult: unknown[] = [];
  setRemoteAgentsRuntime({
    registry: {
      getHostProviders: (h: string) => hostProviders.get(h),
      setHostProviders: (h: string, p: unknown[]) => { hostProviders.set(h, p); },
      isOnline: () => hostOnline,
      rpc: async (_h: string, _m: string) => ({ providers: probeResult }),
    } as never,
    fsClient: {} as never,
    historyClient: {} as never,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(err) } });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    setHostProviders: (h, p) => hostProviders.set(h, p),
    setHostOnline: (online) => { hostOnline = online; },
    setProbeResult: (providers) => { probeResult = providers; },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeConnection();
      await rm(dbDir, { recursive: true, force: true });
    },
  };
}

async function createSession(base: string, provider: string, projectPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/providers/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, projectPath }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

test('remote project: provider absent from the host probe cache → 400 PROVIDER_NOT_INSTALLED', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([{ project_path: '/srv/remote-app', remote_host_id: 'h1' }]);
    h.setHostProviders('h1', [{ provider: 'claude', installed: true }]);

    // codex is NOT on the target host → rejected.
    const res = await createSession(h.base, 'codex', '/srv/remote-app');
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error?.code, 'PROVIDER_NOT_INSTALLED');
  } finally {
    await h.close();
  }
});

test('remote project: provider present in the host probe cache → 201', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([{ project_path: '/srv/remote-app', remote_host_id: 'h1' }]);
    h.setHostProviders('h1', [{ provider: 'claude', installed: true }]);

    const res = await createSession(h.base, 'claude', '/srv/remote-app');
    assert.equal(res.status, 201);
    assert.ok(typeof (res.body as { data?: { sessionId?: string } }).data?.sessionId === 'string');
  } finally {
    await h.close();
  }
});

test('remote project: probe entry with installed:false → 400 PROVIDER_NOT_INSTALLED', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([{ project_path: '/srv/remote-app', remote_host_id: 'h1' }]);
    // The lite probed this host and found the binary MISSING — the guard must
    // not treat a present-but-uninstalled entry as usable.
    h.setHostProviders('h1', [{ provider: 'codex', installed: false }]);

    const res = await createSession(h.base, 'codex', '/srv/remote-app');
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error?.code, 'PROVIDER_NOT_INSTALLED');
  } finally {
    await h.close();
  }
});

test('remote project: path with a trailing slash still resolves via normalizeProjectPath', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([{ project_path: '/srv/remote-app', remote_host_id: 'h1' }]);
    h.setHostProviders('h1', [{ provider: 'claude', installed: true }]);

    const res = await createSession(h.base, 'claude', '/srv/remote-app/');
    assert.equal(res.status, 201, 'trailing-slash path must match the indexed key space');
  } finally {
    await h.close();
  }
});

test('local target: uninstalled provider (seeded cache) → 400 PROVIDER_NOT_INSTALLED', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([]); // no path resolves to a remote host
    resetInstalledProvidersCache();
    await getInstalledProviders(async (p) => statusOf(p !== 'codex'));

    const res = await createSession(h.base, 'codex', '/local/app');
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error?.code, 'PROVIDER_NOT_INSTALLED');
  } finally {
    await h.close();
  }
});

test('local target: installed provider (seeded cache) → 201', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([]); // local path
    resetInstalledProvidersCache();
    await getInstalledProviders(async () => statusOf(true));

    const res = await createSession(h.base, 'claude', '/local/app');
    assert.equal(res.status, 201);
    assert.ok(typeof (res.body as { data?: { sessionId?: string } }).data?.sessionId === 'string');
  } finally {
    await h.close();
  }
});
test('remote project: online host with EMPTY probe cache re-probes and accepts installed provider → 201', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([{ project_path: '/srv/remote-app', remote_host_id: 'h1' }]);
    // A brief lite reconnect cleared the registry cache; the guard must NOT
    // misreport every provider as uninstalled for an ONLINE host.
    h.setHostProviders('h1', []);
    h.setHostOnline(true);
    h.setProbeResult([{ provider: 'claude', installed: true }]);

    const res = await createSession(h.base, 'claude', '/srv/remote-app');
    assert.equal(res.status, 201);
    assert.ok(typeof (res.body as { data?: { sessionId?: string } }).data?.sessionId === 'string');
  } finally {
    await h.close();
  }
});

test('remote project: offline host with EMPTY cache does not re-probe → 400 PROVIDER_NOT_INSTALLED', async () => {
  const h = await makeHarness();
  try {
    refreshRemoteProjectsIndex([{ project_path: '/srv/remote-app', remote_host_id: 'h1' }]);
    h.setHostProviders('h1', []);
    h.setHostOnline(false);
    h.setProbeResult([{ provider: 'claude', installed: true }]);

    const res = await createSession(h.base, 'claude', '/srv/remote-app');
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error?.code, 'PROVIDER_NOT_INSTALLED');
  } finally {
    await h.close();
  }
});
