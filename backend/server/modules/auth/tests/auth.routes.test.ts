import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';

import authRouter from '../auth.routes.js';
import { authConfig, updateAuthCode } from '../auth.config.js';
import { signToken } from '../jwt.js';

/** Boots the router on an ephemeral port and runs `run(baseUrl)`. */
async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('login succeeds with the fixed email + code', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: authConfig.email, code: authConfig.code }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; user: { username: string } };
    assert.equal(body.user.username, authConfig.email);
    assert.equal(body.token.split('.').length, 3);
  });
});

test('login rejects a wrong code', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: authConfig.email, code: '000000' }),
    });
    assert.equal(res.status, 401);
  });
});

test('login rejects a wrong email', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', code: authConfig.code }),
    });
    assert.equal(res.status, 401);
  });
});

test('me returns the user for a valid token', async () => {
  await withServer(async (base) => {
    const token = signToken({ sub: 1, username: authConfig.email });
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: { username: string } };
    assert.equal(body.user.username, authConfig.email);
  });
});

test('me returns 401 for a missing token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 401);
  });
});

test('me returns 401 for a garbage token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    assert.equal(res.status, 401);
  });
});

const CONFIG_PATH = fileURLToPath(new URL('../auth.config.json', import.meta.url));

async function changePassword(base: string, opts: { token?: string; body: unknown }) {
  const { token, body } = opts;
  return fetch(`${base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('change-password updates the code when the current code matches', async () => {
  const original = authConfig.code;
  try {
    await withServer(async (base) => {
      const token = signToken({ sub: 1, username: authConfig.email });
      const res = await changePassword(base, { token, body: { currentCode: original, newCode: 'newcode123' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(authConfig.code, 'newcode123');
      const persisted = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { code: string };
      assert.equal(persisted.code, 'newcode123');
    });
  } finally {
    updateAuthCode(original);
  }
});

test('change-password rejects a wrong current code', async () => {
  await withServer(async (base) => {
    const token = signToken({ sub: 1, username: authConfig.email });
    const res = await changePassword(base, { token, body: { currentCode: '000000', newCode: 'whatever123' } });
    assert.equal(res.status, 401);
  });
});

test('change-password rejects a too-short new code', async () => {
  await withServer(async (base) => {
    const token = signToken({ sub: 1, username: authConfig.email });
    const res = await changePassword(base, { token, body: { currentCode: authConfig.code, newCode: 'ab' } });
    assert.equal(res.status, 400);
  });
});

test('change-password requires a valid token', async () => {
  await withServer(async (base) => {
    const res = await changePassword(base, { body: { currentCode: 'x', newCode: 'yyyy' } });
    assert.equal(res.status, 401);
  });
});

test('change-password returns 404 when auth is disabled (open mode)', async () => {
  const original = process.env.AUTH_ENABLED;
  try {
    process.env.AUTH_ENABLED = 'false';
    await withServer(async (base) => {
      const token = signToken({ sub: 1, username: authConfig.email });
      const res = await changePassword(base, { token, body: { currentCode: 'x', newCode: 'yyyy' } });
      assert.equal(res.status, 404);
    });
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});
