# Exclude Verdict Sessions from 最近任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide auto-verdict (状态判断) headless sessions from the sidebar「最近任务」list while keeping Lovdex助手 interactive chats.

**Architecture:** Add an `is_verdict` flag to the `sessions` table, stamp it from `runOperatorHeadless` (which mints a fresh SDK session per verdict run), expose it in the project session summaries, and filter it out in the frontend `getRecentSessions` helper.

**Tech Stack:** TypeScript + better-sqlite3 (backend, `backend/`), React + TypeScript (frontend, `web/`), `node:test` (both sides).

**Spec:** `docs/superpowers/specs/2026-09-10-exclude-verdict-sessions-from-recent-tasks-design.md`

**Test commands:**
- Backend: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test <file>`
- Frontend: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/web && npx tsx --test <file>`

**Commit convention:** no `Co-Authored-By` trailer. Conventional prefixes (`feat(...)`).

**Note on baseline:** backend `typecheck`/`lint` have pre-existing errors (see memory `lovdex-backend-baseline-not-clean`). Acceptance = **zero new** errors; do not "fix" unrelated ones.

---

### Task 1: Add `is_verdict` column to the sessions table

**Files:**
- Modify: `backend/server/modules/database/schema.ts` (sessions table SQL)
- Modify: `backend/server/modules/database/migrations.ts` (add-column migration)
- Modify: `backend/server/modules/database/repositories/sessions.db.ts` (`SessionRow` + `SESSION_ROW_COLUMNS`)
- Test: `backend/server/modules/database/tests/operator-columns.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/server/modules/database/tests/operator-columns.test.ts` (after the existing `sessions table has is_operator` test at line 46-52):

```ts
test('sessions table has is_verdict', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    assert.ok(cols.map((c) => c.name).includes('is_verdict'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/operator-columns.test.ts`

Expected: FAIL — `sessions table has is_verdict` fails with `The expression evaluated to a falsy value` (column not present).

- [ ] **Step 3: Add the column to the fresh-DB schema**

In `backend/server/modules/database/schema.ts`, in `SESSIONS_TABLE_SCHEMA_SQL`, add the column right after `is_operator`:

```ts
    is_operator      INTEGER DEFAULT 0,
    is_verdict       INTEGER DEFAULT 0,
    PRIMARY KEY (session_id),
```

- [ ] **Step 4: Add the add-column migration**

In `backend/server/modules/database/migrations.ts`, immediately after the `is_operator` migration (currently line 806):

```ts
    addColumnToTableIfNotExists(db, 'sessions', sessionColumnNamesForSummary, 'is_verdict', 'INTEGER DEFAULT 0');
```

- [ ] **Step 5: Extend `SessionRow` type + `SESSION_ROW_COLUMNS`**

In `backend/server/modules/database/repositories/sessions.db.ts`:

`SessionRow` (after `is_operator: number;`):
```ts
  is_verdict: number;
```

`SESSION_ROW_COLUMNS` (replace the whole string):
```ts
const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, summary, isArchived, is_operator, is_verdict, created_at, updated_at';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/operator-columns.test.ts`

Expected: PASS (all 3 tests).

- [ ] **Step 7: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts backend/server/modules/database/repositories/sessions.db.ts backend/server/modules/database/tests/operator-columns.test.ts
git commit -m "feat(sessions): add is_verdict column for headless verdict sessions"
```

---

### Task 2: Add `sessionsDb.markSessionAsVerdict` upsert

**Files:**
- Modify: `backend/server/modules/database/repositories/sessions.db.ts`
- Test: `backend/server/modules/database/tests/sessions-provider-mapping.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/server/modules/database/tests/sessions-provider-mapping.test.ts` (it already imports `sessionsDb` and has the `withIsolatedDatabase` helper):

```ts
test('markSessionAsVerdict creates a verdict row when none exists', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.markSessionAsVerdict('verdict-1', '/workspace/op');

    const row = sessionsDb.getSessionById('verdict-1');
    assert.equal(row?.is_verdict, 1);
    assert.equal(row?.is_operator, 0);
    assert.equal(row?.provider_session_id, 'verdict-1');
  });
});

test('markSessionAsVerdict stamps an existing row without touching is_operator/isArchived', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('op-1', 'claude', '/workspace/op', true);
    sessionsDb.updateSessionIsArchived('op-1', true);

    sessionsDb.markSessionAsVerdict('op-1', '/workspace/op');

    const row = sessionsDb.getSessionById('op-1');
    assert.equal(row?.is_verdict, 1);
    assert.equal(row?.is_operator, 1);
    assert.equal(row?.isArchived, 1);
  });
});

test('createSession re-index preserves is_verdict', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.markSessionAsVerdict('verdict-2', '/workspace/op');

    // The synchronizer later discovers the transcript and re-indexes the row.
    sessionsDb.createSession('verdict-2', 'claude', '/workspace/op', 'Synced Name');

    const row = sessionsDb.getSessionById('verdict-2');
    assert.equal(row?.is_verdict, 1);
    assert.equal(row?.custom_name, 'Synced Name');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/sessions-provider-mapping.test.ts`

Expected: FAIL — `TypeError: sessionsDb.markSessionAsVerdict is not a function`.

- [ ] **Step 3: Implement `markSessionAsVerdict`**

In `backend/server/modules/database/repositories/sessions.db.ts`, insert the method immediately after `createAppSession` (its closing brace is around line 191, before `assignProviderSessionId`):

```ts
  /**
   * Marks a headless auto-verdict session so the sidebar「最近任务」list can
   * exclude it. A verdict run is a fresh SDK session minted inside the
   * operator workspace (is_operator=0, is_verdict=1), distinct from interactive
   * Lovdex助手 chats (is_operator=1). Upserts so the mark is correct whether it
   * lands before or after the synchronizer indexes the transcript; createSession's
   * re-index branch never touches is_verdict, so the flag survives later rescans.
   */
  markSessionAsVerdict(sessionId: string, projectPath: string, provider = 'claude'): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, summary, project_path, jsonl_path, isArchived, is_operator, is_verdict, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL, 0, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET is_verdict = 1`
    ).run(sessionId, provider, sessionId, normalizedProjectPath);
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/sessions-provider-mapping.test.ts`

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/database/repositories/sessions.db.ts backend/server/modules/database/tests/sessions-provider-mapping.test.ts
git commit -m "feat(sessions): add markSessionAsVerdict upsert"
```

---

### Task 3: Capture and mark the verdict session id in `runOperatorHeadless`

**Files:**
- Modify: `backend/server/claude-sdk.js`
- Test: `backend/server/modules/operators/tests/operator-headless.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/server/modules/operators/tests/operator-headless.test.ts` (it already imports `runOperatorHeadless`, `fakeDeps`, `fakeConfig`, `emptyIterable`):

```ts
test('runOperatorHeadless marks the verdict session id captured from the stream', async () => {
  let marked: string | null = null;
  const queryFn = () => {
    return (async function* () {
      yield { session_id: 'verdict-123', type: 'system' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
    })();
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'x',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: fakeConfig(),
    markVerdictSession: (sid: string) => {
      marked = sid;
    },
  });

  assert.equal(marked, 'verdict-123');
});

test('runOperatorHeadless does not mark when the stream has no session id', async () => {
  let marked: string | null = null;

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'x',
    queryFn: () => emptyIterable(),
    deps: fakeDeps() as never,
    config: fakeConfig(),
    markVerdictSession: (sid: string) => {
      marked = sid;
    },
  });

  assert.equal(marked, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-headless.test.ts`

Expected: FAIL — both new tests fail (`marked` stays `null`; the `markVerdictSession` param is ignored today).

- [ ] **Step 3: Add the `sessionsDb` import**

In `backend/server/claude-sdk.js`, after the existing import at line 38:

```js
import { isTaskStatus } from './modules/database/repositories/tasks.db.js';
```

add:

```js
import { sessionsDb } from './modules/database/index.js';
```

- [ ] **Step 4: Accept the `markVerdictSession` seam**

Change the `runOperatorHeadless` signature (line 1265) from:

```js
export async function runOperatorHeadless({ sessionId, taskId, title, promptOverride, queryFn, config, deps }) {
```

to:

```js
export async function runOperatorHeadless({ sessionId, taskId, title, promptOverride, queryFn, config, deps, markVerdictSession }) {
```

- [ ] **Step 5: Capture the session id and mark after draining**

Replace the drain loop (currently lines 1375-1377):

```js
    for await (const _message of queryInstance) {
      // intentionally empty — drain without emitting
    }
```

with:

```js
    let capturedSessionId = null;
    for await (const message of queryInstance) {
      if (!capturedSessionId && message?.session_id) {
        capturedSessionId = message.session_id;
      }
    }

    if (capturedSessionId) {
      const mark = markVerdictSession ?? ((sid) => sessionsDb.markSessionAsVerdict(sid, cfg.workspace));
      try {
        mark(capturedSessionId);
      } catch (e) {
        console.error('[operator-headless] mark verdict session failed', e);
      }
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-headless.test.ts`

Expected: PASS (all existing + 2 new).

- [ ] **Step 7: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/claude-sdk.js backend/server/modules/operators/tests/operator-headless.test.ts
git commit -m "feat(operator): mark headless verdict sessions after drain"
```

---

### Task 4: Expose `is_verdict` in project session summaries

**Files:**
- Modify: `backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts`
- Test: `backend/server/modules/projects/services/tests/operator-workspace-mark.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/server/modules/projects/services/tests/operator-workspace-mark.test.ts` (it already imports `sessionsDb`, `getProjectsWithSessions`, and has `withTempWorkspace`):

```ts
test('session summaries carry is_verdict so the frontend can filter verdict sessions', async () => {
  await withTempWorkspace(async (workspace) => {
    projectsDb.createProjectPath(workspace);

    sessionsDb.createAppSession('ws-assistant', 'claude', workspace, true);
    sessionsDb.markSessionAsVerdict('ws-verdict', workspace);

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const ws = projects.find((p) => p.fullPath === workspace);

    const byId = new Map((ws?.sessions ?? []).map((s) => [s.id, s]));
    assert.equal(byId.get('ws-verdict')?.is_verdict, 1);
    assert.equal(byId.get('ws-assistant')?.is_verdict, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/services/tests/operator-workspace-mark.test.ts`

Expected: FAIL — `byId.get('ws-verdict')?.is_verdict` is `undefined` (the summary omits the field), so `undefined === 1` fails.

- [ ] **Step 3: Add `is_verdict` to the summary types and mapper**

In `backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts`:

`SessionSummary` (add after `messageCount: number;`):
```ts
  is_verdict: number;
```

`SessionRepositoryRow` (add after `summary?: string | null;`):
```ts
  is_verdict?: number;
```

`mapSessionRowToSummary` (add after `messageCount: 0,`):
```ts
    is_verdict: row.is_verdict ?? 0,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/services/tests/operator-workspace-mark.test.ts`

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts backend/server/modules/projects/services/tests/operator-workspace-mark.test.ts
git commit -m "feat(projects): expose is_verdict in session summaries"
```

---

### Task 5: Filter verdict sessions out of 最近任务 in the frontend

**Files:**
- Modify: `web/src/types/app.ts`
- Modify: `web/src/components/sidebar/utils/utils.ts`
- Test: `web/src/components/sidebar/utils/utils.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/components/sidebar/utils/utils.test.ts` (it already imports `getRecentSessions`, `mkSession`, `mkProject`, and `Project`):

```ts
test('getRecentSessions drops verdict sessions but keeps assistant chats', () => {
  const verdict = { ...mkSession('v1', '2026-08-04T11:30:00Z'), is_verdict: 1 } as ProjectSession;
  const assistant = mkSession('op1', '2026-08-04T10:00:00Z'); // is_verdict undefined → kept
  const ws = mkProject('op-ws', 'operator-workspace', { sessions: [verdict, assistant] });
  (ws as Project).isOperatorWorkspace = true;
  const regular = mkProject('pA', 'A', { sessions: [mkSession('a1', '2026-08-04T11:00:00Z')] });

  const out = getRecentSessions([regular, ws], 10);
  assert.deepEqual(out.map((e) => e.session.id), ['a1', 'op1']);
});
```

Note: the import line at the top of the test file already imports `type { Project, ProjectSession }` — `ProjectSession` is already imported (line 4). Verify; if not, add it.

- [ ] **Step 2: Run test to verify it fails**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/sidebar/utils/utils.test.ts`

Expected: FAIL — the verdict session `v1` is NOT filtered, so the result is `['v1', 'a1', 'op1']` instead of `['a1', 'op1']`.

- [ ] **Step 3: Add `is_verdict` to the `ProjectSession` type**

In `web/src/types/app.ts`, in `ProjectSession`, add after `__provider?: LLMProvider;`:

```ts
  /** 1 = headless auto-verdict (状态判断) session — excluded from 最近任务. */
  is_verdict?: number;
```

- [ ] **Step 4: Filter in `getRecentSessions`**

In `web/src/components/sidebar/utils/utils.ts`, replace the `getRecentSessions` doc comment and body (lines 183-196) with:

```ts
/**
 * 跨项目打平会话，按最近活跃（lastActivity ?? createdAt）倒序，取前 limit 条。
 * 保留助手（is_operator）会话；排除 auto-verdict 会话（is_verdict=1，即「状态判断」
 * 跑出的 headless 会话）。每项目已加载 top-20 活跃会话，足以覆盖全局 top-10。
 */
export const getRecentSessions = (projects: Project[], limit = 10): RecentSessionEntry[] =>
  projects
    .flatMap((project) =>
      (project.sessions ?? [])
        .filter((session) => session.is_verdict !== 1)
        .map((session) => ({ session, project })),
    )
    .sort(
      (a, b) => getSessionDate(b.session).getTime() - getSessionDate(a.session).getTime(),
    )
    .slice(0, limit);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/sidebar/utils/utils.test.ts`

Expected: PASS (all tests, including the pre-existing `getRecentSessions keeps operator workspace sessions`).

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/types/app.ts web/src/components/sidebar/utils/utils.ts web/src/components/sidebar/utils/utils.test.ts
git commit -m "feat(recent-tasks): hide verdict sessions from 最近任务"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run all touched backend test files**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/operator-columns.test.ts server/modules/database/tests/sessions-provider-mapping.test.ts server/modules/operators/tests/operator-headless.test.ts server/modules/projects/services/tests/operator-workspace-mark.test.ts
```

Expected: PASS (all files).

- [ ] **Step 2: Run the touched frontend test file**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/sidebar/utils/utils.test.ts`

Expected: PASS.

- [ ] **Step 3: Backend typecheck (zero new errors)**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json`

Expected: pre-existing baseline errors may remain (see memory `lovdex-backend-baseline-not-clean`); confirm no NEW error references `is_verdict`, `markSessionAsVerdict`, or `sessions.db.ts`/`projects-with-sessions-fetch.service.ts`.

- [ ] **Step 4: Frontend typecheck (zero new errors)**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json`

Expected: no new errors referencing `is_verdict` or `utils.ts`.

---

## Self-Review Notes (checked by author)

- Spec coverage: column+migration (T1), mark upsert + re-index preservation (T2), headless capture+mark (T3), API field (T4), frontend filter + type (T5), verification (T6). All spec sections covered.
- Placeholder scan: none — every code step includes full code; every command has expected output.
- Type consistency: `is_verdict` (snake_case) used uniformly across `SessionRow`, `SESSION_ROW_COLUMNS`, `markSessionAsVerdict`, `SessionSummary`, `SessionRepositoryRow`, `mapSessionRowToSummary`, `ProjectSession`, and `getRecentSessions`. `markSessionAsVerdict(sessionId, projectPath, provider='claude')` signature is used consistently in T2, T3 (`sessionsDb.markSessionAsVerdict(sid, cfg.workspace)`), and T4 (`sessionsDb.markSessionAsVerdict('ws-verdict', workspace)`).
