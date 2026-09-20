import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createSkillSyncRouter } from '../skill-sync.routes.js';
import type { SkillSyncService } from '../skill-sync.service.js';

function fakeService(overrides: Partial<SkillSyncService> = {}): SkillSyncService {
  return {
    resolveRoot: () => '/x',
    plan: async (req) => ({
      planId: 'p1',
      from: req.from,
      to: req.to,
      scope: req.scope,
      fromRoot: '/from',
      toRoot: '/to',
      entries: [],
      summary: { create: 0, update: 0, same: 0, onlyTarget: 0 },
      createdAt: 1,
    }),
    takePlan: () => null,
    apply: async (req) => ({
      planId: req.planId,
      from: { kind: 'local' },
      to: { kind: 'local' },
      entries: [],
      summary: { ok: 0, failed: 0, conflict: 0, skipped: 0 },
    }),
    ...overrides,
  };
}

async function withServer(
  deps: Parameters<typeof createSkillSyncRouter>[0],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/skills', createSkillSyncRouter(deps));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Mirrors the production handler in server/index.js: an AppError carries its
    // own status + message through to the client, while a bare Error is
    // flattened into an opaque 500. Using the same shape here is what makes
    // these tests able to catch a regression where an actionable error (offline
    // host, lite needs deploying, expired preview) loses its message.
    if (err instanceof AppError) {
      return res
        .status(err.statusCode)
        .json({ success: false, error: { code: err.code, message: err.message } });
    }
    return res
      .status(500)
      .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/api/skills`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const DEPS = {
  getRegistry: () => ({}) as never,
  listNodes: () => [
    { label: 'local', name: '本机', online: true },
    { label: 'remote:h1', name: 'dev1', online: true },
    { label: 'remote:h2', name: 'dev2', online: false, reason: '离线' },
  ],
};

test('GET /nodes lists local plus every registered remote host', async () => {
  await withServer({ ...DEPS, service: fakeService() }, async (base) => {
    const res = await fetch(`${base}/nodes`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { nodes: { label: string; online: boolean }[] };
    assert.deepEqual(body.nodes.map((n) => n.label), ['local', 'remote:h1', 'remote:h2']);
    assert.equal(body.nodes[2].online, false);
  });
});

test('POST /sync/plan parses the node labels into SkillNode values', async () => {
  let seen: unknown = null;
  const service = fakeService({
    plan: async (req) => {
      seen = req;
      return fakeService().plan(req);
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'local', to: 'remote:h1', scope: 'user' }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, { from: { kind: 'local' }, to: { kind: 'remote', hostId: 'h1' }, scope: 'user' });
});

test('POST /sync/plan rejects an invalid node label', async () => {
  await withServer({ ...DEPS, service: fakeService() }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'nope', to: 'local', scope: 'user' }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /invalid skill node/);
  });
});

test('POST /sync/plan rejects an unknown scope', async () => {
  await withServer({ ...DEPS, service: fakeService() }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'local', to: 'local', scope: 'galaxy' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /sync/apply forwards planId / names / force and tags the actor as user', async () => {
  let seen: unknown = null;
  const service = fakeService({
    apply: async (req) => {
      seen = req;
      return fakeService().apply(req);
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'p1', names: ['demo'], force: true }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, { planId: 'p1', names: ['demo'], force: true, actor: 'user' });
});

test('POST /sync/apply surfaces an expired plan as 400', async () => {
  const service = fakeService({
    apply: async () => {
      throw new Error('plan not found or expired');
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'gone' }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /plan not found or expired/);
  });
});

test('GET /manifest parses the node label and forwards scope/projectId', async () => {
  let seen: unknown = null;
  const manifest = async (node: unknown, scope: unknown, projectId: unknown) => {
    seen = { node, scope, projectId };
    return { root: '/x', exists: true, entries: [] };
  };
  await withServer({ ...DEPS, service: fakeService(), manifest: manifest as never }, async (base) => {
    const res = await fetch(`${base}/manifest?node=remote:h1&scope=project&projectId=7`);
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, { node: { kind: 'remote', hostId: 'h1' }, scope: 'project', projectId: 7 });
});

// Regression guards for the message-preservation contract. Before these, an
// offline host or an un-upgraded lite surfaced to the UI as a bare
// "Internal server error" — the exact opposite of what the capability gate and
// the offline check exist to communicate.

test('an offline host surfaces its actionable message as a 400', async () => {
  const service = fakeService({
    plan: async () => {
      throw new Error('远程主机 h1 不在线');
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'local', to: 'remote:h1', scope: 'user' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { message: string } }).error.message, '远程主机 h1 不在线');
  });
});

test('a lite without the skills capability surfaces the deploy hint as a 400', async () => {
  const service = fakeService({
    plan: async () => {
      throw new Error('目标主机 lite 版本过旧（缺少 skills/v1），请先 deploy 升级');
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'local', to: 'remote:h1', scope: 'user' }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /请先 deploy 升级/);
  });
});

test('a GET /manifest failure is also surfaced rather than flattened', async () => {
  const manifest = async () => {
    throw new Error('path outside allowed root');
  };
  await withServer({ ...DEPS, service: fakeService(), manifest: manifest as never }, async (base) => {
    const res = await fetch(`${base}/manifest?node=local&scope=user`);
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: { message: string } }).error.message,
      'path outside allowed root',
    );
  });
});
