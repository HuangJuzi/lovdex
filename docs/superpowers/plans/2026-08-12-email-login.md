# 邮箱 + 验证码登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Lovdex 加一个后端强制拦截的登录门槛——固定邮箱 `zhiju.huang@sophgo.com` + 固定验证码 `888888` 登录,签发 HS256 JWT(默认密钥 `lovdex@2026`),登录一次后前端免登录,未登录的 HTTP 一律 401、WebSocket 拒绝连接。

**Architecture:** 后端在 `server/modules/auth/` 新增配置 + 手写 HS256 JWT 工具 + 登录/校验路由;`middleware/auth.js` 从「无条件合成 local 用户」改为「校验 JWT(header 或 `?token=`)+ 滑动续期」,`AUTH_ENABLED=false` 是回退安全阀。前端新增 `AuthGate`(登录态编排)+ `LoginPage`,token 存既有 `localStorage['auth-token']`,WS URL 追加 `?token=`。

**Tech Stack:** Node.js ESM + Express 4 + ws(better-sqlite3 库已存在但本功能不写 DB);React 18 + react-router-dom 6 + i18next;node:test + tsx 跑测试。

**Spec:** `docs/superpowers/specs/2026-08-12-email-login-design.md`

**仓库布局:** 两个独立 git 仓库。后端在 `lovdex-backend/`,前端在 `lovdex-cli/`。`docs/` 不在 git。每个任务末尾的 commit 只在**当前任务的仓库**执行。

---

## 后端任务

### Task 1:Auth 配置模块(`auth.config.ts`)

**Files:**
- Create: `lovdex-backend/server/modules/auth/auth.config.ts`
- Test: `lovdex-backend/server/modules/auth/tests/auth-config.test.ts`

- [ ] **Step 1:写失败测试**

```ts
// lovdex-backend/server/modules/auth/tests/auth-config.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { authConfig, isAuthEnabled } from '../auth.config.js';

test('authConfig defaults match the fixed login credentials', () => {
  assert.equal(authConfig.email, 'zhiju.huang@sophgo.com');
  assert.equal(authConfig.code, '888888');
  assert.equal(authConfig.jwtSecret, 'lovdex@2026');
  assert.equal(authConfig.expiresInSeconds, 7 * 24 * 60 * 60);
  assert.equal(authConfig.refreshWindowSeconds, 24 * 60 * 60);
});

test('isAuthEnabled is true by default and false when AUTH_ENABLED=false', () => {
  const original = process.env.AUTH_ENABLED;
  try {
    delete process.env.AUTH_ENABLED;
    assert.equal(isAuthEnabled(), true);
    process.env.AUTH_ENABLED = 'false';
    assert.equal(isAuthEnabled(), false);
    process.env.AUTH_ENABLED = 'true';
    assert.equal(isAuthEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});
```

- [ ] **Step 2:跑测试确认失败**

Run(在 `lovdex-backend/` 目录):
```bash
npx tsx --test server/modules/auth/tests/auth-config.test.ts
```
Expected:报 `Cannot find module '../auth.config.js'`。

- [ ] **Step 3:实现 `auth.config.ts`**

```ts
// lovdex-backend/server/modules/auth/auth.config.ts
/**
 * Auth gate configuration. All knobs are code constants with env overrides —
 * nothing lives in the database, so the login path stays DB-independent.
 * AUTH_ENABLED=false is the escape hatch that reverts to the open no-login
 * mode (see middleware/auth.js).
 */

import { IS_PLATFORM } from '@/constants/config.js';

export const authConfig = {
  /** Allowed login email. */
  email: process.env.AUTH_EMAIL || 'zhiju.huang@sophgo.com',
  /** Fixed verification code. */
  code: process.env.AUTH_CODE || '888888',
  /** HS256 signing key. */
  jwtSecret: process.env.JWT_SECRET || 'lovdex@2026',
  /** Token lifetime: 7 days. */
  expiresInSeconds: 7 * 24 * 60 * 60,
  /** When a token has this much (or less) life left, re-issue on the next request. */
  refreshWindowSeconds: 24 * 60 * 60,
};

/**
 * Whether HTTP/WS auth enforcement is active. Reads env at call time so the
 * AUTH_ENABLED switch takes effect per-request (testable). Platform mode keeps
 * its own auth flow and is exempt.
 */
export const isAuthEnabled = (): boolean =>
  !IS_PLATFORM && process.env.AUTH_ENABLED !== 'false';
```

- [ ] **Step 4:跑测试确认通过**

Run:`npx tsx --test server/modules/auth/tests/auth-config.test.ts`
Expected:`# pass 2`、`# fail 0`。

- [ ] **Step 5:Commit(在 lovdex-backend)**

```bash
git add server/modules/auth/auth.config.ts server/modules/auth/tests/auth-config.test.ts
git commit -m "feat(auth): add login gate config (fixed email/code, JWT secret, AUTH_ENABLED)"
```

---

### Task 2:JWT 工具(`jwt.ts`)

**Files:**
- Create: `lovdex-backend/server/modules/auth/jwt.ts`
- Test: `lovdex-backend/server/modules/auth/tests/jwt.test.ts`

- [ ] **Step 1:写失败测试**

```ts
// lovdex-backend/server/modules/auth/tests/jwt.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTokenFromRequest, signToken, verifyToken } from '../jwt.js';

const EMAIL = 'zhiju.huang@sophgo.com';

test('signToken returns a three-segment JWT', () => {
  const token = signToken({ sub: 1, username: EMAIL });
  assert.equal(token.split('.').length, 3);
});

test('verifyToken returns the payload for a freshly signed token', () => {
  const token = signToken({ sub: 1, username: EMAIL });
  const payload = verifyToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, 1);
  assert.equal(payload.username, EMAIL);
  assert.ok(payload.exp >= payload.iat);
});

test('verifyToken rejects a tampered token', () => {
  const token = signToken({ sub: 1, username: EMAIL });
  const [header, body] = token.split('.');
  assert.equal(verifyToken(`${header}.${body}.AAAA`), null);
});

test('verifyToken rejects an expired token', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signToken({ sub: 1, username: EMAIL, iat: now - 100, exp: now - 10 });
  assert.equal(verifyToken(token), null);
});

test('extractTokenFromRequest reads Authorization Bearer first', () => {
  const req = { headers: { authorization: 'Bearer abc.def.ghi' }, query: { token: 'query-token' } };
  assert.equal(extractTokenFromRequest(req), 'abc.def.ghi');
});

test('extractTokenFromRequest falls back to the ?token= query param', () => {
  const req = { headers: {}, query: { token: 'query-token' } };
  assert.equal(extractTokenFromRequest(req), 'query-token');
});

test('extractTokenFromRequest returns null when neither is present', () => {
  const req = { headers: {}, query: {} };
  assert.equal(extractTokenFromRequest(req), null);
});
```

- [ ] **Step 2:跑测试确认失败**

Run:`npx tsx --test server/modules/auth/tests/jwt.test.ts`
Expected:报 `Cannot find module '../jwt.js'`。

- [ ] **Step 3:实现 `jwt.ts`**

```ts
// lovdex-backend/server/modules/auth/jwt.ts
/**
 * Minimal HS256 JWT sign/verify built on node:crypto — no jsonwebtoken dep.
 *
 * The frontend holds the token in localStorage and sends it as
 * `Authorization: Bearer` (or `?token=` for EventSource/SSE, which cannot set
 * headers). Stateless: verification only needs the shared secret, never a DB
 * lookup.
 */

import crypto from 'node:crypto';

import { authConfig } from './auth.config.js';

export type AuthTokenPayload = {
  sub: number | string;
  username: string;
  iat: number;
  exp: number;
};

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

export function signToken(
  payload: Pick<AuthTokenPayload, 'sub' | 'username'> & { iat?: number; exp?: number }
): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = payload.iat ?? now;
  const exp = payload.exp ?? iat + authConfig.expiresInSeconds;
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ sub: payload.sub, username: payload.username, iat, exp }));
  const signature = crypto
    .createHmac('sha256', authConfig.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string): AuthTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, body, signature] = parts;
  const expected = crypto
    .createHmac('sha256', authConfig.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthTokenPayload;
    if (typeof payload.sub !== 'number' && typeof payload.sub !== 'string') {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Reads the bearer token from an HTTP request. EventSource/SSE requests cannot
 * set headers, so the frontend passes `?token=` as a fallback.
 */
export function extractTokenFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}): string | null {
  const authHeader = req.headers['authorization'];
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  return bearer ?? queryToken;
}
```

- [ ] **Step 4:跑测试确认通过**

Run:`npx tsx --test server/modules/auth/tests/jwt.test.ts`
Expected:`# pass 7`、`# fail 0`。

- [ ] **Step 5:Commit**

```bash
git add server/modules/auth/jwt.ts server/modules/auth/tests/jwt.test.ts
git commit -m "feat(auth): add minimal HS256 JWT sign/verify + token extraction"
```

---

### Task 3:登录/校验路由(`auth.routes.ts`)

**Files:**
- Create: `lovdex-backend/server/modules/auth/auth.routes.ts`
- Test: `lovdex-backend/server/modules/auth/tests/auth.routes.test.ts`

- [ ] **Step 1:写失败测试**

```ts
// lovdex-backend/server/modules/auth/tests/auth.routes.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';

import authRouter from '../auth.routes.js';
import { authConfig } from '../auth.config.js';
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
```

- [ ] **Step 2:跑测试确认失败**

Run:`npx tsx --test server/modules/auth/tests/auth.routes.test.ts`
Expected:报 `Cannot find module '../auth.routes.js'`。

- [ ] **Step 3:实现 `auth.routes.ts`**

```ts
// lovdex-backend/server/modules/auth/auth.routes.ts
import express from 'express';

import { authConfig } from './auth.config.js';
import { extractTokenFromRequest, signToken, verifyToken } from './jwt.js';

const router = express.Router();

const USER = Object.freeze({ id: 1, username: authConfig.email });

// Public login: fixed email + fixed verification code → JWT. No DB writes.
router.post('/login', (req, res) => {
  const { email, code } = (req.body ?? {}) as { email?: unknown; code?: unknown };
  if (
    typeof email !== 'string' ||
    typeof code !== 'string' ||
    email !== authConfig.email ||
    code !== authConfig.code
  ) {
    return res.status(401).json({ error: '邮箱或验证码不正确' });
  }
  const token = signToken({ sub: USER.id, username: USER.username });
  res.json({ token, user: USER });
});

// Public token validation — the frontend boot-checks a stored token here.
router.get('/me', (req, res) => {
  const token = extractTokenFromRequest(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  res.json({ user: { id: payload.sub, username: payload.username } });
});

export default router;
```

- [ ] **Step 4:跑测试确认通过**

Run:`npx tsx --test server/modules/auth/tests/auth.routes.test.ts`
Expected:`# pass 6`、`# fail 0`。

- [ ] **Step 5:Commit**

```bash
git add server/modules/auth/auth.routes.ts server/modules/auth/tests/auth.routes.test.ts
git commit -m "feat(auth): add POST /api/auth/login and GET /api/auth/me routes"
```

---

### Task 4:中间件强制拦截(`middleware/auth.js`)

**Files:**
- Modify: `lovdex-backend/server/middleware/auth.js`(整体重写)
- Test: `lovdex-backend/server/modules/auth/tests/middleware.test.ts`

- [ ] **Step 1:写失败测试**

```ts
// lovdex-backend/server/modules/auth/tests/middleware.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticateToken, authenticateWebSocket } from '@/middleware/auth.js';
import { authConfig } from '@/modules/auth/auth.config.js';
import { signToken } from '@/modules/auth/jwt.js';

const EMAIL = 'zhiju.huang@sophgo.com';

// Middleware under test is JS (allowJs, checkJs off), so its params are `any`;
// these types exist only so the test file itself typechecks.
type MockReq = {
  headers: Record<string, string>;
  query: Record<string, unknown>;
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
```

- [ ] **Step 2:跑测试确认失败**

Run:`npx tsx --test server/modules/auth/tests/middleware.test.ts`
Expected:当前 `authenticateToken` 直接挂 LOCAL_USER 并调用 next,所以「无 token 时 next 不被调用」这条会 **fail**(`called` 为 true)。

- [ ] **Step 3:重写 `middleware/auth.js`**

```js
// OSS self-hosted build: authentication is enforced by default. Requests must
// carry a JWT issued by POST /api/auth/login — as `Authorization: Bearer`, or
// `?token=` for EventSource/SSE which cannot set headers. Set AUTH_ENABLED=false
// to restore the open internal-only mode (every request is a synthetic local
// user). Platform mode keeps its own auth flow and is exempt.

import { authConfig, isAuthEnabled } from '@/modules/auth/auth.config.js';
import { extractTokenFromRequest, signToken, verifyToken } from '@/modules/auth/jwt.js';

const LOCAL_USER = Object.freeze({ id: 1, username: 'local' });

// Optional API key middleware (still honored when API_KEY env is set).
const validateApiKey = (req, res, next) => {
  if (!process.env.API_KEY) {
    return next();
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// Sliding refresh: when the token still has <= refreshWindowSeconds left, issue
// a fresh one in X-Refreshed-Token (the frontend stores it automatically).
const maybeRefreshToken = (res, payload) => {
  const now = Math.floor(Date.now() / 1000);
  const remaining = payload.exp - now;
  if (remaining > 0 && remaining <= authConfig.refreshWindowSeconds) {
    res.set('X-Refreshed-Token', signToken({ sub: payload.sub, username: payload.username }));
  }
};

const authenticateToken = async (req, res, next) => {
  if (!isAuthEnabled()) {
    req.user = LOCAL_USER;
    return next();
  }
  const token = extractTokenFromRequest(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.user = { id: payload.sub, username: payload.username };
  maybeRefreshToken(res, payload);
  next();
};

// WebSocket auth: verify ?token= or Authorization header; null rejects the upgrade.
const authenticateWebSocket = (token) => {
  if (!isAuthEnabled()) {
    return { id: 1, userId: 1, username: 'local' };
  }
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return null;
  }
  return { id: payload.sub, userId: payload.sub, username: payload.username };
};

export { validateApiKey, authenticateToken, authenticateWebSocket };
```

> 注意:删掉了旧的 `generateToken` 与 `JWT_SECRET` 导出(grep 确认无外部引用),`appConfigDb` 导入一并移除(JWT 密钥改走 `auth.config.ts`)。

- [ ] **Step 4:跑测试确认通过**

Run:`npx tsx --test server/modules/auth/tests/middleware.test.ts`
Expected:`# pass 5`、`# fail 0`。

- [ ] **Step 5:跑全部 auth 测试,确认无回归**

Run:`npx tsx --test server/modules/auth/tests/*.test.ts`
Expected:全部 pass。

- [ ] **Step 6:Commit**

```bash
git add server/middleware/auth.js server/modules/auth/tests/middleware.test.ts
git commit -m "feat(auth): enforce JWT in authenticateToken/authenticateWebSocket with sliding refresh"
```

---

### Task 5:挂载路由 + 文档(`index.js` / `.env.example`)

**Files:**
- Modify: `lovdex-backend/server/index.js`(两处)
- Modify: `lovdex-backend/.env.example`

- [ ] **Step 1:index.js 增加 import**

在现有 import 块(约第 42 行 `import userRoutes from './routes/user.js';` 附近)加一行:

```js
import authRoutes from './modules/auth/auth.routes.js';
```

- [ ] **Step 2:index.js 挂载路由**

在 `app.use('/api', validateApiKey);`(第 159 行)之后、`app.use('/api/projects', ...)` 之前插入:

```js
// Auth routes (public login + token validation). Mounted under /api so the
// API-key check above still applies; login/me themselves require no token.
app.use('/api/auth', authRoutes);
```

- [ ] **Step 3:.env.example 增加 AUTH 配置段**

在 `# DATABASE` 段之后插入:

```
# =============================================================================
# AUTH (email + verification code login gate)
# =============================================================================
# Set AUTH_ENABLED=false to revert to the open no-login mode (safety valve).
# Default true.
# AUTH_ENABLED=true
# Allowed login email / fixed verification code / HS256 signing key.
# Defaults: email=zhiju.huang@sophgo.com, code=888888, key=lovdex@2026
# AUTH_EMAIL=zhiju.huang@sophgo.com
# AUTH_CODE=888888
# JWT_SECRET=lovdex@2026
```

- [ ] **Step 4:冒烟测试(独立端口,不碰 supervisor 的 3001)**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
SERVER_PORT=3999 npm run dev > /tmp/lovdex-auth-smoke.log 2>&1 &
SMOKE_PID=$!
sleep 4
# 1) 未登录访问受保护接口 → 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3999/api/projects
# Expected: 401
# 2) 登录拿 token
TOKEN=$(curl -s -X POST http://127.0.0.1:3999/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"zhiju.huang@sophgo.com","code":"888888"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
# 3) 带 token 访问 → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3999/api/projects
# Expected: 200
# 4) 错误验证码 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3999/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"zhiju.huang@sophgo.com","code":"000000"}'
# Expected: 401
kill $SMOKE_PID
```

Expected:输出 `401` → `(token)` → `200` → `401`。

- [ ] **Step 5:Commit**

```bash
git add server/index.js .env.example
git commit -m "feat(auth): mount /api/auth routes and document AUTH_* env knobs"
```

---

### Task 6:后端质量门 + 收尾 commit

**Files:** 无新增

- [ ] **Step 1:跑全部后端 auth 测试**

Run:`npx tsx --test server/modules/auth/tests/*.test.ts`
Expected:全部 pass。

- [ ] **Step 2:typecheck(注意基线)**

Run:`npm run typecheck`
Expected:存在 **存量** 失败(`server/modules/operators/tests/operator-headless.test.ts` 与 `operator-tools.test.ts`,与本次改动无关)。**确认没有 `server/modules/auth/*` 或 `middleware/auth.js` 的新报错** 即可。

- [ ] **Step 3:lint**

Run:`npm run lint`
Expected:无新增错误。若 auth 文件有告警,按 eslint 提示修复。

- [ ] **Step 4:确认无遗漏**

确认 `grep -rn "generateToken\|appConfigDb" server/middleware/auth.js` 无输出(旧导出已删干净)。

---

## 前端任务

### Task 7:WS URL 纯函数(`wsUrl.ts`)

**Files:**
- Create: `lovdex-cli/src/utils/wsUrl.ts`
- Modify: `lovdex-cli/src/contexts/WebSocketContext.tsx`(第 46-56 行的 `buildWebSocketUrl` 删除,改为 import)
- Test: `lovdex-cli/src/utils/wsUrl.test.ts`

- [ ] **Step 1:写失败测试**

```ts
// lovdex-cli/src/utils/wsUrl.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWebSocketUrl } from './wsUrl';

// node:test has no browser window; the same-origin branch needs one.
(globalThis as { window?: unknown }).window = {
  location: { protocol: 'https:' as string, host: 'lovdex.example.com' },
};

test('same-origin URL with token appends ?token=', () => {
  assert.equal(buildWebSocketUrl('abc.def.ghi'), 'wss://lovdex.example.com/ws?token=abc.def.ghi');
});

test('same-origin URL without a token is bare', () => {
  assert.equal(buildWebSocketUrl(null), 'wss://lovdex.example.com/ws');
});

test('token is URL-encoded', () => {
  assert.equal(buildWebSocketUrl('a/b+c'), 'wss://lovdex.example.com/ws?token=a%2Fb%2Bc');
});
```

- [ ] **Step 2:跑测试确认失败**

Run(在 `lovdex-cli/` 目录,**必须 unset 全局 TSX_TSCONFIG_PATH**,否则 tsx 会去找 cli 下不存在的 server/tsconfig.json):
```bash
env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/wsUrl.test.ts
```
Expected:报 `Cannot find module './wsUrl'`。

- [ ] **Step 3:实现 `wsUrl.ts`**

```ts
// lovdex-cli/src/utils/wsUrl.ts
import { API_BASE_URL } from '../constants/config';

/**
 * Builds the chat WebSocket URL. Browsers cannot set headers on WebSocket
 * connections, so a valid auth token is appended as `?token=` (the backend's
 * verifyWebSocketClient reads it). Returns the bare URL when no token is
 * present (e.g. IS_PLATFORM deployments that bypass the login gate).
 */
export function buildWebSocketUrl(token?: string | null): string {
  const wsBase = API_BASE_URL
    ? (() => {
        const httpUrl = new URL(API_BASE_URL);
        const protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${httpUrl.host}/ws`;
      })()
    : (() => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws`;
      })();
  return token ? `${wsBase}?token=${encodeURIComponent(token)}` : wsBase;
}
```

- [ ] **Step 4:改 `WebSocketContext.tsx` 用新函数**

在 `connect` 里(第 133 行 `const wsUrl = buildWebSocketUrl();`)改为:

```tsx
const wsUrl = buildWebSocketUrl(
  typeof localStorage !== 'undefined' ? localStorage.getItem('auth-token') : null
);
```

并删除文件内原 `buildWebSocketUrl` 定义(第 46-56 行),在 import 区加:

```tsx
import { buildWebSocketUrl } from '../../utils/wsUrl';
```

- [ ] **Step 5:跑测试确认通过**

Run:`env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/wsUrl.test.ts`
Expected:`# pass 3`、`# fail 0`。

- [ ] **Step 6:Commit(在 lovdex-cli)**

```bash
git add src/utils/wsUrl.ts src/utils/wsUrl.test.ts src/contexts/WebSocketContext.tsx
git commit -m "feat(auth): append auth token to chat WebSocket URL"
```

---

### Task 8:API 层 auth 方法 + 401 拦截(`api.js`)

**Files:**
- Modify: `lovdex-cli/src/utils/api.js`

- [ ] **Step 1:替换「Auth removed」注释为 auth 方法**

把 `api` 对象里注释 `// Auth removed — internal-only build.` 替换为:

```js
// Auth endpoints. login is public (no token needed); me validates a stored
// token so the app can boot straight into an authenticated session.
auth: {
  login: (email, code) =>
    fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    }),
  me: () => authenticatedFetch('/api/auth/me'),
},
```

- [ ] **Step 2:authenticatedFetch 加 401 拦截**

在 `authenticatedFetch` 的 `.then((response) => {...})` 里、`return response;` 之前插入:

```js
if (response.status === 401) {
  // Token expired or invalid mid-session: drop it and bounce to the login
  // page (AuthGate listens for this event). Login itself uses raw fetch and
  // never reaches this interceptor.
  localStorage.removeItem('auth-token');
  window.dispatchEvent(new Event('auth:unauthorized'));
}
```

- [ ] **Step 3:typecheck**

Run:`cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected:无新增错误(api.js 是 JS,`checkJs` 关闭,typecheck 主要覆盖 TS 文件)。

- [ ] **Step 4:Commit**

```bash
git add src/utils/api.js
git commit -m "feat(auth): add api.auth.login/me and global 401 bounce-to-login"
```

---

### Task 9:AuthGate(登录态编排)

**Files:**
- Create: `lovdex-cli/src/components/auth/AuthGate.tsx`

- [ ] **Step 1:实现 AuthGate**

```tsx
// lovdex-cli/src/components/auth/AuthGate.tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Loader2 } from 'lucide-react';

import { IS_PLATFORM } from '../../constants/config';
import { api } from '../../utils/api';
import LoginPage from './LoginPage';

const TOKEN_KEY = 'auth-token';

export type AuthUser = { id: number | string; username: string };

type AuthContextValue = {
  user: AuthUser | null;
  login: (email: string, code: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthGate');
  }
  return ctx;
};

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * Login gate wrapping the app:
 * - Platform mode: always authenticated (it has its own auth flow).
 * - No stored token → login page.
 * - Stored token → validate via /api/auth/me; 401 clears it and shows login.
 * - Network error while validating → retry after 3s (don't log the user out).
 * Also listens for `auth:unauthorized` (dispatched by authenticatedFetch on any
 * 401) so a token that expires mid-session bounces back to the login page.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(
    IS_PLATFORM ? 'authenticated' : 'loading'
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  // Boot check: validate a stored token, or show the login page.
  useEffect(() => {
    if (IS_PLATFORM) {
      return;
    }
    let cancelled = false;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setStatus('unauthenticated');
      return;
    }
    setStatus('loading');
    api.auth
      .me()
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { user?: AuthUser };
          setUser(body.user ?? null);
          setStatus('authenticated');
        } else {
          localStorage.removeItem(TOKEN_KEY);
          setStatus('unauthenticated');
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Network failure — retry the boot check instead of logging out.
        setTimeout(() => {
          if (!cancelled) setBootAttempt((n) => n + 1);
        }, 3000);
      });
    return () => {
      cancelled = true;
    };
  }, [bootAttempt]);

  // Mid-session expiry: authenticatedFetch 401 → back to login page.
  useEffect(() => {
    if (IS_PLATFORM) return;
    const onUnauthorized = () => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      setStatus('unauthenticated');
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, code: string) => {
    const res = await api.auth.login(email, code);
    if (!res.ok) {
      throw new Error('invalid-credentials');
    }
    const body = (await res.json()) as { token: string; user: AuthUser };
    localStorage.setItem(TOKEN_KEY, body.token);
    setUser(body.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, login, logout }),
    [user, login, logout]
  );

  return (
    <AuthContext.Provider value={value}>
      {status === 'unauthenticated' ? (
        <LoginPage />
      ) : status === 'loading' ? (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
```

- [ ] **Step 2:typecheck**

Run:`npm run typecheck`
Expected:无新增错误。

- [ ] **Step 3:Commit**

```bash
git add src/components/auth/AuthGate.tsx
git commit -m "feat(auth): add AuthGate login-state orchestrator + useAuth hook"
```

---

### Task 10:LoginPage

**Files:**
- Create: `lovdex-cli/src/components/auth/LoginPage.tsx`
- Modify: `lovdex-cli/src/i18n/locales/en/auth.json`

- [ ] **Step 1:实现 LoginPage**

```tsx
// lovdex-cli/src/components/auth/LoginPage.tsx
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn } from 'lucide-react';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '../../shared/view/ui';
import { useAuth } from './AuthGate';

const FIXED_EMAIL = 'zhiju.huang@sophgo.com';

export default function LoginPage() {
  const { t } = useTranslation('auth');
  const { login } = useAuth();
  const [email, setEmail] = useState(FIXED_EMAIL);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !code.trim()) {
      setError(t('login.errors.requiredFields'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), code.trim());
      // AuthGate flips to authenticated and unmounts this page.
    } catch {
      setError(t('login.errors.invalidCredentials'));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('login.title')}</CardTitle>
          <CardDescription>{t('login.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="login-email" className="text-sm font-medium text-foreground">
                {t('login.email')}
              </label>
              <Input
                id="login-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('login.placeholders.email')}
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="login-code" className="text-sm font-medium text-foreground">
                {t('login.code')}
              </label>
              <Input
                id="login-code"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={t('login.placeholders.code')}
                autoComplete="one-time-code"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting}>
              <LogIn className="h-4 w-4" />
              {submitting ? t('login.loading') : t('login.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2:更新 `en/auth.json`(整体替换)**

```json
{
  "login": {
    "title": "Welcome Back",
    "description": "Sign in with your email and verification code",
    "email": "Email",
    "code": "Verification Code",
    "submit": "Sign In",
    "loading": "Signing in...",
    "errors": {
      "invalidCredentials": "Invalid email or verification code",
      "requiredFields": "Please fill in all fields",
      "networkError": "Network error. Please try again."
    },
    "placeholders": {
      "email": "you@example.com",
      "code": "Enter your verification code"
    }
  },
  "logout": {
    "title": "Sign Out",
    "confirm": "Are you sure you want to sign out?",
    "button": "Sign Out"
  }
}
```

> 原 `register` 段是历史遗留空壳,前端无引用,一并移除。

- [ ] **Step 3:typecheck**

Run:`npm run typecheck`
Expected:无新增错误。

- [ ] **Step 4:Commit**

```bash
git add src/components/auth/LoginPage.tsx src/i18n/locales/en/auth.json
git commit -m "feat(auth): add email + verification code login page"
```

---

### Task 11:接入 App 路由

**Files:**
- Modify: `lovdex-cli/src/App.tsx`

- [ ] **Step 1:包 AuthGate**

在 `App.tsx` 加 import:

```tsx
import AuthGate from './components/auth/AuthGate';
```

把 `<ThemeProvider>` 内的结构改为(AuthGate 在最外层,逻辑是**未登录时不挂载 WebSocketProvider**,避免登录页阶段 WS 无限重连):

```tsx
<ThemeProvider>
  <AuthGate>
    <WebSocketProvider>
      <Router basename={routerBasename}>
        <Routes>
          <Route path="/" element={<AppContent />} />
          <Route path="/session/:sessionId" element={<AppContent />} />
          <Route path="/tasks" element={<TaskBoardPage />} />
          <Route path="/task/:taskId" element={<TaskDetailPage />} />
          <Route path="/assistant" element={<AssistantPanel />} />
          <Route path="/settings/operator" element={<OperatorSettingsPage />} />
        </Routes>
      </Router>
    </WebSocketProvider>
  </AuthGate>
</ThemeProvider>
```

- [ ] **Step 2:typecheck**

Run:`npm run typecheck`
Expected:无新增错误。

- [ ] **Step 3:前端纯逻辑测试回归**

Run:`env -u TSX_TSCONFIG_PATH npx tsx --test src/hooks/lastOpenedSession.test.ts`
Expected:原有测试仍 pass。

- [ ] **Step 4:Commit**

```bash
git add src/App.tsx
git commit -m "feat(auth): gate the whole app behind AuthGate"
```

---

### Task 12:侧边栏退出登录按钮

**Files:**
- Modify: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`

- [ ] **Step 1:改 SidebarFooter**

import 区(第 1 行 `import { ArrowUpCircle, Bug, AlertTriangle } from 'lucide-react';`)改为:

```tsx
import { ArrowUpCircle, Bug, AlertTriangle, LogOut } from 'lucide-react';
import { useAuth } from '../../../components/auth/AuthGate';
```

组件内(第 30 行解构处)加:

```tsx
const { logout } = useAuth();
```

在 `{/* Desktop version brand line (OSS mode only) */}` 块之前插入:

```tsx
{/* Logout (OSS mode only — the login gate is backend-enforced). */}
{!IS_PLATFORM && (
  <div className="px-2 pb-2">
    <button
      type="button"
      onClick={logout}
      title={t('auth:logout.button')}
      aria-label={t('auth:logout.button')}
      className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
    >
      <LogOut className="h-3.5 w-3.5" />
      <span>{t('auth:logout.button')}</span>
    </button>
  </div>
)}
```

- [ ] **Step 2:typecheck**

Run:`npm run typecheck`
Expected:无新增错误。

- [ ] **Step 3:Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarFooter.tsx
git commit -m "feat(auth): add logout button in sidebar footer"
```

---

### Task 13:前端质量门 + 收尾

**Files:** 无新增

- [ ] **Step 1:typecheck**

Run:`npm run typecheck`
Expected:通过,无新增错误。

- [ ] **Step 2:lint**

Run:`npm run lint`
Expected:无新增错误。如有 auth 相关告警按提示修复。

- [ ] **Step 3:build**

Run:`npm run build`
Expected:vite build 成功产出 `dist/`(supervisor 前端用 `vite preview` 服务 dist,完成后需重启 supervisor 生效)。

- [ ] **Step 4:前端手动验证(可选)**

在 `lovdex-cli` 跑 `npm run dev`(vite),浏览器打开 dev server:
1. 未登录 → 看到登录页(邮箱已预填)。
2. 输错验证码 → 提示「Invalid email or verification code」。
3. 输 `888888` → 进入应用,侧边栏底部出现退出登录按钮。
4. 刷新页面 → 直接进应用(免登录)。
5. 点退出登录 → 回登录页。

---

## 部署说明(不归本计划执行,但需知晓)

- 后端 prod 由 supervisor 以 `npm run dev`(tsx)跑在 :3001,前端 `vite preview` 跑在 :5187。**完成后需重启 supervisor**(`systemctl --user restart lovdex` 或 `supervisor/supervisor.mjs` 对应的管理方式)让两个仓库的改动生效。
- 默认 `AUTH_ENABLED=true`(不设即开启)。若部署后想临时回到开放模式,在 `lovdex-backend/.env` 加 `AUTH_ENABLED=false` 并重启后端即可。
- 已有浏览器 localStorage 里没有 `auth-token`,首次打开会看到登录页——这是预期行为。

## 自检清单(对照 spec)

- [x] 固定邮箱/验证码 + 默认密钥 `lovdex@2026`,环境变量可覆盖 → Task 1
- [x] HS256 手写 JWT,7 天有效期,24h 滑动续期 → Task 2、4
- [x] `POST /api/auth/login` + `GET /api/auth/me` → Task 3
- [x] `authenticateToken` 强制校验(header + `?token=`)、WS 校验、`AUTH_ENABLED=false` 安全阀、平台模式豁免 → Task 4
- [x] 登录路径零 DB 写入 → Task 3(路由不 touch DB)
- [x] 前端 AuthGate + LoginPage + token 存 `auth-token` + WS `?token=` → Task 7、9、10、11
- [x] i18n 文案 + 退出登录 → Task 10、12
- [x] 401 中间会话过期回登录页 → Task 8