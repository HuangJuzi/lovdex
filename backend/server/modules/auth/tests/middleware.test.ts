import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticateToken, authenticateWebSocket, validateApiKey } from '@/middleware/auth.js';
import { signToken } from '@/modules/auth/jwt.js';

const EMAIL = 'zhiju.huang@sophgo.com';

// Middleware under test is JS (allowJs, checkJs off), so its params are `any`;
// these types exist only so the test file itself typechecks.
type MockReq = {
  headers: Record<string, string>;
  query: Record<string, unknown>;
  apiKeyValidated?: boolean;
  user?: { id: number | string; username: string };
};
type MockRes = {
  headers: Record<string, string>;
  status: (code: number) => { json: (body: unknown) => void };
  set: (name: string, value: string) => void;
};

function mockReq(): MockReq {
  return { headers: {}, query: {} };
}

function mockRes(): MockRes {
  const headers: Record<string, string> = {};
  return {
    headers,
    status: () => ({ json: () => undefined }),
    set: (name: string, value: string) => {
      headers[name] = value;
    },
  };
}

test('authenticateToken rejects a request with no token', async () => {
  const original = process.env.AUTH_ENABLED;
  process.env.AUTH_ENABLED = 'true';
  try {
    const req = mockReq();
    const res = mockRes();
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, false); // 401 path, next not called
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});

test('authenticateToken attaches req.user for a valid token and refreshes near expiry', async () => {
  const original = process.env.AUTH_ENABLED;
  process.env.AUTH_ENABLED = 'true';
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken({ sub: 1, username: EMAIL, iat: now - 3600, exp: now + 60 });
    const req = mockReq();
    req.headers = { authorization: `Bearer ${token}` };
    const res = mockRes();
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.user?.username, EMAIL);
    assert.ok(res.headers['X-Refreshed-Token'], 'near-expiry token should be refreshed');
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});

test('authenticateToken attaches LOCAL_USER when AUTH_ENABLED=false', async () => {
  const original = process.env.AUTH_ENABLED;
  process.env.AUTH_ENABLED = 'false';
  try {
    const req = mockReq();
    const res = mockRes();
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.user?.username, 'local');
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});

test('authenticateWebSocket returns null for a bad token and a user for a good one', () => {
  const original = process.env.AUTH_ENABLED;
  process.env.AUTH_ENABLED = 'true';
  try {
    assert.equal(authenticateWebSocket('garbage.token.here'), null);
    const token = signToken({ sub: 1, username: EMAIL });
    const user = authenticateWebSocket(token);
    assert.ok(user);
    assert.equal(user.username, EMAIL);
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});

test('authenticateWebSocket returns the local user when auth is disabled', () => {
  const original = process.env.AUTH_ENABLED;
  process.env.AUTH_ENABLED = 'false';
  try {
    const user = authenticateWebSocket(null);
    assert.ok(user);
    assert.equal(user.username, 'local');
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});

test('authenticateToken lets an API-key-authenticated request through without a JWT', async () => {
  const originalKey = process.env.API_KEY;
  const originalEnabled = process.env.AUTH_ENABLED;
  process.env.API_KEY = 'secret';
  process.env.AUTH_ENABLED = 'true';
  try {
    const req = mockReq();
    req.headers = { 'x-api-key': 'secret' };
    const res = mockRes();
    await new Promise<void>((resolve) => validateApiKey(req, res, () => resolve()));
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.user?.username, 'local');
  } finally {
    if (originalKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalKey;
    if (originalEnabled === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = originalEnabled;
  }
});

test('validateApiKey rejects a wrong API key', async () => {
  const originalKey = process.env.API_KEY;
  process.env.API_KEY = 'secret';
  try {
    const req = mockReq();
    req.headers = { 'x-api-key': 'wrong' };
    const res = mockRes();
    let called = false;
    validateApiKey(req, res, () => { called = true; });
    assert.equal(called, false);
  } finally {
    if (originalKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalKey;
  }
});
