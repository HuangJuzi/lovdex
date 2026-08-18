import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket } from 'ws';

import { AppError } from '@/shared/utils.js';

import type { BootstrapInput, BootstrapResult } from '../bootstrap.service.js';
import { createRemoteAgentsRegistry, type RemoteAgentsRegistry } from '../remote-agents.registry.js';
import type { RemoteFsClient } from '../remote-fs.service.js';
import { createRemoteHostsDb, type RemoteHostsRepository } from '../remote-host.db.js';
import { createRemoteAgentsRouter, type RemoteAgentsRouterDeps } from '../remote-agents.routes.js';

// Minimal projects table so the remote hosts repo (which joins projects for
// findHostForProjectPath) can be created against :memory: without error.
const PROJECTS_DDL =
  'CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY NOT NULL, project_path TEXT NOT NULL UNIQUE, remote_host_id TEXT)';

/** A fake open WebSocket the registry treats as live for isOnline/rpc. */
function fakeOpenWs(): WebSocket {
  return { readyState: WebSocket.OPEN, close() {} } as unknown as WebSocket;
}

type StubFsClient = RemoteFsClient & { listCalls: { hostId: string; path: string }[] };

function stubFsClient(dirs: { name: string; type: 'dir' | 'file' | 'symlink'; size: number | null }[]): StubFsClient {
  const listCalls: { hostId: string; path: string }[] = [];
  return {
    listCalls,
    async stat() {
      throw new Error('not used');
    },
    async list(hostId: string, pathText: string) {
      listCalls.push({ hostId, path: pathText });
      return dirs;
    },
    async read() {
      throw new Error('not used');
    },
  };
}

type Harness = {
  base: string;
  repo: RemoteHostsRepository;
  registry: RemoteAgentsRegistry;
  db: Database.Database;
  tokenForCalls: string[];
  bootstrapCalls: BootstrapInput[];
  close: () => Promise<void>;
};

async function makeHarness(
  overrides: Partial<RemoteAgentsRouterDeps> & {
    fsClient?: RemoteFsClient;
    bootstrapImpl?: (input: BootstrapInput) => Promise<BootstrapResult>;
  } = {},
): Promise<Harness> {
  const db = new Database(':memory:');
  db.exec(PROJECTS_DDL);
  const repo = createRemoteHostsDb(db);
  const registry = createRemoteAgentsRegistry();

  const tokenForCalls: string[] = [];
  const bootstrapCalls: BootstrapInput[] = [];

  const deps: RemoteAgentsRouterDeps = {
    repo,
    registry,
    fsClient: overrides.fsClient ?? stubFsClient([]),
    publicKey: overrides.publicKey ?? 'ssh-ed25519 AAAA-test-key lovdex',
    tokenFor:
      overrides.tokenFor ??
      ((hostId: string) => {
        tokenForCalls.push(hostId);
        return `token-${hostId}`;
      }),
    bootstrap:
      overrides.bootstrap ??
      (async (input: BootstrapInput) => {
        bootstrapCalls.push(input);
        if (overrides.bootstrapImpl) return overrides.bootstrapImpl(input);
        return { status: 'online', message: 'deployed', hostId: input.hostId };
      }),
    identityFile: overrides.identityFile ?? '/home/lovdex/.ssh/id_ed25519',
    serverUrl: overrides.serverUrl ?? 'ws://main:4000/api/remote-agents/ws',
  };

  const app = express();
  app.use(express.json());
  app.use('/api/remote-agents', createRemoteAgentsRouter(deps));
  // Mirror the app-level error middleware so AppError statusCodes surface.
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
    repo,
    registry,
    db,
    tokenForCalls,
    bootstrapCalls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

test('GET / lists hosts with an online flag from the registry', async () => {
  const h = await makeHarness();
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
    h.repo.create({ host_id: 'h2', name: 'dev2', host: '10.0.0.6', ssh_user: 'root' });
    // Register h1 as online in the registry.
    h.registry.register({ hostId: 'h1', roots: ['/home/root'], capabilities: [] }, fakeOpenWs());

    const res = await fetch(`${h.base}/api/remote-agents/`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { hosts: { host_id: string; online: boolean }[] } };
    const byId = Object.fromEntries(body.data.hosts.map((host) => [host.host_id, host.online]));
    assert.equal(byId.h1, true);
    assert.equal(byId.h2, false);
  } finally {
    await h.close();
  }
});

test('GET /pubkey returns the configured public key', async () => {
  const h = await makeHarness({ publicKey: 'ssh-ed25519 AAAA-pubkey lovdex' });
  try {
    const res = await fetch(`${h.base}/api/remote-agents/pubkey`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { publicKey: string } };
    assert.equal(body.data.publicKey, 'ssh-ed25519 AAAA-pubkey lovdex');
  } finally {
    await h.close();
  }
});

test('POST / adds a host, persists it, and returns a hostId', async () => {
  const h = await makeHarness();
  try {
    const res = await fetch(`${h.base}/api/remote-agents/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dev1', host: '10.0.0.5', sshUser: 'root', port: 2222 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { hostId: string } };
    assert.ok(body.data.hostId);

    const row = h.repo.getById(body.data.hostId);
    assert.equal(row?.name, 'dev1');
    assert.equal(row?.host, '10.0.0.5');
    assert.equal(row?.port, 2222);
    // tokenFor was invoked for the new host (writes the token hash).
    assert.deepEqual(h.tokenForCalls, [body.data.hostId]);
  } finally {
    await h.close();
  }
});

test('POST / rejects missing required fields with 400', async () => {
  const h = await makeHarness();
  try {
    const res = await fetch(`${h.base}/api/remote-agents/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dev1' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('POST / with authType password → 400 REMOTE_PASSWORD_UNSUPPORTED', async () => {
  const h = await makeHarness();
  try {
    const res = await fetch(`${h.base}/api/remote-agents/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dev1', host: '10.0.0.5', sshUser: 'root', authType: 'password' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'REMOTE_PASSWORD_UNSUPPORTED');
  } finally {
    await h.close();
  }
});

test('POST /:id/deploy happy path → status online and repo status updated', async () => {
  const h = await makeHarness({
    bootstrapImpl: async (input) => ({ status: 'online', message: 'deployed', hostId: input.hostId }),
  });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });

    const res = await fetch(`${h.base}/api/remote-agents/h1/deploy`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { status: string; hostId: string } };
    assert.equal(body.data.status, 'online');
    assert.equal(h.repo.getById('h1')?.status, 'online');

    // bootstrap received the host connection details + Lovdex identity/token/server.
    assert.equal(h.bootstrapCalls.length, 1);
    const call = h.bootstrapCalls[0];
    assert.equal(call.host, '10.0.0.5');
    assert.equal(call.sshUser, 'root');
    assert.equal(call.hostId, 'h1');
    assert.equal(call.token, 'token-h1');
    assert.equal(call.serverUrl, 'ws://main:4000/api/remote-agents/ws');
    assert.ok(Array.isArray(call.roots) && call.roots.length >= 1, 'roots must have a placeholder');
  } finally {
    await h.close();
  }
});

test('POST /:id/deploy for a missing host → 404 REMOTE_HOST_NOT_FOUND', async () => {
  const h = await makeHarness();
  try {
    const res = await fetch(`${h.base}/api/remote-agents/nope/deploy`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'REMOTE_HOST_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('POST /:id/deploy bootstrap failure → repo status error + 502', async () => {
  const h = await makeHarness({
    bootstrapImpl: async () => {
      throw new Error('ssh exploded');
    },
  });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });

    const res = await fetch(`${h.base}/api/remote-agents/h1/deploy`, { method: 'POST' });
    assert.equal(res.status, 502);
    assert.equal(h.repo.getById('h1')?.status, 'error');
  } finally {
    await h.close();
  }
});

test('POST /:id/deploy where bootstrap returns error status → repo status error', async () => {
  const h = await makeHarness({
    bootstrapImpl: async (input) => ({ status: 'error', message: 'node missing', hostId: input.hostId }),
  });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });

    const res = await fetch(`${h.base}/api/remote-agents/h1/deploy`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { status: string; message?: string } };
    assert.equal(body.data.status, 'error');
    const row = h.repo.getById('h1');
    assert.equal(row?.status, 'error');
    assert.equal(row?.last_error, 'node missing');
  } finally {
    await h.close();
  }
});

test('GET /:id/dirs on an offline host → 409 REMOTE_HOST_OFFLINE', async () => {
  const h = await makeHarness();
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });

    const res = await fetch(`${h.base}/api/remote-agents/h1/dirs?path=/srv`);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'REMOTE_HOST_OFFLINE');
  } finally {
    await h.close();
  }
});

test('GET /:id/dirs on an online host → returns stub dirs', async () => {
  const dirs = [
    { name: 'app', type: 'dir' as const, size: null },
    { name: 'README.md', type: 'file' as const, size: 12 },
  ];
  const fs = stubFsClient(dirs);
  const h = await makeHarness({ fsClient: fs });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
    h.registry.register({ hostId: 'h1', roots: ['/home/root'], capabilities: [] }, fakeOpenWs());

    const res = await fetch(`${h.base}/api/remote-agents/h1/dirs?path=/srv`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { dirs: typeof dirs } };
    assert.deepEqual(body.data.dirs, dirs);
    assert.deepEqual(fs.listCalls, [{ hostId: 'h1', path: '/srv' }]);
  } finally {
    await h.close();
  }
});

test('GET /:id/dirs on an online host with no path defaults to ~', async () => {
  const fs = stubFsClient([]);
  const h = await makeHarness({ fsClient: fs });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
    h.registry.register({ hostId: 'h1', roots: ['/home/root'], capabilities: [] }, fakeOpenWs());

    const res = await fetch(`${h.base}/api/remote-agents/h1/dirs`);
    assert.equal(res.status, 200);
    assert.deepEqual(fs.listCalls, [{ hostId: 'h1', path: '~' }]);
  } finally {
    await h.close();
  }
});

test('GET /:id/dirs on a missing host → 404', async () => {
  const h = await makeHarness();
  try {
    const res = await fetch(`${h.base}/api/remote-agents/nope/dirs`);
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('DELETE /:id removes the host row and clears its registry session bindings', async () => {
  const h = await makeHarness();
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
    const ws = fakeOpenWs();
    h.registry.register({ hostId: 'h1', roots: ['/home/root'], capabilities: [] }, ws);
    // A session bound to this host must not linger after the host is deleted.
    h.registry.setSessionHost('app-session-1', null, 'h1');
    assert.equal(h.registry.getSessionHost('app-session-1')?.hostId, 'h1');

    const res = await fetch(`${h.base}/api/remote-agents/h1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { removed: boolean } };
    assert.equal(body.data.removed, true);
    assert.equal(h.repo.getById('h1'), null);
    assert.equal(h.registry.getSessionHost('app-session-1'), undefined);
  } finally {
    await h.close();
  }
});
