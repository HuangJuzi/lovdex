# Project List Status Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every session and project a status dot (green = running, yellow = idle, amber = needs attention), make the selected session clearly highlighted (border + left accent bar + tint + bolder name), replace the full-width "New Session" buttons with a per-project `+`, and sort active projects to the top.

**Architecture:** Pure helpers (`isProjectActive`, `getSessionDotState`, extended `sortProjects`) in `utils.ts` own the logic and are unit-tested; `useSidebarController` threads `activeSessionIds` into the sort; the two row components consume state for rendering. No new dependencies.

**Tech Stack:** React + TypeScript, Vite, Tailwind. Tests: `npx tsx --test <file>` (node:test + `node:assert/strict`). No `test` script in package.json.

**Spec:** `docs/superpowers/specs/2026-08-04-project-list-status-design.md`

---

## File Structure

- Modify: `src/components/sidebar/utils/utils.ts` — add `isProjectActive`, `getSessionDotState` (+ `SessionDotState` type); extend `sortProjects` with `activeSessionIds`.
- Create: `src/components/sidebar/utils/utils.test.ts` — unit tests for all three.
- Modify: `src/components/sidebar/hooks/useSidebarController.ts` — pass `activeSessionIds` into `sortProjects` (currently at lines 587-590).
- Modify: `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx` — always-on status dot + Option-A selected style.
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx` — activity dot + `+` new-session button (mobile + desktop).
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx` — remove both New Session buttons and now-unused `onNewSession`/`onProjectSelect` props.
- Modify: `src/i18n/locales/en/sidebar.json` — add new `tooltips.*` keys.

---

### Task 1: Pure helpers + tests

**Files:**
- Create: `src/components/sidebar/utils/utils.test.ts`
- Modify: `src/components/sidebar/utils/utils.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/sidebar/utils/utils.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Project, ProjectSession } from '../../../types/app';
import { getSessionDotState, isProjectActive, sortProjects } from './utils';

const mkSession = (id: string, lastActivity?: string): ProjectSession => ({
  id,
  summary: `session ${id}`,
  lastActivity,
});

const mkProject = (
  projectId: string,
  displayName: string,
  opts: { isStarred?: boolean; sessions?: ProjectSession[] } = {},
): Project => ({
  projectId,
  displayName,
  fullPath: `/${projectId}`,
  isStarred: opts.isStarred ?? false,
  sessions: opts.sessions ?? [],
});

test('isProjectActive returns true when any loaded session is processing', () => {
  const project = mkProject('p1', 'P1', { sessions: [mkSession('s1'), mkSession('s2')] });
  assert.equal(isProjectActive(project, new Set(['s2'])), true);
});

test('isProjectActive handles numeric session ids', () => {
  const project = mkProject('p1', 'P1', { sessions: [{ id: '42', summary: 'x' }] });
  assert.equal(isProjectActive(project, new Set(['42'])), true);
});

test('isProjectActive returns false when no session is processing', () => {
  const project = mkProject('p1', 'P1', { sessions: [mkSession('s1')] });
  assert.equal(isProjectActive(project, new Set(['other'])), false);
});

test('isProjectActive returns false for empty or missing session lists', () => {
  assert.equal(isProjectActive(mkProject('p1', 'P1'), new Set(['s1'])), false);
  const noSessions: Project = { projectId: 'p2', displayName: 'P2', fullPath: '/p2' };
  assert.equal(isProjectActive(noSessions, new Set(['s1'])), false);
});

test('isProjectActive returns false for an empty active set', () => {
  const project = mkProject('p1', 'P1', { sessions: [mkSession('s1')] });
  assert.equal(isProjectActive(project, new Set()), false);
});

test('getSessionDotState prioritizes attention over running', () => {
  assert.equal(getSessionDotState(true, true), 'attention');
  assert.equal(getSessionDotState(true, false), 'attention');
});

test('getSessionDotState maps running to active and idle otherwise', () => {
  assert.equal(getSessionDotState(false, true), 'active');
  assert.equal(getSessionDotState(false, false), 'idle');
});

test('sortProjects floats active projects above inactive regardless of star', () => {
  const activeUnstarred = mkProject('pa', 'Active project', { sessions: [mkSession('a1')] });
  const inactiveStarred = mkProject('pb', 'Starred idle', { isStarred: true });
  const result = sortProjects([inactiveStarred, activeUnstarred], 'name', new Set(['a1']));
  assert.deepEqual(result.map((p) => p.projectId), ['pa', 'pb']);
});

test('sortProjects keeps starred first within the same activity bucket', () => {
  const activeStarred = mkProject('pa', 'B', { isStarred: true, sessions: [mkSession('a1')] });
  const activeUnstarred = mkProject('pb', 'A', { sessions: [mkSession('a1')] });
  const result = sortProjects([activeUnstarred, activeStarred], 'name', new Set(['a1']));
  assert.deepEqual(result.map((p) => p.projectId), ['pa', 'pb']);
});

test('sortProjects falls back to name order for idle projects', () => {
  const result = sortProjects(
    [mkProject('zc', 'Charlie'), mkProject('aa', 'Alpha'), mkProject('bb', 'Bravo')],
    'name',
    new Set(),
  );
  assert.deepEqual(result.map((p) => p.projectId), ['aa', 'bb', 'zc']);
});

test('sortProjects uses date order within an activity bucket', () => {
  const older = mkProject('older', 'Older', { sessions: [mkSession('s1', '2026-01-01T00:00:00Z')] });
  const newer = mkProject('newer', 'Newer', { sessions: [mkSession('s2', '2026-02-01T00:00:00Z')] });
  const result = sortProjects([older, newer], 'date', new Set());
  assert.deepEqual(result.map((p) => p.projectId), ['newer', 'older']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/components/sidebar/utils/utils.test.ts`
Expected: FAIL — `isProjectActive is not a function` (helpers don't exist yet) and `sortProjects` still takes 2 args.

- [ ] **Step 3: Write the implementation**

In `src/components/sidebar/utils/utils.ts`, add these exports (place after the `sortProjects` block, before `filterProjects`):

```ts
/** True when any of the project's loaded sessions is currently processing. */
export const isProjectActive = (
  project: Project,
  activeSessionIds: ReadonlySet<string>,
): boolean => {
  return (project.sessions ?? []).some((session) => activeSessionIds.has(String(session.id)));
};

export type SessionDotState = 'attention' | 'active' | 'idle';

/** Status column for a session row: needs-attention > running > idle. */
export const getSessionDotState = (
  needsAttention: boolean,
  isProcessing: boolean,
): SessionDotState => {
  if (needsAttention) {
    return 'attention';
  }
  if (isProcessing) {
    return 'active';
  }
  return 'idle';
};
```

Then replace the existing `sortProjects` signature and add the active-first branch. Current code:

```ts
export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};
```

New code:

```ts
export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
  activeSessionIds: ReadonlySet<string>,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Projects with a running session float to the top, ahead of starred
    // projects and the name/date order.
    const aActive = isProjectActive(projectA, activeSessionIds);
    const bActive = isProjectActive(projectB, activeSessionIds);

    if (aActive && !bActive) {
      return -1;
    }

    if (!aActive && bActive) {
      return 1;
    }

    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/components/sidebar/utils/utils.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/utils/utils.ts src/components/sidebar/utils/utils.test.ts
git commit -m "feat(sidebar): add project/session status helpers + active-first sort
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Thread `activeSessionIds` into the sort

**Files:**
- Modify: `src/components/sidebar/hooks/useSidebarController.ts:587-590`

- [ ] **Step 1: Update the `sortedProjects` memo**

In `src/components/sidebar/hooks/useSidebarController.ts`, change:

```ts
  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState],
  );
```

to:

```ts
  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder, activeSessionIds),
    [projectSortOrder, projectsWithResolvedStarState, activeSessionIds],
  );
```

`activeSessionIds` is already defined above this memo (line 154). `sortProjects` is already imported.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/hooks/useSidebarController.ts
git commit -m "feat(sidebar): sort active projects first in the sidebar
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Session status dot + selected highlight

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx`

- [ ] **Step 1: Import the dot helper and compute state**

At the top of `SidebarSessionItem.tsx`, change the utils import (currently line 9):

```tsx
import { createSessionViewModel } from '../../utils/utils';
```

to:

```tsx
import { createSessionViewModel, getSessionDotState } from '../../utils/utils';
```

Inside the component, replace the two indicator-derived booleans (currently lines 87-88):

```tsx
  const showAttentionIndicator = needsAttention && !isSelected;
  const showRecentIndicator = !showAttentionIndicator && !isProcessing && sessionView.isActive;
```

with the always-on dot state:

```tsx
  const dotState = getSessionDotState(needsAttention, isProcessing);
  const dotLabel =
    dotState === 'attention'
      ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
      : dotState === 'active'
        ? t('tooltips.sessionRunning', 'Session is running')
        : t('tooltips.sessionIdle', 'Session is idle');
```

- [ ] **Step 2: Remove the old absolute-positioned indicator**

Delete the entire conditional indicator block (currently lines 126-146):

```tsx
      {(showAttentionIndicator || showRecentIndicator) && (
        <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
          <Tooltip
            content={showAttentionIndicator
              ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
              : t('tooltips.activeSessionIndicator')}
            position="right"
          >
            <div
              role="status"
              aria-label={showAttentionIndicator
                ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
                : t('tooltips.activeSessionIndicator')}
              className={cn(
                'h-2 w-2 animate-pulse rounded-full',
                showAttentionIndicator ? 'bg-amber-500' : 'bg-green-500',
              )}
            />
          </Tooltip>
        </div>
      )}
```

(`Tooltip` stays imported — it is still used by the processing spinner.)

- [ ] **Step 3: Add the inline dot + selected accent bar (mobile row)**

In the mobile row (inside `<div onClick={selectMobileSession} ...>`), before the provider-logo `<div>` (currently line 162), insert the status dot:

```tsx
            <span
              role="status"
              aria-label={dotLabel}
              className={cn(
                'flex-shrink-0 rounded-full',
                dotState === 'attention' && 'h-2 w-2 animate-pulse bg-amber-500',
                dotState === 'active' && 'h-2 w-2 bg-green-500',
                dotState === 'idle' && 'h-1.5 w-1.5 bg-amber-400',
              )}
            />
```

Then, as the first child inside the mobile row `<div>` (the one with `className={cn('p-2 mx-3 ... relative', ...)}`), insert the selected accent bar:

```tsx
          {isSelected && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-primary" />
          )}
```

Change the mobile row's `className` (currently lines 150-158):

```tsx
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/5 border-primary/20' : '',
            !isSelected && isProcessing
              ? 'border-border/60 bg-muted/20'
              : !isSelected && sessionView.isActive
              ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
              : 'border-border/30',
          )}
```

to:

```tsx
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/10 border-primary/50' : '',
            !isSelected && isProcessing
              ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
              : !isSelected && needsAttention
              ? 'border-amber-500/40 bg-amber-50/5 dark:bg-amber-900/5'
              : 'border-border/30',
          )}
```

Change the mobile session-name div (currently line 173):

```tsx
                <div className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">{sessionView.sessionName}</div>
```

to:

```tsx
                <div className={cn('min-w-0 flex-1 truncate text-sm text-foreground', isSelected ? 'font-medium' : 'font-normal')}>{sessionView.sessionName}</div>
```

- [ ] **Step 4: Add the inline dot + selected accent bar (desktop row)**

In the desktop `<a>` (currently lines 211-230), add `relative` to the base class string and insert the accent bar as the first child. Change the opening tag's `className`:

```tsx
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'h-auto w-full justify-start rounded-md border bg-card p-2 text-left font-normal transition-all duration-150',
            isSelected ? 'border-primary/20 bg-primary/5' : 'border-border/30',
            !isSelected && isProcessing
              ? 'border-border/60 bg-muted/20 hover:bg-muted/25'
              : !isSelected && sessionView.isActive
                ? 'border-green-500/30 bg-green-50/5 hover:bg-green-50/10 dark:bg-green-900/5 dark:hover:bg-green-900/10'
                : 'hover:bg-accent/50',
          )}
```

to:

```tsx
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'relative h-auto w-full justify-start rounded-md border bg-card p-2 text-left font-normal transition-all duration-150',
            isSelected ? 'border-primary/50 bg-primary/10' : 'border-border/30',
            !isSelected && isProcessing
              ? 'border-green-500/30 bg-green-50/5 hover:bg-green-50/10 dark:bg-green-900/5 dark:hover:bg-green-900/10'
              : !isSelected && needsAttention
                ? 'border-amber-500/40 bg-amber-50/5 hover:bg-amber-50/10 dark:bg-amber-900/5 dark:hover:bg-amber-900/10'
                : 'hover:bg-accent/50',
          )}
```

Immediately after the `<a ...>` opening tag, insert:

```tsx
          {isSelected && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-primary" />
          )}
```

Then, inside the anchor's `flex w-full min-w-0 items-center gap-2` div, before the provider-logo `<div>` (currently line 232), insert the same status dot as in Step 3:

```tsx
            <span
              role="status"
              aria-label={dotLabel}
              className={cn(
                'flex-shrink-0 rounded-full',
                dotState === 'attention' && 'h-2 w-2 animate-pulse bg-amber-500',
                dotState === 'active' && 'h-2 w-2 bg-green-500',
                dotState === 'idle' && 'h-1.5 w-1.5 bg-amber-400',
              )}
            />
```

Change the desktop session-name div (currently line 242):

```tsx
                <div className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">{sessionView.sessionName}</div>
```

to:

```tsx
                <div className={cn('min-w-0 flex-1 truncate text-sm text-foreground', isSelected ? 'font-medium' : 'font-normal')}>{sessionView.sessionName}</div>
```

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx
git commit -m "feat(sidebar): always-on session status dot + stronger selected style
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Project row activity dot + `+` button

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`

- [ ] **Step 1: Import `Plus` and compute project activity**

Change the lucide import (currently line 1):

```tsx
import { Check, ChevronDown, ChevronRight, Edit3, Star, Trash2, X } from 'lucide-react';
```

to:

```tsx
import { Check, ChevronDown, ChevronRight, Edit3, Plus, Star, Trash2, X } from 'lucide-react';
```

Inside the component, after `const sessionCountLabel = ...` (line 105), add:

```tsx
  const projectIsActive = sessions.some((session) => activeSessions.has(session.id));
  const projectStatusLabel = projectIsActive
    ? t('tooltips.projectActive', 'Project has a running session')
    : t('tooltips.projectIdle', 'Project is idle');
```

- [ ] **Step 2: Mobile row — dot + `+` button**

In the mobile row's `flex min-w-0 flex-1 items-center gap-3` div, after the star `<button>` (ends at line 160) and before the name `<div className="min-w-0 flex-1">` (line 162), insert:

```tsx
                <span
                  title={projectStatusLabel}
                  className={cn(
                    'flex-shrink-0 rounded-full',
                    projectIsActive ? 'h-2 w-2 bg-green-500' : 'h-1.5 w-1.5 bg-amber-400',
                  )}
                />
```

In the mobile row's right-side actions `<div className="flex items-center gap-1">`, inside the `!isEditing` branch and before the delete button (currently line 230), insert:

```tsx
                  <button
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                    onClick={(event) => {
                      event.stopPropagation();
                      onNewSession(project);
                    }}
                    aria-label={t('tooltips.newSession', 'Start a new session in this project')}
                  >
                    <Plus className="h-4 w-4 text-primary" />
                  </button>
```

- [ ] **Step 3: Desktop row — dot + `+` button**

In the desktop row's `flex min-w-0 flex-1 items-center gap-3` div, after the star `<div>` (ends at line 297) and before the name `<div className="min-w-0 flex-1 text-left">` (line 298), insert:

```tsx
            <span
              title={projectStatusLabel}
              className={cn(
                'flex-shrink-0 rounded-full',
                projectIsActive ? 'h-2 w-2 bg-green-500' : 'h-1.5 w-1.5 bg-amber-400',
              )}
            />
```

In the desktop row's right-side actions `<div className="flex flex-shrink-0 items-center gap-1">`, inside the `!isEditing` branch and before the edit `<div>` (currently line 364), insert:

```tsx
                <button
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewSession(project);
                  }}
                  title={t('tooltips.newSession', 'Start a new session in this project')}
                  aria-label={t('tooltips.newSession', 'Start a new session in this project')}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx
git commit -m "feat(sidebar): project activity dot + per-project new-session button
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Remove full-width New Session buttons + i18n keys

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx`
- Modify: `src/i18n/locales/en/sidebar.json`

- [ ] **Step 1: Remove the two buttons and unused props**

In `SidebarProjectSessions.tsx`:

1. Change the lucide import (line 1):

```tsx
import { Plus } from 'lucide-react';
```

Remove this import entirely (nothing else uses `Plus` in this file).

2. Remove `onProjectSelect` from `SidebarProjectSessionsProps` (currently line 28) and `onNewSession` (currently line 37):

```ts
  onProjectSelect: (project: Project) => void;
  ...
  onNewSession: (project: Project) => void;
```

Delete both lines.

3. Remove them from the destructuring (currently line 75 and line 80):

```ts
  onProjectSelect,
  ...
  onNewSession,
```

4. Delete the mobile full-width button block (currently lines 91-102):

```tsx
      <div className="px-3 pb-1 pt-1 md:hidden">
        <button
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
          onClick={() => {
            onProjectSelect(project);
            onNewSession(project);
          }}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </button>
      </div>
```

5. Delete the desktop full-width button block (currently lines 104-112):

```tsx
      <Button
        variant="default"
        size="sm"
        className="hidden h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:flex"
        onClick={() => onNewSession(project)}
      >
        <Plus className="h-3 w-3" />
        {t('sessions.newSession')}
      </Button>
```

6. In `SidebarProjectItem.tsx`, remove the two pass-through props from the `<SidebarProjectSessions ...>` element (currently line 409 and line 416):

```tsx
        onProjectSelect={onProjectSelect}
        ...
        onNewSession={onNewSession}
```

`SidebarProjectItem` still uses both props itself (project select on click, `+` button), so they stay in `SidebarProjectItemProps`.

- [ ] **Step 2: Add the new tooltip keys**

In `src/i18n/locales/en/sidebar.json`, inside the `"tooltips"` object (after `"addToFavorites"`), add:

```json
    "newSession": "Start a new session in this project",
    "sessionRunning": "Session is running",
    "sessionIdle": "Session is idle",
    "projectActive": "Project has a running session",
    "projectIdle": "Project is idle",
```

(The stale `"activeSessionIndicator"` key is no longer referenced; leave it in place to avoid locale churn.)

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx src/i18n/locales/en/sidebar.json
git commit -m "feat(sidebar): remove New Session buttons, add new-session tooltip keys
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

Run: `npx tsx --test src/components/sidebar/utils/utils.test.ts src/hooks/useSidebarWidth.test.ts src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx`
Expected: PASS — all suites green.

- [ ] **Step 2: Full typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: PASS — `dist/` emitted with no errors.

- [ ] **Step 4: Commit any fixes**

If steps 1-3 surfaced failures, fix them, re-run, and commit as a fixup before proceeding:

```bash
git add -A
git commit -m "fix(sidebar): address typecheck/lint/build failures
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Manual verification

**Files:** none (interactive)

- [ ] **Step 1: Run the dev app**

Run: `npm run dev` (Vite). The app expects a backend on port 5187 (the sidebar project list needs real project data — start it if it isn't already running). Open the app at the printed local URL.

- [ ] **Step 2: Verify status dots on every session row**

Expand a project. Expect: every session row shows a small dot before the provider logo — yellow for idle sessions, green + spinner for a running session, amber (pulsing) for a needs-attention session.

- [ ] **Step 3: Verify the selected session highlight**

Click a session. Expect: the row shows a stronger border (`border-primary/50`), a 3px primary accent bar on its left edge, a tinted background, and a bolder session name — clearly distinct from idle rows.

- [ ] **Step 4: Verify project dots + active-first sort**

Expect: every project row shows a dot before its name (green when any session is running, small yellow otherwise). While a session is running, its project sorts above starred and idle projects.

- [ ] **Step 5: Verify New Session is gone / replaced by `+`**

Expect: no full-width "New Session" button anywhere. Each project row has a `+` button (mobile: left of the delete button; desktop: left of the edit button, always visible). Clicking it starts a new session in that project.

- [ ] **Step 6: Verify mobile drawer**

Narrow the window below 768px (or use device emulation). Expect: same dots and `+` behavior, no full-width button.

- [ ] **Step 7: Commit any manual-verification fixes**

If any check fails, fix, re-run the failed checks, and commit:

```bash
git add -A
git commit -m "fix(sidebar): address manual verification findings
Co-Authored-By: Claude <noreply@anthropic.com>"
```
