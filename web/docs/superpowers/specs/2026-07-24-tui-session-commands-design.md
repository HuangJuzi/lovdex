# TUI Session Commands (`/branch` `/fork` `/rewind`) — Design

- Date: 2026-07-24
- Status: Approved (brainstormed)
- Scope: `lovdex-cli` frontend + `lovdex-backend` (cross-cutting)

## 1. Goal

Support the session-class TUI slash commands `/branch`, `/fork`, `/rewind` in lovdex's
web UI, so that typing them in the composer behaves like Claude Code's CLI rather than
being forwarded as a literal prompt. `/resume` and `/clear` are already implemented and
are out of scope except as the template this design follows.

## 2. Background — existing plumbing

### Command interception (frontend)
`src/components/chat/hooks/useChatComposerState.ts:686` intercepts input starting with
`/`, looks the command up in the table fetched from the backend, and dispatches:
- `metadata.forwardToProvider === true` → falls through to `chat.send` (raw text to SDK).
  Used by `/clear`, `/compact`.
- `metadata.handler === 'ui-overlay'` → opens a frontend overlay instead of contacting the
  provider. Currently the only overlay is `resume` (`useChatComposerState.ts:711`):
  ```ts
  if (overlay === 'resume') { setResumeOverlayOpen(true); ... return; }
  ```
- otherwise → `executeCommand` (local builtin handler, e.g. `/help`, `/model`).

### `/resume` end-to-end (the template)
- Backend `server/routes/commands.js:209` registers `/resume` with
  `metadata: { type: "builtin", handler: "ui-overlay", overlay: "resume" }`.
- Frontend `ResumeSessionOverlay.tsx` (148 lines) renders a session picker; on select it
  calls `onResumeSession` → `handleSessionSelect` in `AppContent.tsx:252`, which switches
  the active session. No new backend endpoint was needed — it reuses the existing session
  list + history APIs.

### Session model (backend)
- App session row (`sessions.db.ts`) wraps a provider session. `provider_session_id` is the
  Claude/Codex SDK session UUID; `assignProviderSessionId` links it.
- `chat.send` (`chat-websocket.service.ts:146`) auto-resumes: if the app session has a
  `provider_session_id`, the SDK is spawned with `resume: true` and that id.
- `sessionsService` exposes `listArchivedSessions`, `fetchHistory`, `restoreSessionById`,
  `renameSessionById`, etc. History messages carry an `id` field = the provider message
  UUID (`raw.uuid`, see `claude-sessions.provider.ts:332` `baseId`). This `id` is what
  `forkSession`'s `upToMessageId` expects. The frontend `ChatMessage` TS type does not
  currently declare `id` (it's present at runtime via the history payload); this design
  adds `id?: string` to `ChatMessage` so the turn picker can read it.

### SDK primitives available (unwired)
`@anthropic-ai/claude-agent-sdk` 0.3.210 exposes:
- `forkSession(sessionId, { upToMessageId, ... })` → forks a provider session into a new
  one with fresh UUIDs, optionally truncated to `upToMessageId`. Forked sessions start
  without file-history snapshots (per `sdk.d.ts:660`).
- `Query.rewindFiles()` / `SDKControlRewindFilesRequest` → roll file state back to a
  checkpoint (requires `enableFileCheckpointing`).
- `SDKControlInterruptRequest`, `SDKControlRenameSessionRequest`, etc.

The backend currently invokes only `chat.send` / `chat.abort`; `forkSession` and the
control requests are not wired.

## 3. Non-goals (YAGNI)

- No in-place mutation of the original session. All three commands fork into a **new**
  session and switch to it; the original stays in the session list. This matches
  `forkSession`'s immutable-history semantics and the web "undo by going back to the
  original" expectation.
- No `/rewind` of file state via SDK file checkpoints. File rewind uses git (the project
  is a git repo in the cases that matter); non-git projects get conversation-only rewind
  with a clear warning. Wiring `enableFileCheckpointing` + `rewindFiles` is deferred.
- No new WS message types. These are one-shot operations; REST endpoints fit (mirrors
  `/resume`, which uses existing REST + no WS).
- No Codex support in the first cut. `forkSession` is Claude-SDK-only; Codex sessions get
  a "not supported for this provider" overlay state. (Capability check via
  `provider-capabilities.service.ts`.)
- No changes to `/clear` (already `forwardToProvider` and working).

## 4. Command semantics (web mapping)

| Command | Overlay | Default turn | Backend action | Frontend result |
|---|---|---|---|---|
| `/branch` | turn picker | user-selected | `forkSession(upToMessageId)` | switch to new session |
| `/fork` | confirm dialog | current last turn | `forkSession()` (no `upToMessageId`) | switch to new session |
| `/rewind` | turn picker | user-selected | `forkSession(upToMessageId)` + git file rewind | switch to new session |

`/fork` vs `/branch`: identical mechanism, different default turn. `/fork` = "snapshot
now and jump to the copy"; `/branch` = "go back to a chosen turn and continue from there".

## 5. Architecture

### 5.1 Backend

**Command registration** — `server/routes/commands.js`, append to `builtInCommands`:
```js
{ name: "/branch",  description: "Branch this conversation from a chosen turn",
  namespace: "builtin", metadata: { type: "builtin", handler: "ui-overlay", overlay: "branch" } },
{ name: "/fork",   description: "Fork this conversation into a new session",
  namespace: "builtin", metadata: { type: "builtin", handler: "ui-overlay", overlay: "fork" } },
{ name: "/rewind", description: "Rewind code and conversation to a chosen turn",
  namespace: "builtin", metadata: { type: "builtin", handler: "ui-overlay", overlay: "rewind" } },
```

**New REST endpoints** — new `server/routes/sessions.js` (mounted in `server/index.js`),
all require auth + project membership:
- `POST /api/sessions/:appId/fork` — body `{ upToMessageId?: string }`.
  1. Load app session row; require `provider_session_id` (else `409 SESSION_NOT_STARTED`).
  2. Require provider capability `forkSession` (else `409 UNSUPPORTED_PROVIDER`).
  3. Acquire the session's run lock from `chat-run-registry.service.ts` to block concurrent
     runs; `409 RUN_IN_PROGRESS` if a run is active.
  4. `const { sessionId: newProviderId } = await forkSession(providerSessionId, { upToMessageId })`.
  5. `const newAppId = sessionsDb.createAppSession(provider, projectPath)`; copy custom
     name with " (branch|fork|rewind)" suffix via `sessionsDb.updateSessionCustomName`;
     `sessionsDb.assignProviderSessionId(newAppId, newProviderId)`.
  6. Return `{ newSessionId: newAppId, providerSessionId: newProviderId }`.
- `POST /api/sessions/:appId/rewind` — body `{ upToMessageId: string }`.
  1. Same preconditions + fork as above.
  2. File rewind: if `projectPath` is a git repo (`git -C <path> rev-parse` succeeds),
     restore tracked files to the state recorded at that turn. Source of truth for the
     snapshot: the most recent git commit at or before the turn's timestamp (turns carry
     timestamps from `fetchHistory`). Implementation: `git -C <path> stash --include-untracked`
     (preserve user's working changes) then `git -C <path> checkout <commit> -- .` for
     tracked files touched since. If no commit covers the turn, skip file rewind and
     return `warnings: ["file-rewind:no-covering-commit"]`.
  3. Non-git project: skip file rewind, return `warnings: ["file-rewind:not-a-git-repo"]`.
  4. Return same shape as fork plus `warnings`.

The existing `forwardToProviderCommand` and `builtInHandlers` are untouched.

### 5.2 Frontend

**Overlay dispatch** — extend the `isUiOverlay` block in `useChatComposerState.ts:711`:
```ts
if (overlay === 'resume') { setResumeOverlayOpen(true); ... return; }
if (overlay === 'branch') { setBranchOverlayOpen(true); ... return; }
if (overlay === 'fork')   { setForkOverlayOpen(true);   ... return; }
if (overlay === 'rewind') { setRewindOverlayOpen(true); ... return; }
```
(Each branch resets input/images/menu state identical to the `resume` branch.)

**Shared turn picker** — new `src/components/chat/view/subcomponents/TurnPickerOverlay.tsx`,
a thin wrapper over the existing `Dialog` primitive (same one `ResumeSessionOverlay` uses).
Props: `{ open, onOpenChange, turns: { id, summary, timestamp }[], onSelect, title }`
where `id` is the message's provider UUID (the `id` field from the history payload).
Renders the current session's turns (sourced from the already-loaded history in
`useChatMessages` / `sessionsService.fetchHistory`) as a selectable list with timestamp +
turn summary. `ResumeSessionOverlay` is left as-is (it picks *sessions*, not *turns* —
different data); only the Dialog shell is shared.

**ChatMessage type** — add `id?: string` to `ChatMessage` in
`src/components/chat/types/types.ts` (already present in the runtime history payload, just
not declared).

**Three overlay components** under `src/components/chat/view/subcomponents/`:
- `BranchOverlay.tsx` — uses `TurnPickerOverlay`, on select calls
  `api.forkSession(appId, { upToMessageId: turn.id })` then `onSwitchSession(newSession)`.
- `ForkOverlay.tsx` — confirm-only (no turn picker), calls
  `api.forkSession(appId, {})` then `onSwitchSession`.
- `RewindOverlay.tsx` — uses `TurnPickerOverlay`, calls
  `api.rewindSession(appId, { upToMessageId: turn.id })`, surfaces any `warnings` inline
  before switching.

**API client** — `src/utils/api.js`: add `forkSession(appId, body)` →
`POST /api/sessions/:appId/fork` and `rewindSession(appId, body)` →
`POST /api/sessions/:appId/rewind` (both via `authenticatedFetch`).

**Switch session** — all three reuse the existing `handleSessionSelect` (`AppContent.tsx`),
the same path `/resume` uses. No new session-switch machinery.

**Wiring** — thread `onSwitchSession` and overlay open state through
`ChatInterface → MainContent → AppContent` exactly as `onResumeSession` is threaded today.
Render the three overlays alongside `ResumeSessionOverlay` in `ChatInterface.tsx:468`.

### 5.3 Data flow (example: `/branch`)

```
user types /branch
  → composer intercepts, overlay==='branch' → setBranchOverlayOpen(true)
  → BranchOverlay shows TurnPickerOverlay (turns from loaded history)
  → user picks turn T
  → api.forkSession(appId, { upToMessageId: T.messageId })
  → POST /api/sessions/:appId/fork
  → backend: forkSession(providerSessionId, { upToMessageId }) → newProviderId
  → backend: createAppSession + assignProviderSessionId → newAppId
  → { newSessionId: newAppId }
  → frontend: onSwitchSession(newAppId)  (= handleSessionSelect)
  → session list highlights newAppId, history loads for it, composer ready
```

## 6. Error handling

| Case | Behavior |
|---|---|
| No `provider_session_id` yet (first turn never sent) | Overlay shows "This conversation hasn't started yet." before calling the endpoint; endpoint also returns `409 SESSION_NOT_STARTED` as a guard. |
| Provider lacks `forkSession` (Codex) | Endpoint `409 UNSUPPORTED_PROVIDER`; overlay shows "Not supported for this provider." |
| A run is in progress on the session | Endpoint `409 RUN_IN_PROGRESS`; overlay shows "Stop the running response first." |
| `forkSession` throws | Endpoint `500`; overlay shows generic error + retry. |
| `/rewind` on non-git project | Endpoint succeeds with `warnings: ["file-rewind:not-a-git-repo"]`; RewindOverlay shows a banner "Conversation rewound; file changes left untouched (not a git repo)." before switching. |
| `/rewind` with no covering commit | Succeeds with `warnings: ["file-rewind:no-covering-commit"]`; banner shown. |
| Concurrent fork on same session | Run lock serializes; second call gets `409 RUN_IN_PROGRESS`. |

## 7. Testing

### Backend (`server/routes/tests/`)
- `sessions.fork.test.ts` — mock `forkSession`; assert new app session row created with
  correct provider id + suffixed custom name; assert `409` paths
  (not-started, unsupported-provider, run-in-progress).
- `sessions.rewind.test.ts` — git rewind in a temp repo: create a commit, advance files,
  rewind to the commit, assert file contents; non-git path returns the warning; no-covering-
  commit path returns the warning.

### Frontend (`src/components/chat/view/subcomponents/`)
- `TurnPickerOverlay.test.tsx` — renders turns, onSelect fires with chosen `messageId`.
- `BranchOverlay.test.tsx` / `ForkOverlay.test.tsx` / `RewindOverlay.test.tsx` — mock
  `api.forkSession`/`rewindSession`, assert `onSwitchSession` called with returned id;
  rewind warning banner assertion.

## 8. Open questions

None blocking. Deferred (out of scope): SDK `enableFileCheckpointing` + `rewindFiles` as a
non-git file-rewind path; `/rewind`/`/branch` for Codex once the Codex SDK exposes an
equivalent fork primitive.
