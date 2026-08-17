# TUI Session Commands (`/branch` `/fork` `/rewind`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/branch`, `/fork`, `/rewind` open web overlays (like `/resume`) that fork the current provider session via the SDK and switch to the new session.

**Architecture:** Reuse the `ui-overlay` command pattern. Backend adds two REST endpoints that call the SDK's `forkSession`; frontend adds a shared `TurnPickerOverlay` + three thin overlays and switches sessions via `registerOptimisticSession`.

**Tech Stack:** Express + `node:test` (backend, ESM `.js` routes); React + Vite + cmdk `Command`/`Dialog` primitives (frontend, no test runner → typecheck + smoke).

**Spec:** `docs/superpowers/specs/2026-07-24-tui-session-commands-design.md`

**Key facts verified during planning:**
- `forkSession` is a top-level export: `import { forkSession } from '@anthropic-ai/claude-agent-sdk'` (sdk.d.ts:669).
- `chatRunRegistry.isProcessing(appSessionId)` → boolean (`chat-run-registry.service.ts:52`).
- `sessionsDb` from `'../modules/database/index.js'`; `SessionRow` has `provider`, `provider_session_id`, `project_path`, `custom_name`.
- History messages already carry `id` = provider UUID at runtime (`claude-sessions.provider.ts:332`); frontend `ChatMessage` just doesn't declare it.
- `registerOptimisticSession({ sessionId, provider, project, summary })` in `useProjectsState.ts:487` creates + selects a new session — the switch path for fork.
- `ResumeSessionOverlay.tsx` is the template (Dialog + cmdk `Command`).

---

## File Structure

**Backend (`lovdex-backend/`):**
- Modify `server/routes/commands.js` — register 3 commands.
- Create `server/services/git-rewind.js` — git helpers (isGitRepo, findCommitAtOrBefore, rewindFilesToCommit).
- Create `server/routes/sessions.js` — `POST /:appId/fork`, `POST /:appId/rewind`.
- Modify `server/index.js` — mount `/api/sessions` router.
- Test `server/routes/tests/sessions.fork.test.js`, `server/services/tests/git-rewind.test.js`.

**Frontend (`lovdex-cli/`):**
- Modify `src/components/chat/types/types.ts` — add `id?: string` to `ChatMessage`.
- Modify `src/utils/api.js` — add `forkSession`, `rewindSession`.
- Create `src/components/chat/view/subcomponents/TurnPickerOverlay.tsx` — shared turn list.
- Create `src/components/chat/view/subcomponents/BranchOverlay.tsx`, `ForkOverlay.tsx`, `RewindOverlay.tsx`.
- Modify `src/components/chat/hooks/useChatComposerState.ts` — overlay dispatch for branch/fork/rewind.
- Modify `src/components/chat/view/ChatInterface.tsx` — overlay state + render.
- Modify `src/components/chat/types/types.ts`, `src/components/main-content/types/types.ts` — thread `onSwitchToNewSession`.
- Modify `src/components/main-content/view/MainContent.tsx`, `src/components/app/AppContent.tsx` — thread the callback.
- Modify `src/i18n/locales/en/chat.json` — overlay strings.

---

### Task 1: Register the three commands (backend)

**Files:**
- Modify: `lovdex-backend/server/routes/commands.js` (append to `builtInCommands` before the closing `]` at line 214)
- Test: `lovdex-backend/server/routes/tests/commands.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/routes/tests/commands.test.js`:
```js
test('branch/fork/rewind are registered as ui-overlay commands', () => {
  for (const name of ['/branch', '/fork', '/rewind']) {
    const cmd = builtInCommands.find((c) => c.name === name);
    assert.ok(cmd, `${name} not registered`);
    assert.equal(cmd.metadata.handler, 'ui-overlay');
    assert.ok(cmd.metadata.overlay, `${name} missing overlay`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-backend && node --test server/routes/tests/commands.test.js`
Expected: FAIL — `/branch not registered`.

- [ ] **Step 3: Register the commands**

In `server/routes/commands.js`, insert before the `];` that closes `builtInCommands` (after the `/resume` entry, line 213):
```js
  {
    name: "/branch",
    description: "Branch this conversation from a chosen turn",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "branch" },
  },
  {
    name: "/fork",
    description: "Fork this conversation into a new session",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "fork" },
  },
  {
    name: "/rewind",
    description: "Rewind code and conversation to a chosen turn",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "rewind" },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-backend && node --test server/routes/tests/commands.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add server/routes/commands.js server/routes/tests/commands.test.js
git commit -m "feat(commands): register /branch /fork /rewind as ui-overlay commands"
```

---

### Task 2: git-rewind helper (backend)

**Files:**
- Create: `lovdex-backend/server/services/git-rewind.js`
- Test: `lovdex-backend/server/services/tests/git-rewind.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/tests/git-rewind.test.js`:
```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, execSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitRepo, findCommitAtOrBefore, rewindFilesToCommit } from '../git-rewind.js';

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'git-rewind-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  return dir;
}

test('isGitRepo true inside a repo, false outside', async () => {
  const dir = freshRepo();
  assert.equal(await isGitRepo(dir), true);
  const nonRepo = mkdtempSync(join(tmpdir(), 'notgit-'));
  assert.equal(await isGitRepo(nonRepo), false);
  rmSync(dir, { recursive: true, force: true });
  rmSync(nonRepo, { recursive: true, force: true });
});

test('findCommitAtOrBefore returns the commit at or before a timestamp', async () => {
  const dir = freshRepo();
  writeFileSync(join(dir, 'a.txt'), 'v1');
  execSync('git add a.txt && git commit -q -m one', { cwd: dir });
  const ts = new Date().toISOString();
  const commit = await findCommitAtOrBefore(dir, ts);
  assert.ok(commit, 'expected a commit');
  rmSync(dir, { recursive: true, force: true });
});

test('rewindFilesToCommit restores file contents to the commit', async () => {
  const dir = freshRepo();
  writeFileSync(join(dir, 'a.txt'), 'v1');
  execSync('git add a.txt && git commit -q -m one', { cwd: dir });
  const commit = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
  writeFileSync(join(dir, 'a.txt'), 'v2-uncommitted');
  await rewindFilesToCommit(dir, commit);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'v1');
  rmSync(dir, { recursive: true, force: true });
});
```
(Add `import { readFileSync } from 'node:fs';` at the top if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-backend && node --test server/services/tests/git-rewind.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement git-rewind.js**

Create `server/services/git-rewind.js`:
```js
import spawn from 'cross-spawn';

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => resolve({ ok: false, stdout, stderr }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

export async function isGitRepo(projectPath) {
  const { ok } = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  return ok;
}

/** Most recent commit with date <= isoTimestamp, or null. */
export async function findCommitAtOrBefore(projectPath, isoTimestamp) {
  const { ok, stdout } = await runGit(projectPath, [
    'log', '-1', '--format=%H', `--before=${isoTimestamp}`,
  ]);
  if (!ok) return null;
  const hash = stdout.trim();
  return hash || null;
}

/** Best-effort: stash current changes, restore tracked files to `commit`. */
export async function rewindFilesToCommit(projectPath, commit) {
  await runGit(projectPath, ['stash', '--include-untracked', '-m', 'lovdex-rewind']);
  const res = await runGit(projectPath, ['checkout', commit, '--', '.']);
  return res.ok;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-backend && node --test server/services/tests/git-rewind.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add server/services/git-rewind.js server/services/tests/git-rewind.test.js
git commit -m "feat(services): add git-rewind helper for /rewind file rollback"
```

---

### Task 3: `/fork` endpoint (backend)

**Files:**
- Create: `lovdex-backend/server/routes/sessions.js`
- Test: `lovdex-backend/server/routes/tests/sessions.fork.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/routes/tests/sessions.fork.test.js`:
```js
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { sessionsRouter } from '../sessions.js';

function mockDeps(overrides = {}) {
  return {
    sessionsDb: {
      getSessionById: () => ({
        session_id: 'app1', provider: 'claude', provider_session_id: 'prov1',
        project_path: '/p', custom_name: 'Orig', summary: 's',
      }),
      createAppSession: () => 'app2',
      updateSessionCustomName: () => {},
      assignProviderSessionId: () => {},
    },
    chatRunRegistry: { isProcessing: () => false },
    forkSession: async () => ({ sessionId: 'prov2' }),
    ...overrides,
  };
}

async function callFork(deps, body = {}) {
  const app = express();
  app.use(express.json());
  app.use('/', sessionsRouter(deps));
  const res = await app.request('/app1/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('fork creates a new app session and returns its id', async () => {
  const created = [];
  const deps = mockDeps({
    sessionsDb: {
      getSessionById: () => ({ session_id: 'app1', provider: 'claude', provider_session_id: 'prov1', project_path: '/p', custom_name: 'Orig', summary: 's' }),
      createAppSession: () => 'app2',
      updateSessionCustomName: (id, name) => created.push(name),
      assignProviderSessionId: () => {},
    },
  });
  const { status, body } = await callFork(deps, { upToMessageId: 'm3' });
  assert.equal(status, 200);
  assert.equal(body.newSessionId, 'app2');
  assert.equal(body.providerSessionId, 'prov2');
  assert.match(created[0], /branch|fork|rewind/);
});

test('fork 409 when session has no provider_session_id yet', async () => {
  const deps = mockDeps({
    sessionsDb: { getSessionById: () => ({ session_id: 'app1', provider: 'claude', provider_session_id: null, project_path: '/p', custom_name: null, summary: null }), createAppSession: () => 'x', updateSessionCustomName: () => {}, assignProviderSessionId: () => {} },
  });
  const { status } = await callFork(deps);
  assert.equal(status, 409);
});

test('fork 409 for unsupported provider (codex)', async () => {
  const deps = mockDeps({
    sessionsDb: { getSessionById: () => ({ session_id: 'app1', provider: 'codex', provider_session_id: 'prov1', project_path: '/p', custom_name: null, summary: null }), createAppSession: () => 'x', updateSessionCustomName: () => {}, assignProviderSessionId: () => {} },
  });
  const { status } = await callFork(deps);
  assert.equal(status, 409);
});

test('fork 409 when a run is in progress', async () => {
  const deps = mockDeps({ chatRunRegistry: { isProcessing: () => true } });
  const { status } = await callFork(deps);
  assert.equal(status, 409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-backend && node --test server/routes/tests/sessions.fork.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sessions.js (fork only first)**

Create `server/routes/sessions.js`:
```js
import express from 'express';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { sessionsDb } from '../modules/database/index.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';

const router = express.Router();

function conflict(res, code, message) {
  return res.status(409).json({ error: { code, message } });
}

async function forkAppSession(appId, { upToMessageId, suffix }) {
  const row = sessionsDb.getSessionById(appId);
  if (!row) return { status: 404, body: { error: { message: 'Session not found' } } };
  if (!row.provider_session_id) return { status: 409, body: { error: { code: 'SESSION_NOT_STARTED', message: 'Conversation has not started yet' } } };
  if (row.provider !== 'claude') return { status: 409, body: { error: { code: 'UNSUPPORTED_PROVIDER', message: 'Not supported for this provider' } } };
  if (chatRunRegistry.isProcessing(appId)) return { status: 409, body: { error: { code: 'RUN_IN_PROGRESS', message: 'Stop the running response first' } } };

  const { sessionId: newProviderId } = await forkSession(row.provider_session_id, upToMessageId ? { upToMessageId } : undefined);
  const newAppId = sessionsDb.createAppSession(row.provider, row.project_path);
  const baseName = row.custom_name || row.summary || 'Session';
  sessionsDb.updateSessionCustomName(newAppId, `${baseName} (${suffix})`);
  sessionsDb.assignProviderSessionId(newAppId, newProviderId);
  return { status: 200, body: { newSessionId: newAppId, providerSessionId: newProviderId } };
}

router.post('/:appId/fork', async (req, res) => {
  try {
    const { status, body } = await forkAppSession(req.params.appId, { upToMessageId: req.body?.upToMessageId, suffix: 'fork' });
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

export function sessionsRouter(deps) {
  // deps-injectable form for tests; production uses the module-level router.
  if (!deps) return router;
  return buildRouter(deps);
}

function buildRouter(deps) {
  const r = express.Router();
  r.post('/:appId/fork', async (req, res) => {
    try {
      const { status, body } = await forkAppSessionWith(deps, req.params.appId, { upToMessageId: req.body?.upToMessageId, suffix: 'fork' });
      res.status(status).json(body);
    } catch (err) { res.status(500).json({ error: { message: err.message } }); }
  });
  return r;
}

async function forkAppSessionWith(deps, appId, { upToMessageId, suffix }) {
  const { sessionsDb: db, chatRunRegistry: reg, forkSession: fork } = deps;
  const row = db.getSessionById(appId);
  if (!row) return { status: 404, body: { error: { message: 'Session not found' } } };
  if (!row.provider_session_id) return { status: 409, body: { error: { code: 'SESSION_NOT_STARTED', message: 'Conversation has not started yet' } } };
  if (row.provider !== 'claude') return { status: 409, body: { error: { code: 'UNSUPPORTED_PROVIDER', message: 'Not supported for this provider' } } };
  if (reg.isProcessing(appId)) return { status: 409, body: { error: { code: 'RUN_IN_PROGRESS', message: 'Stop the running response first' } } };
  const { sessionId: newProviderId } = await fork(row.provider_session_id, upToMessageId ? { upToMessageId } : undefined);
  const newAppId = db.createAppSession(row.provider, row.project_path);
  const baseName = row.custom_name || row.summary || 'Session';
  db.updateSessionCustomName(newAppId, `${baseName} (${suffix})`);
  db.assignProviderSessionId(newAppId, newProviderId);
  return { status: 200, body: { newSessionId: newAppId, providerSessionId: newProviderId } };
}

export default router;
```

> Note: the production router uses module-level `sessionsDb`/`chatRunRegistry`/`forkSession`; tests inject deps via `sessionsRouter(deps)`. The two code paths are intentionally identical — refactor to share `forkAppSessionWith` by passing a default deps object in production is a follow-up; for now both call the same logic. (To avoid drift, replace the module-level `router.post` body to delegate to `forkAppSessionWith` with a production deps object — see Step 4.)

- [ ] **Step 4: Deduplicate — production router delegates to the deps path**

Replace the module-level `router.post('/:appId/fork', ...)` and the `sessionsRouter`/`buildRouter` split with a single implementation. Final `server/routes/sessions.js`:
```js
import express from 'express';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { sessionsDb } from '../modules/database/index.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';

const productionDeps = {
  sessionsDb,
  chatRunRegistry,
  forkSession,
};

async function forkAppSessionWith(deps, appId, { upToMessageId, suffix }) {
  const { sessionsDb: db, chatRunRegistry: reg, forkSession: fork } = deps;
  const row = db.getSessionById(appId);
  if (!row) return { status: 404, body: { error: { message: 'Session not found' } } };
  if (!row.provider_session_id) return { status: 409, body: { error: { code: 'SESSION_NOT_STARTED', message: 'Conversation has not started yet' } } };
  if (row.provider !== 'claude') return { status: 409, body: { error: { code: 'UNSUPPORTED_PROVIDER', message: 'Not supported for this provider' } } };
  if (reg.isProcessing(appId)) return { status: 409, body: { error: { code: 'RUN_IN_PROGRESS', message: 'Stop the running response first' } } };
  const { sessionId: newProviderId } = await fork(row.provider_session_id, upToMessageId ? { upToMessageId } : undefined);
  const newAppId = db.createAppSession(row.provider, row.project_path);
  const baseName = row.custom_name || row.summary || 'Session';
  db.updateSessionCustomName(newAppId, `${baseName} (${suffix})`);
  db.assignProviderSessionId(newAppId, newProviderId);
  return { status: 200, body: { newSessionId: newAppId, providerSessionId: newProviderId } };
}

function buildRouter(deps) {
  const r = express.Router();
  r.post('/:appId/fork', async (req, res) => {
    try {
      const { status, body } = await forkAppSessionWith(deps, req.params.appId, { upToMessageId: req.body?.upToMessageId, suffix: 'fork' });
      res.status(status).json(body);
    } catch (err) { res.status(500).json({ error: { message: err.message } }); }
  });
  return r;
}

export const sessionsRouter = (deps) => buildRouter(deps ?? productionDeps);
export default buildRouter(productionDeps);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd lovdex-backend && node --test server/routes/tests/sessions.fork.test.js`
Expected: PASS (all 4).

- [ ] **Step 6: Commit**

```bash
cd lovdex-backend && git add server/routes/sessions.js server/routes/tests/sessions.fork.test.js
git commit -m "feat(routes): POST /api/sessions/:appId/fork via SDK forkSession"
```

---

### Task 4: `/rewind` endpoint (backend)

**Files:**
- Modify: `lovdex-backend/server/routes/sessions.js`
- Test: `lovdex-backend/server/routes/tests/sessions.rewind.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/routes/tests/sessions.rewind.test.js`:
```js
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { sessionsRouter } from '../sessions.js';

const baseRow = { session_id: 'app1', provider: 'claude', provider_session_id: 'prov1', project_path: '/p', custom_name: 'Orig', summary: 's' };

function deps(overrides = {}) {
  return {
    sessionsDb: {
      getSessionById: () => baseRow,
      createAppSession: () => 'app2',
      updateSessionCustomName: () => {},
      assignProviderSessionId: () => {},
    },
    chatRunRegistry: { isProcessing: () => false },
    forkSession: async () => ({ sessionId: 'prov2' }),
    gitRewind: { isGitRepo: async () => false, findCommitAtOrBefore: async () => null, rewindFilesToCommit: async () => true },
    ...overrides,
  };
}

async function callRewind(d, body) {
  const app = express();
  app.use(express.json());
  app.use('/', sessionsRouter(d));
  const res = await app.request('/app1/rewind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('rewind on non-git project warns and still forks', async () => {
  const { status, body } = await callRewind(deps(), { upToMessageId: 'm1', turnTimestamp: '2026-07-24T00:00:00Z' });
  assert.equal(status, 200);
  assert.equal(body.newSessionId, 'app2');
  assert.ok(body.warnings?.includes('file-rewind:not-a-git-repo'));
});

test('rewind on git repo with covering commit rewinds files', async () => {
  const rewound = [];
  const d = deps({ gitRewind: { isGitRepo: async () => true, findCommitAtOrBefore: async () => 'c1', rewindFilesToCommit: async (_p, c) => { rewound.push(c); return true; } } });
  const { status, body } = await callRewind(d, { upToMessageId: 'm1', turnTimestamp: '2026-07-24T00:00:00Z' });
  assert.equal(status, 200);
  assert.deepEqual(rewound, ['c1']);
  assert.ok(!body.warnings?.length);
});

test('rewind on git repo without covering commit warns', async () => {
  const d = deps({ gitRewind: { isGitRepo: async () => true, findCommitAtOrBefore: async () => null, rewindFilesToCommit: async () => true } });
  const { status, body } = await callRewind(d, { upToMessageId: 'm1', turnTimestamp: '2026-07-24T00:00:00Z' });
  assert.equal(status, 200);
  assert.ok(body.warnings?.includes('file-rewind:no-covering-commit'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-backend && node --test server/routes/tests/sessions.rewind.test.js`
Expected: FAIL — no `/rewind` route.

- [ ] **Step 3: Add rewind to sessions.js**

Add `gitRewind` to `productionDeps` and a rewind handler. In `server/routes/sessions.js`:
- Add import at top:
```js
import * as gitRewind from '../services/git-rewind.js';
```
- Extend `productionDeps`:
```js
const productionDeps = { sessionsDb, chatRunRegistry, forkSession, gitRewind };
```
- Add the rewind logic function (after `forkAppSessionWith`):
```js
async function rewindAppSessionWith(deps, appId, { upToMessageId, turnTimestamp }) {
  const forkResult = await forkAppSessionWith(deps, appId, { upToMessageId, suffix: 'rewind' });
  if (forkResult.status !== 200) return forkResult;
  const warnings = [];
  const row = deps.sessionsDb.getSessionById(appId);
  const projectPath = row?.project_path;
  if (!projectPath) return { ...forkResult, body: { ...forkResult.body, warnings } };
  const git = deps.gitRewind;
  const isRepo = await git.isGitRepo(projectPath);
  if (!isRepo) { warnings.push('file-rewind:not-a-git-repo'); return { ...forkResult, body: { ...forkResult.body, warnings } }; }
  const commit = await git.findCommitAtOrBefore(projectPath, turnTimestamp);
  if (!commit) { warnings.push('file-rewind:no-covering-commit'); return { ...forkResult, body: { ...forkResult.body, warnings } }; }
  await git.rewindFilesToCommit(projectPath, commit);
  return { ...forkResult, body: { ...forkResult.body, warnings } };
}
```
- Add the route inside `buildRouter`:
```js
  r.post('/:appId/rewind', async (req, res) => {
    try {
      const { status, body } = await rewindAppSessionWith(deps, req.params.appId, {
        upToMessageId: req.body?.upToMessageId,
        turnTimestamp: req.body?.turnTimestamp,
      });
      res.status(status).json(body);
    } catch (err) { res.status(500).json({ error: { message: err.message } }); }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-backend && node --test server/routes/tests/sessions.rewind.test.js`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend && git add server/routes/sessions.js server/routes/tests/sessions.rewind.test.js
git commit -m "feat(routes): POST /api/sessions/:appId/rewind with git file rollback"
```

---

### Task 5: Mount the router (backend)

**Files:**
- Modify: `lovdex-backend/server/index.js`

- [ ] **Step 1: Add import + mount**

In `server/index.js`, add to the route imports (near line 32):
```js
import sessionsRoutes from './routes/sessions.js';
```
And add the mount near the other `app.use('/api/...', authenticateToken, ...)` lines (after line 154):
```js
app.use('/api/sessions', authenticateToken, sessionsRoutes);
```

- [ ] **Step 2: Verify backend still boots + healthcheck**

Run: `cd lovdex-backend && npm run dev` (background), then `curl -s http://localhost:3001/health` → expect 200. Stop it.
Expected: 200 OK, no boot errors in output.

- [ ] **Step 3: Commit**

```bash
cd lovdex-backend && git add server/index.js
git commit -m "feat(routes): mount /api/sessions router"
```

---

### Task 6: Frontend — ChatMessage.id + api helpers

**Files:**
- Modify: `lovdex-cli/src/components/chat/types/types.ts` (the `ChatMessage` interface, ~line 37)
- Modify: `lovdex-cli/src/utils/api.js`

- [ ] **Step 1: Add `id` to ChatMessage**

In `src/components/chat/types/types.ts`, add as the first field of `ChatMessage`:
```ts
  id?: string;
```

- [ ] **Step 2: Add api helpers**

In `src/utils/api.js`, inside the `export const api = { ... }` object, add (near the other session methods):
```js
  forkSession: (appId, body) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(appId)}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  rewindSession: (appId, body) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(appId)}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
```

- [ ] **Step 3: Typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd lovdex-cli && git add src/components/chat/types/types.ts src/utils/api.js
git commit -m "feat(api): add forkSession/rewindSession helpers + ChatMessage.id"
```

---

### Task 7: Frontend — TurnPickerOverlay

**Files:**
- Create: `lovdex-cli/src/components/chat/view/subcomponents/TurnPickerOverlay.tsx`

- [ ] **Step 1: Implement the shared overlay**

Create `src/components/chat/view/subcomponents/TurnPickerOverlay.tsx`:
```tsx
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '../../../../shared/view/ui/Command';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui/Dialog';

export interface TurnPick {
  id: string;
  summary: string;
  timestamp?: string;
}

interface TurnPickerOverlayProps {
  open: boolean;
  onClose: () => void;
  turns: TurnPick[];
  loading?: boolean;
  error?: string | null;
  title: string;
  emptyLabel: string;
  onSelect: (turn: TurnPick) => void;
}

export function TurnPickerOverlay({
  open, onClose, turns, loading, error, title, emptyLabel, onSelect,
}: TurnPickerOverlayProps) {
  const { t } = useTranslation('chat');

  const handleSelect = useCallback((turn: TurnPick) => {
    onSelect(turn);
    onClose();
  }, [onSelect, onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[min(70dvh,32rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col gap-3 p-4">
        <DialogTitle>{title}</DialogTitle>
        <Command className="flex-1 overflow-hidden">
          <CommandList>
            {loading && (
              <div className="px-3 py-2 text-sm opacity-70">{t('session.resume.loading')}</div>
            )}
            {error && <div className="px-3 py-2 text-sm text-red-500">{error}</div>}
            {!loading && !error && turns.length === 0 && (
              <CommandEmpty>{emptyLabel}</CommandEmpty>
            )}
            {!loading && !error && turns.length > 0 && (
              <CommandGroup heading={title}>
                {turns.map((turn) => (
                  <CommandItem
                    key={turn.id}
                    value={`${turn.summary} ${turn.id}`}
                    onSelect={() => handleSelect(turn)}
                  >
                    <div className="flex w-full flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{turn.summary}</span>
                      {turn.timestamp && (
                        <span className="text-xs opacity-60">{turn.timestamp}</span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd lovdex-cli && git add src/components/chat/view/subcomponents/TurnPickerOverlay.tsx
git commit -m "feat(chat): add shared TurnPickerOverlay"
```

---

### Task 8: Frontend — Branch / Fork / Rewind overlays

**Files:**
- Create: `lovdex-cli/src/components/chat/view/subcomponents/BranchOverlay.tsx`
- Create: `lovdex-cli/src/components/chat/view/subcomponents/ForkOverlay.tsx`
- Create: `lovdex-cli/src/components/chat/view/subcomponents/RewindOverlay.tsx`

- [ ] **Step 1: Implement BranchOverlay**

Create `src/components/chat/view/subcomponents/BranchOverlay.tsx`:
```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TurnPickerOverlay, type TurnPick } from './TurnPickerOverlay';
import { api } from '../../../../utils/api';

interface BranchOverlayProps {
  open: boolean;
  onClose: () => void;
  appId: string;
  turns: TurnPick[];
  onSwitchToNewSession: (newSessionId: string, summary: string) => void;
}

export function BranchOverlay({ open, onClose, appId, turns, onSwitchToNewSession }: BranchOverlayProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSelect(turn: TurnPick) {
    setBusy(true); setError(null);
    try {
      const res = await api.forkSession(appId, { upToMessageId: turn.id });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? 'Branch failed');
      onSwitchToNewSession(body.newSessionId, turn.summary);
    } catch (e) { setError(e instanceof Error ? e.message : 'Branch failed'); }
    finally { setBusy(false); }
  }

  return (
    <TurnPickerOverlay
      open={open} onClose={onClose} turns={turns} loading={busy} error={error}
      title={t('session.branch.title')} emptyLabel={t('session.branch.empty')}
      onSelect={handleSelect}
    />
  );
}
```

- [ ] **Step 2: Implement ForkOverlay**

Create `src/components/chat/view/subcomponents/ForkOverlay.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui/Dialog';
import { api } from '../../../../utils/api';

interface ForkOverlayProps {
  open: boolean;
  onClose: () => void;
  appId: string;
  summary: string;
  onSwitchToNewSession: (newSessionId: string, summary: string) => void;
}

export function ForkOverlay({ open, onClose, appId, summary, onSwitchToNewSession }: ForkOverlayProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true); setError(null);
    (async () => {
      try {
        const res = await api.forkSession(appId, {});
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? 'Fork failed');
        if (cancelled) return;
        onSwitchToNewSession(body.newSessionId, summary);
        onClose();
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Fork failed'); }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, [open, appId, summary, onSwitchToNewSession, onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-w-md flex-col gap-3 p-4">
        <DialogTitle>{t('session.fork.title')}</DialogTitle>
        {busy && <div className="text-sm opacity-70">{t('session.fork.busy')}</div>}
        {error && <div className="text-sm text-red-500">{error}</div>}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Implement RewindOverlay**

Create `src/components/chat/view/subcomponents/RewindOverlay.tsx`:
```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TurnPickerOverlay, type TurnPick } from './TurnPickerOverlay';
import { api } from '../../../../utils/api';

interface RewindOverlayProps {
  open: boolean;
  onClose: () => void;
  appId: string;
  turns: TurnPick[];
  onSwitchToNewSession: (newSessionId: string, summary: string) => void;
}

export function RewindOverlay({ open, onClose, appId, turns, onSwitchToNewSession }: RewindOverlayProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSelect(turn: TurnPick) {
    setBusy(true); setError(null);
    try {
      const res = await api.rewindSession(appId, { upToMessageId: turn.id, turnTimestamp: turn.timestamp });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? 'Rewind failed');
      const warning = body.warnings?.length ? t('session.rewind.fileSkipped') : null;
      if (warning) setError(warning);
      onSwitchToNewSession(body.newSessionId, turn.summary);
    } catch (e) { setError(e instanceof Error ? e.message : 'Rewind failed'); }
    finally { setBusy(false); }
  }

  return (
    <TurnPickerOverlay
      open={open} onClose={onClose} turns={turns} loading={busy} error={error}
      title={t('session.rewind.title')} emptyLabel={t('session.rewind.empty')}
      onSelect={handleSelect}
    />
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli && git add src/components/chat/view/subcomponents/BranchOverlay.tsx src/components/chat/view/subcomponents/ForkOverlay.tsx src/components/chat/view/subcomponents/RewindOverlay.tsx
git commit -m "feat(chat): add Branch/Fork/Rewind overlays"
```

---

### Task 9: Frontend — overlay dispatch in the composer

**Files:**
- Modify: `lovdex-cli/src/components/chat/hooks/useChatComposerState.ts` (the `isUiOverlay` block at line 711)

- [ ] **Step 1: Add overlay state**

Find the `resumeOverlayOpen`/`setResumeOverlayOpen` state declarations in `useChatComposerState.ts` and add alongside them:
```ts
  const [branchOverlayOpen, setBranchOverlayOpen] = useState(false);
  const [forkOverlayOpen, setForkOverlayOpen] = useState(false);
  const [rewindOverlayOpen, setRewindOverlayOpen] = useState(false);
```
(Ensure `useState` is already imported — it is.)

- [ ] **Step 2: Extend the overlay dispatch**

In the `isUiOverlay` block (line 711-727), after the `if (overlay === 'resume') { ... return; }` block, add:
```ts
          if (overlay === 'branch') { setBranchOverlayOpen(true); setInput(''); inputValueRef.current = ''; setAttachedImages([]); setUploadingImages(new Map()); setImageErrors(new Map()); resetCommandMenuState(); setIsTextareaExpanded(false); if (textareaRef.current) { textareaRef.current.style.height = 'auto'; } return; }
          if (overlay === 'fork') { setForkOverlayOpen(true); setInput(''); inputValueRef.current = ''; setAttachedImages([]); setUploadingImages(new Map()); setImageErrors(new Map()); resetCommandMenuState(); setIsTextareaExpanded(false); if (textareaRef.current) { textareaRef.current.style.height = 'auto'; } return; }
          if (overlay === 'rewind') { setRewindOverlayOpen(true); setInput(''); inputValueRef.current = ''; setAttachedImages([]); setUploadingImages(new Map()); setImageErrors(new Map()); resetCommandMenuState(); setIsTextareaExpanded(false); if (textareaRef.current) { textareaRef.current.style.height = 'auto'; } return; }
```

- [ ] **Step 3: Expose overlay state + setters in the hook return**

Find where `resumeOverlayOpen`/`setResumeOverlayOpen` are returned from the hook (search for `resumeOverlayOpen,` in the return object) and add:
```ts
    branchOverlayOpen,
    setBranchOverlayOpen,
    forkOverlayOpen,
    setForkOverlayOpen,
    rewindOverlayOpen,
    setRewindOverlayOpen,
```

- [ ] **Step 4: Typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: PASS (may warn about unused vars until Task 10 wires them — if it errors, proceed to Task 10 then re-check).

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli && git add src/components/chat/hooks/useChatComposerState.ts
git commit -m "feat(chat): dispatch /branch /fork /rewind to overlays"
```

---

### Task 10: Frontend — render overlays + thread switch callback

**Files:**
- Modify: `lovdex-cli/src/components/chat/view/ChatInterface.tsx`
- Modify: `lovdex-cli/src/components/chat/types/types.ts`
- Modify: `lovdex-cli/src/components/main-content/types/types.ts`
- Modify: `lovdex-cli/src/components/main-content/view/MainContent.tsx`
- Modify: `lovdex-cli/src/components/app/AppContent.tsx`
- Modify: `lovdex-cli/src/i18n/locales/en/chat.json`

- [ ] **Step 1: Add i18n strings**

In `src/i18n/locales/en/chat.json`, inside the `session` object (near `resume`), add:
```json
    "branch": { "title": "Branch from a turn", "empty": "No turns to branch from" },
    "fork": { "title": "Fork this conversation", "busy": "Forking…" },
    "rewind": { "title": "Rewind to a turn", "empty": "No turns to rewind to", "fileSkipped": "Conversation rewound; file changes left untouched." },
```

- [ ] **Step 2: Thread `onSwitchToNewSession` prop**

In `src/components/chat/types/types.ts`, add to the ChatInterface props interface (near `onResumeSession`):
```ts
  onSwitchToNewSession?: (newSessionId: string, summary: string) => void;
```
In `src/components/main-content/types/types.ts`, add the same signature to MainContent's props interface (near `onResumeSession`).

- [ ] **Step 3: AppContent provides the callback**

In `src/components/app/AppContent.tsx`, ensure `registerOptimisticSession`, `selectedProject`, and current `provider` are available (they are in `useProjectsState`). Add a handler near where `onResumeSession={handleSessionSelect}` is set:
```tsx
  const handleSwitchToNewSession = useCallback((newSessionId: string, summary: string) => {
    registerOptimisticSession({
      sessionId: newSessionId,
      provider,
      project: selectedProject,
      summary,
    });
  }, [registerOptimisticSession, provider, selectedProject]);
```
(Import `useCallback` if not present.) Then pass it to MainContent:
```tsx
          onSwitchToNewSession={handleSwitchToNewSession}
```

- [ ] **Step 4: MainContent passes it through**

In `src/components/main-content/view/MainContent.tsx`, destructure `onSwitchToNewSession` from props and pass it to `ChatInterface`:
```tsx
                onSwitchToNewSession={onSwitchToNewSession}
```

- [ ] **Step 5: ChatInterface renders the three overlays**

In `src/components/chat/view/ChatInterface.tsx`:
- Add imports:
```tsx
import { BranchOverlay } from './subcomponents/BranchOverlay';
import { ForkOverlay } from './subcomponents/ForkOverlay';
import { RewindOverlay } from './subcomponents/RewindOverlay';
import type { TurnPick } from './subcomponents/TurnPickerOverlay';
```
- Destructure `onSwitchToNewSession` from props, and `branchOverlayOpen`/`setBranchOverlayOpen`/`forkOverlayOpen`/`setForkOverlayOpen`/`rewindOverlayOpen`/`setRewindOverlayOpen` from the composer hook result (alongside `resumeOverlayOpen`).
- Build a `turns` memo from the current session messages (each message with an `id` and a text summary). Near the existing message-derived memos:
```tsx
  const turns: TurnPick[] = useMemo(
    () => messages
      .filter((m) => m.id && !m.isToolUse && !m.isCompactSummary)
      .map((m) => ({ id: m.id as string, summary: (m.content || m.displayText || '').slice(0, 80) || '(turn)', timestamp: m.lastUpdated })),
    [messages],
  );
```
  (Use whatever the current messages array is named in ChatInterface — check the `ChatMessagesPane` `messages` prop source; if it's named differently, adjust. `useMemo` must be imported.)
- Render after the `<ResumeSessionOverlay .../>` block:
```tsx
      <BranchOverlay
        open={branchOverlayOpen}
        onClose={() => setBranchOverlayOpen(false)}
        appId={currentSessionId || selectedSession?.id || ''}
        turns={turns}
        onSwitchToNewSession={onSwitchToNewSession ?? (() => {})}
      />
      <ForkOverlay
        open={forkOverlayOpen}
        onClose={() => setForkOverlayOpen(false)}
        appId={currentSessionId || selectedSession?.id || ''}
        summary={selectedSession?.summary ?? ''}
        onSwitchToNewSession={onSwitchToNewSession ?? (() => {})}
      />
      <RewindOverlay
        open={rewindOverlayOpen}
        onClose={() => setRewindOverlayOpen(false)}
        appId={currentSessionId || selectedSession?.id || ''}
        turns={turns}
        onSwitchToNewSession={onSwitchToNewSession ?? (() => {})}
      />
```

- [ ] **Step 6: Typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: PASS. (Fix any name mismatches — e.g. the messages array name, `lastUpdated` field — flagged by the compiler.)

- [ ] **Step 7: Commit**

```bash
cd lovdex-cli && git add -A
git commit -m "feat(chat): wire /branch /fork /rewind overlays end-to-end"
```

---

### Task 11: Smoke test end-to-end

- [ ] **Step 1: Restart both services**

```bash
# stop existing :3001 and :5187 processes, then:
cd lovdex-backend && npm run dev   # background
cd lovdex-cli && npm run dev       # background
```

- [ ] **Step 2: Manual verification in the browser at http://localhost:5187**

- Open a Claude session, send 2-3 turns so it has a `provider_session_id`.
- Type `/branch` → overlay opens with the turn list → pick a turn → a new session appears and is selected; original still in sidebar.
- Type `/fork` → confirm overlay → new forked session selected.
- Type `/rewind` → pick a turn → new session selected; if project is a git repo, tracked files rolled back (verify with `git status` in the project); if not, the "file changes left untouched" banner shows.
- Type `/branch` on a brand-new session with no turns sent → endpoint returns 409 → overlay shows "Conversation has not started yet."
- On a Codex session, `/branch` → "Not supported for this provider."

- [ ] **Step 3: Backend tests green**

Run: `cd lovdex-backend && node --test server/routes/tests/commands.test.js server/routes/tests/sessions.fork.test.js server/routes/tests/sessions.rewind.test.js server/services/tests/git-rewind.test.js`
Expected: all PASS.

- [ ] **Step 4: Commit any smoke-test fixes**

```bash
git add -A && git commit -m "fix: smoke-test adjustments" || echo "no fixes needed"
```

---

## Self-Review notes

- Spec §4 (semantics), §5.1 (backend), §5.2 (frontend), §5.3 (data flow), §6 (errors) all map to tasks above.
- `/clear` intentionally untouched (already `forwardToProvider`).
- Codex unsupported via `provider !== 'claude'` guard (spec non-goal).
- Frontend has no test runner → typecheck + smoke replaces component tests (deviation from spec §7, noted in Tech Stack).
