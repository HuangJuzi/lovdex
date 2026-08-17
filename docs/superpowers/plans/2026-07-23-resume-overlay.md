# `/resume` Web Overlay (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/resume` slash command open a web-native session-picker overlay in lovdex-cli instead of being forwarded to the Claude SDK (where it is a no-op without a TTY). Picking a session switches the active conversation; the backend resumes it via the existing `provider_session_id` mechanism.

**Architecture:** Add `/resume` to the backend's built-in command list with a new `metadata.handler: "ui-overlay"` marker. The frontend's slash-command interception in `useChatComposerState` detects this marker and opens a `Dialog`+`Command` (cmdk) overlay instead of calling `executeCommand` or `chat.send`. The overlay lists sessions from `GET /api/projects/:projectId/sessions`; on select it calls `handleSessionSelect` (the same handler the sidebar uses), which sets `selectedSession` and navigates to `/session/:id`. No backend resume API is needed — `chat-websocket.service.ts` already resolves `provider_session_id` from the sessions DB on the next `chat.send`.

**Tech Stack:** React 18 + TypeScript + Vite (frontend), Express (backend), `node:test` + `tsx` (tests), shared `Dialog` + `Command` (cmdk) UI primitives.

**Repo note:** `/mnt/b/workdir/github/lovdex` is not a git repo, but `lovdex-backend/` and `lovdex-cli/` each are. Commit inside the sub-repo you changed.

---

## File Structure

**Backend (`lovdex-backend/`):**
- Modify: `server/routes/commands.js` — add `/resume` to `builtInCommands`, export `builtInCommands` for tests.
- Test: `server/routes/tests/commands.test.js` — assert `/resume` is present with `handler: "ui-overlay"`.

**Frontend (`lovdex-cli/`):**
- Create: `src/components/chat/view/subcomponents/ResumeSessionOverlay.tsx` — the session-picker overlay (Dialog + Command).
- Modify: `src/components/chat/hooks/useChatComposerState.ts` — add `onResumeSession` prop + `resumeOverlayOpen` state; branch the interception to open the overlay; return overlay state.
- Modify: `src/components/chat/view/ChatInterface.tsx` — accept + forward `onResumeSession`, render `<ResumeSessionOverlay>`.
- Modify: `src/components/chat/types/types.ts` — add `onResumeSession` to the chat props type (mirror `onShowSettings`).
- Modify: `src/components/main-content/view/MainContent.tsx` — accept + forward `onResumeSession` (mirror `onShowSettings`).
- Modify: `src/components/app/AppContent.tsx` — pass `onResumeSession={handleSessionSelect}`.

---

## Task 1: Backend — register `/resume` as a `ui-overlay` command

**Files:**
- Modify: `lovdex-backend/server/routes/commands.js:159-208`
- Test: `lovdex-backend/server/routes/tests/commands.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/routes/tests/commands.test.js`:

```js
import { builtInCommands } from '../commands.js';

test('built-in commands include /resume as a ui-overlay command', () => {
  const resume = builtInCommands.find((cmd) => cmd.name === '/resume');
  assert.ok(resume, '/resume should be a built-in command');
  assert.equal(resume.namespace, 'builtin');
  assert.equal(resume.metadata?.type, 'builtin');
  assert.equal(resume.metadata?.handler, 'ui-overlay');
  assert.equal(resume.metadata?.overlay, 'resume');
  assert.equal(resume.metadata?.forwardToProvider, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `lovdex-backend/`):
```bash
npx tsx --test server/routes/tests/commands.test.js
```
Expected: FAIL — `builtInCommands` is not exported (import error) or `/resume` not found.

- [ ] **Step 3: Export `builtInCommands` and add the `/resume` entry**

In `server/routes/commands.js`, change the declaration at line 159 from `const builtInCommands = [` to `export const builtInCommands = [`.

Add a new entry to the array (insert after the `/status` entry, before the closing `]` at line 208):

```js
  {
    name: "/resume",
    description: "Resume an earlier conversation (opens a session picker)",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "resume" },
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx tsx --test server/routes/tests/commands.test.js
```
Expected: PASS (3 tests, 0 fail).

- [ ] **Step 5: Lint + typecheck**

Run:
```bash
npm run lint
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/routes/commands.js server/routes/tests/commands.test.js
git commit -m "feat(commands): register /resume as a ui-overlay built-in command"
```

---

## Task 2: Frontend — create `ResumeSessionOverlay` component

**Files:**
- Create: `lovdex-cli/src/components/chat/view/subcomponents/ResumeSessionOverlay.tsx`

Reference: the shared `Dialog` lives at `src/shared/view/ui/Dialog.tsx` (exports `Dialog`, `DialogContent`, `DialogTitle`). The shared `Command` (cmdk) lives at `src/shared/view/ui/Command.tsx` (exports `Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`). The API helper `api.projectSessions(projectId, { limit, offset })` exists in `src/utils/api` (used by `useProjectsState`); `ProjectSession` and `LLMProvider` are in `src/types/app.ts`.

- [ ] **Step 1: Write the component**

Create `src/components/chat/view/subcomponents/ResumeSessionOverlay.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../../shared/view/ui/Command';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui/Dialog';
import { api } from '../../../../utils/api';
import type { LLMProvider, ProjectSession } from '../../../../types/app';

interface ResumeSessionOverlayProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  provider: LLMProvider;
  onSelect: (session: ProjectSession) => void;
}

const formatRelativeTime = (iso?: string): string => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

export function ResumeSessionOverlay({
  open,
  onClose,
  projectId,
  provider,
  onSelect,
}: ResumeSessionOverlayProps) {
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .projectSessions(projectId, { limit: 50, offset: 0 })
      .then((page) => {
        if (cancelled) return;
        setSessions(page.sessions ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? 'Failed to load sessions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const filtered = useMemo(() => {
    return sessions.filter((session) => {
      const p = (session.provider ?? session.__provider) as LLMProvider | undefined;
      return !p || p === provider;
    });
  }, [sessions, provider]);

  const handleSelect = useCallback(
    (session: ProjectSession) => {
      onSelect(session);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[min(70dvh,32rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col gap-3 p-4">
        <DialogTitle>Resume a conversation</DialogTitle>
        <CommandInput placeholder="Search sessions…" />
        <CommandList>
          {loading && <div className="px-3 py-2 text-sm opacity-70">Loading…</div>}
          {error && <div className="px-3 py-2 text-sm text-red-500">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <CommandEmpty>No conversations found.</CommandEmpty>
          )}
          {!loading && !error && filtered.length > 0 && (
            <CommandGroup heading="Recent conversations">
              {filtered.map((session) => (
                <CommandItem
                  key={session.id}
                  value={`${session.title ?? session.summary ?? session.id} ${session.id}`}
                  onSelect={() => handleSelect(session)}
                >
                  <div className="flex w-full flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {session.title ?? session.summary ?? 'Untitled conversation'}
                    </span>
                    <span className="text-xs opacity-60">
                      {session.messageCount != null ? `${session.messageCount} messages · ` : ''}
                      {formatRelativeTime(session.lastActivity ?? session.updated_at ?? session.created_at)}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify the API helper signature matches**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
grep -n "projectSessions" src/utils/api.ts src/utils/api/*.ts 2>/dev/null
```
Confirm `api.projectSessions(projectId, { limit, offset })` returns a Promise of `{ sessions: ProjectSession[], sessionMeta: ... }`. If the helper name or shape differs, adjust the import/call in Step 1 to match exactly (do not invent a new helper).

- [ ] **Step 3: Typecheck + lint**

Run:
```bash
npm run typecheck
npm run lint
```
Expected: no errors. (If `Command`/`Dialog` prop names differ from what's used, fix to match the real exports in `src/shared/view/ui/Command.tsx` and `Dialog.tsx`.)

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/chat/view/subcomponents/ResumeSessionOverlay.tsx
git commit -m "feat(chat): add ResumeSessionOverlay component"
```

---

## Task 3: Frontend — thread `onResumeSession` prop through the chat tree

Mirror the existing `onShowSettings` prop chain exactly. The chain is:
`AppContent.tsx:250` → `MainContent.tsx:31,86` → `ChatInterface.tsx:30,212,359` → `useChatComposerState.ts:67,212`.

**Files:**
- Modify: `lovdex-cli/src/components/chat/types/types.ts:132`
- Modify: `lovdex-cli/src/components/chat/hooks/useChatComposerState.ts:67,212`
- Modify: `lovdex-cli/src/components/chat/view/ChatInterface.tsx:30,212,359`
- Modify: `lovdex-cli/src/components/main-content/view/MainContent.tsx:31,86`
- Modify: `lovdex-cli/src/components/main-content/types/types.ts:61`
- Modify: `lovdex-cli/src/components/app/AppContent.tsx:250`

- [ ] **Step 1: Add the prop to the chat types**

In `src/components/chat/types/types.ts`, find the `onShowSettings?: () => void;` line (line 132) and add immediately after it:

```ts
  onResumeSession?: (session: ProjectSession) => void;
```

Ensure `ProjectSession` is imported at the top of the file (add `import type { ProjectSession } from '../../../types/app';` if not already present).

- [ ] **Step 2: Add the prop to `useChatComposerState`**

In `src/components/chat/hooks/useChatComposerState.ts`:
- At line 67 (the `onShowSettings?: () => void;` in the options interface), add after it:
  ```ts
    onResumeSession?: (session: ProjectSession) => void;
  ```
- At line 212 (the destructured `onShowSettings,`), add after it:
  ```ts
    onResumeSession,
  ```
- Ensure `ProjectSession` is imported from `../../../types/app`.

- [ ] **Step 3: Add the prop to `ChatInterface`**

In `src/components/chat/view/ChatInterface.tsx`:
- At line 30 (destructured `onShowSettings,`), add `onResumeSession,` after it.
- At line 359 (`onShowSettings={onShowSettings}`), add `onResumeSession={onResumeSession}` after it.
- If there is a local props type for `ChatInterface`, add `onResumeSession?: (session: ProjectSession) => void;` next to `onShowSettings?: () => void;` and import `ProjectSession`.

- [ ] **Step 4: Add the prop to `MainContent`**

In `src/components/main-content/view/MainContent.tsx`:
- At line 31 (destructured `onShowSettings,`), add `onResumeSession,` after it.
- At line 86 (`onShowSettings={onShowSettings}`), add `onResumeSession={onResumeSession}` after it.
In `src/components/main-content/types/types.ts` at line 61 (`onShowSettings: (tab?: SettingsMainTab) => void;`), add after it:
```ts
  onResumeSession: (session: ProjectSession) => void;
```
with the `ProjectSession` import added.

- [ ] **Step 5: Pass `handleSessionSelect` from `AppContent`**

In `src/components/app/AppContent.tsx`, at line 250 (`onShowSettings={openSettings}`), add immediately after it:
```tsx
          onResumeSession={handleSessionSelect}
```
`handleSessionSelect` is already available in `AppContent` from `useProjectsState` (it is the same function the sidebar's `onSessionSelect` uses). Verify it is in scope:
```bash
grep -n "handleSessionSelect" src/components/app/AppContent.tsx
```
If the variable is named differently in `AppContent` (e.g. it's threaded from a parent), use the exact name that is in scope for the session-select handler passed to the sidebar.

- [ ] **Step 6: Typecheck + lint**

Run:
```bash
npm run typecheck
npm run lint
```
Expected: no errors. (Unused-variable warnings for `onResumeSession` are expected until Task 4 wires it — if lint fails on unused, proceed to Task 4 before committing, or commit Tasks 3+4 together.)

- [ ] **Step 7: Commit (together with Task 4 to avoid an unused-prop intermediate)**

Hold the commit until Task 4 completes, then commit both together.

---

## Task 4: Frontend — wire the interception to open the overlay and render it

**Files:**
- Modify: `lovdex-cli/src/components/chat/hooks/useChatComposerState.ts` (interception block ~lines 686-722, hook return ~lines 1189)
- Modify: `lovdex-cli/src/components/chat/view/ChatInterface.tsx` (render the overlay)

- [ ] **Step 1: Add `resumeOverlayOpen` state to the hook**

In `src/components/chat/hooks/useChatComposerState.ts`, near the other `useState` declarations (search for `const [isTextareaExpanded`), add:

```ts
  const [resumeOverlayOpen, setResumeOverlayOpen] = useState(false);
```

(`useState` is already imported at the top of the file.)

- [ ] **Step 2: Branch the interception for `ui-overlay` commands**

Find the interception block that begins with the comment `// Intercept slash commands only when "/" is the first input character.` (around line 686). After the line:

```ts
        const isForwardToProvider = matchedCommand?.metadata?.forwardToProvider === true;
```

and **before** the existing `if (matchedCommand && matchedCommand.type !== 'skill' && !isForwardToProvider) {` block, insert:

```ts
        const isUiOverlay = matchedCommand?.metadata?.handler === 'ui-overlay';
        if (matchedCommand && matchedCommand.type !== 'skill' && isUiOverlay) {
          const overlay = matchedCommand.metadata?.overlay;
          if (overlay === 'resume') {
            setResumeOverlayOpen(true);
            setInput('');
            inputValueRef.current = '';
            setAttachedImages([]);
            setUploadingImages(new Map());
            setImageErrors(new Map());
            resetCommandMenuState();
            setIsTextareaExpanded(false);
            if (textareaRef.current) {
              textareaRef.current.style.height = 'auto';
            }
            return;
          }
        }
```

This mirrors the reset logic already used by the `executeCommand` branch directly below it.

- [ ] **Step 3: Return overlay state from the hook**

Find the hook's `return {` statement (around line 1189, where `slashCommands,` is returned). Add to the returned object:

```ts
    resumeOverlayOpen,
    setResumeOverlayOpen,
    onResumeSession,
```

- [ ] **Step 4: Render the overlay in `ChatInterface`**

In `src/components/chat/view/ChatInterface.tsx`, add an import at the top:

```tsx
import { ResumeSessionOverlay } from './subcomponents/ResumeSessionOverlay';
```

Find where `useChatComposerState` is called and its result is destructured (search for `slashCommands,` in this file). Add to that destructuring:

```tsx
  resumeOverlayOpen,
  setResumeOverlayOpen,
  onResumeSession,
```

Add the overlay JSX near the other modals (search for `CommandResultModal` usage and place alongside it):

```tsx
        <ResumeSessionOverlay
          open={resumeOverlayOpen}
          onClose={() => setResumeOverlayOpen(false)}
          projectId={selectedProject?.projectId ?? ''}
          provider={provider}
          onSelect={(session) => onResumeSession?.(session)}
        />
```

Use the exact `selectedProject` and `provider` variable names that are in scope in `ChatInterface` (verify with `grep -n "selectedProject\|provider" src/components/chat/view/ChatInterface.tsx | head`).

- [ ] **Step 5: Typecheck + lint**

Run:
```bash
npm run typecheck
npm run lint
```
Expected: no errors.

- [ ] **Step 6: Commit (Tasks 3 + 4 together)**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/chat/types/types.ts \
        src/components/chat/hooks/useChatComposerState.ts \
        src/components/chat/view/ChatInterface.tsx \
        src/components/main-content/view/MainContent.tsx \
        src/components/main-content/types/types.ts \
        src/components/app/AppContent.tsx
git commit -m "feat(chat): wire /resume slash command to a session-picker overlay"
```

---

## Task 5: End-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Start both services**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npm run dev &
cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run dev &
```
Confirm backend on `http://localhost:3001` and frontend on `http://localhost:5187` (check the terminal output).

- [ ] **Step 2: Verify `/resume` appears in the slash menu**

In a browser, open `http://localhost:5187`, select a project, focus the chat input, and type `/`. Confirm `/resume` appears in the command popover with the description "Resume an earlier conversation (opens a session picker)".

- [ ] **Step 3: Verify the overlay opens and switching works**

Type `/resume` and press Enter. Confirm the session-picker dialog opens listing past conversations for the current project/provider. Click a session. Confirm:
- The dialog closes.
- The active conversation switches to that session (URL becomes `/session/<id>`, the message list shows that session's history).
- Typing a new message and sending continues the resumed session (the backend logs `resume=true` for the `chat.send`).

- [ ] **Step 4: Verify `/resume` is NOT sent to the provider**

While sending a message after resuming, confirm in the backend terminal that the resumed session's `provider_session_id` is used (the existing `[chat.send] spawning claude ... resume=true` log line appears). Confirm no user message with the literal text `/resume` is forwarded.

- [ ] **Step 5: Commit any fixups discovered during smoke test**

If the smoke test surfaced bugs, fix them, re-run `npm run typecheck && npm run lint` in the affected sub-repo, and commit:
```bash
git commit -m "fix(chat): correct <issue> in /resume overlay"
```

---

## Self-Review notes

- **Spec coverage:** Phase 1 scope (overlay framework + `/resume`) is fully covered by Tasks 1–5. The `ui-overlay` handler marker introduced here is the extension point for Phase 2+ commands (`/model`, `/config`, `/mcp`).
- **No placeholders:** All file paths, line numbers, and code blocks are concrete. Where a variable name in scope must be confirmed (e.g. `selectedProject` in `ChatInterface`), an explicit `grep` verification step is included.
- **Type consistency:** `onResumeSession: (session: ProjectSession) => void` is used consistently across the prop chain and the overlay's `onSelect`. `resumeOverlayOpen`/`setResumeOverlayOpen` are produced in the hook and consumed in `ChatInterface`.
- **Testing:** Backend change is unit-tested with `node:test` (existing infra). Frontend change is verified by `typecheck` + `lint` + manual smoke test, because the repo has no JS DOM test setup; introducing one is out of Phase 1 scope.
