# Project List Status Indicators + New-Session Declutter — Design

- Date: 2026-08-04
- Status: Approved (brainstormed)
- Scope: `lovdex-cli` frontend (React + Vite SPA) — sidebar project list only

## 1. Goal

Fix four readability issues in the left sidebar project list:

1. **New session is too prominent** — collapse the full-width blue button into a small
   `+` on the project-name row.
2. **Session activity is invisible** — give every session a status dot: green =
   running or recently active (last 10 minutes), yellow = idle.
3. **Selected session is hard to spot** — stronger selected styling (border + left
   accent bar + tinted background + bolder text).
4. **Project activity is invisible and unsorted** — green dot in front of active
   projects (yellow dot for idle), and sort active projects to the top.

## 2. Background — current state

- `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx:104-112` —
  desktop renders a full-width `Button variant="default"` "New Session" button at the
  top of each expanded project's session list; `:91-102` renders a mobile-only full-width
  variant. Both are loud and occupy a full row.
- `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx:126-146` — a status
  dot is rendered **only** for attention (amber, pulsing) or recently-active (`<10min`,
  green, via `sessionView.isActive`) sessions; idle sessions get **no** dot. The dot is
  absolutely positioned in the left gutter (`-translate-x-1`).
- `SidebarSessionItem.tsx:215-222` — selected style is `border-primary/20 bg-primary/5`
  (subtle); `:154-157` same for mobile.
- `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx:264-392` (desktop
  row) and `:126-262` (mobile row) — no activity indicator; right side holds hover-only
  edit/delete + chevron.
- `src/components/sidebar/utils/utils.ts:121-148` — `sortProjects` sorts starred-first,
  then by name or last-activity date. No activity key.
- `src/components/sidebar/hooks/useSidebarController.ts:154-155` — `activeSessionIds`
  (set of session ids currently processing) already computed; `:587-590` `sortedProjects`
  feeds `filteredProjects`.
- Running = a session currently in the `activeSessions` map (`useSessionProtection`),
  the same set powering the header's emerald "Running now" tab and `runningProjects`.
- **"Active" = running OR recently active (last activity within 10 minutes).** The
  10-minute window reuses the existing `createSessionViewModel.isActive` recency logic.
  This was revised after user feedback: the running-only definition left the list
  looking "always yellow" because sessions are only in `activeSessions` while a request
  is in flight.

## 3. Non-goals (YAGNI)

- No change to the header "Running now" tab, the running search mode, or the archive view.
- No change to the collapse/expand behavior or the resizable width (recently landed).
- No persistence or settings UI for the new indicators.
- No change to `createSessionViewModel.isActive` (recent-activity view-model field). It
  keeps driving dot/border styling: "active" = running OR `sessionView.isActive`.
- No library dependencies.

## 4. Design

### 4.1 Pure helpers — `src/components/sidebar/utils/utils.ts`

Add pure helpers and extend one existing helper. All exported for tests.

```ts
/** Sessions with activity within this window count as active. */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** True when the session's last activity is within the 10-minute active window. */
export const isSessionRecentlyActive = (
  session: SessionWithProvider,
  currentTime: Date,
): boolean => {
  return currentTime.getTime() - getSessionDate(session).getTime() < ACTIVE_WINDOW_MS;
};

/** True when the session is running OR was recently active. */
export const isSessionActive = (
  session: SessionWithProvider,
  activeSessionIds: ReadonlySet<string>,
  currentTime: Date,
): boolean => {
  return activeSessionIds.has(String(session.id)) || isSessionRecentlyActive(session, currentTime);
};

/** True when any of the project's loaded sessions is active (running or recent). */
export const isProjectActive = (
  project: Project,
  activeSessionIds: ReadonlySet<string>,
  currentTime: Date,
): boolean => {
  return (project.sessions ?? []).some((session) => isSessionActive(session, activeSessionIds, currentTime));
};
```

`sortProjects(projects, projectSortOrder)` gains `activeSessionIds` and `currentTime`:

```ts
export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
  activeSessionIds: ReadonlySet<string>,
  currentTime: Date,
): Project[]
```

Comparator order becomes: **active > starred > name/date**.

```ts
const aActive = isProjectActive(projectA, activeSessionIds, currentTime);
const bActive = isProjectActive(projectB, activeSessionIds, currentTime);
if (aActive !== bActive) {
  return aActive ? -1 : 1;
}
// ... existing starred-first, then name/date logic unchanged
```

The session-row dot uses `getSessionDotState(needsAttention, isActive)` where `isActive`
is `isProcessing || sessionView.isActive` (running or recently active); attention still
takes precedence (`attention > active > idle`).

### 4.2 Controller — `useSidebarController.ts`

Pass the already-computed `activeSessionIds` and `currentTime` into the sort:

```ts
const sortedProjects = useMemo(
  () => sortProjects(projectsWithResolvedStarState, projectSortOrder, activeSessionIds, currentTime),
  [projectSortOrder, projectsWithResolvedStarState, activeSessionIds, currentTime],
);
```

No other controller changes.

### 4.3 Session rows — `SidebarSessionItem.tsx`

**Status dot (replaces the conditional gutter dot).** Every row renders a dot inline,
before the provider logo, in both mobile and desktop layouts. The absolute-positioned
indicator block (`:126-146`) is removed.

```tsx
const sessionIsActive = isProcessing || sessionView.isActive; // running OR recent
const dotState = getSessionDotState(needsAttention, sessionIsActive);
```

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

`showAttentionIndicator` / `showRecentIndicator` are deleted; the dot always shows and
`sessionView.isActive` (recent activity) drives it again alongside `isProcessing`.

**Row styling re-map** (desktop `:213-222` and mobile `:150-158`):

| State | Desktop / mobile style |
|---|---|
| selected | `border-primary/50 bg-primary/10` + left accent bar + `font-medium` name |
| not selected, active (running or recent) | green tint `border-green-500/30 bg-green-50/5` (re-pointed at `sessionIsActive`) |
| not selected, attention | amber tint `border-amber-500/40 bg-amber-50/5` |
| not selected, idle | neutral + existing hover |

**Selected accent bar** (Option A from the visual companion): the row gains `relative`
and, when selected, an absolutely-positioned bar on its left edge so the 3px accent
doesn't shift layout:

```tsx
{isSelected && (
  <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-primary" />
)}
```

**Name bolding:** when `isSelected`, the session-name element gets `font-medium` (desktop
`<div>` at `:242` and mobile `<div>` at `:173`).

The processing spinner (Loader2) is retained for running sessions.

### 4.4 Project rows — `SidebarProjectItem.tsx`

**Activity dot.** Computed from props already on the item (`sessions` + `activeSessions`
+ `currentTime`), using the `isSessionRecentlyActive` helper for the recency check:

```tsx
const projectIsActive = sessions.some(
  (session) => activeSessions.has(session.id) || isSessionRecentlyActive(session, currentTime),
);
```

Render an inline dot between the star and the name, in both mobile (`:138-160` row) and
desktop (`:275-297` row):

```tsx
<span
  title={projectIsActive ? 'Project has a running session' : 'Project is idle'}
  className={cn(
    'flex-shrink-0 rounded-full',
    projectIsActive ? 'h-2 w-2 bg-green-500' : 'h-1.5 w-1.5 bg-amber-400',
  )}
/>
```

**New-session `+`.** Add a small, always-visible Plus button in the right-side actions
(desktop `:340-391`, mobile `:206-259`), inside the `!isEditing` branch, before the
edit button. Click stops propagation and calls `onNewSession(project)`. Style: compact
`h-6 w-6` (desktop) / `h-8 w-8` (mobile) ghost button, muted, hover-accent.

```tsx
<button
  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
  onClick={(event) => {
    event.stopPropagation();
    onNewSession(project);
  }}
  title={t('tooltips.newSession')}
  aria-label={t('tooltips.newSession')}
>
  <Plus className="h-3.5 w-3.5" />
</button>
```

### 4.5 Remove the big New Session buttons — `SidebarProjectSessions.tsx`

- Delete the mobile full-width button (`:91-102`) and the desktop full-width button
  (`:104-112`).
- Remove the now-unused `Plus` import and the `onNewSession` prop (type, destructuring,
  and the prop passed from `SidebarProjectItem`). `SidebarProjectItem` keeps its own
  `onNewSession` for the `+` button; only the pass-through to `SidebarProjectSessions`
  is dropped. `Button` stays (still used by "Load more sessions").

### 4.6 i18n

Add a `tooltips.newSession` key to the sidebar locale (fallback to a default string so
other locales degrade gracefully). Reuse existing keys where possible.

## 5. Edge cases

- **Empty session list**: project with no sessions → not active → yellow dot.
- **Running session not yet loaded** (paginated sessions): the dot/sort only sees
  loaded sessions. Acceptable; note it.
- **Attention beats active**: a session that needs attention shows amber regardless of
  running/recent state.
- **Selected + active/attention**: the row uses the selected style, the dot still
  reflects amber/green/yellow so the status column stays consistent.
- **Recently active but idle** (activity < 10 min, not running): shows **green** — a
  session used in the last 10 minutes counts as active.
- **Editing states**: `+` hidden while the project name is being edited; session dot is
  unaffected by session-name editing.
- **Collapsed sidebar / mobile drawer**: unchanged except the new indicators; no width
  coupling to the recent resizable-sidebar work.
- **No active sessions at all**: all projects idle (yellow), list falls back to
  star-first then name/date — identical to today's order.

## 6. Files touched

- Modify: `src/components/sidebar/utils/utils.ts` — add `ACTIVE_WINDOW_MS`,
  `isSessionRecentlyActive`, `isSessionActive`, `isProjectActive`; extend `sortProjects`
  with `activeSessionIds` + `currentTime`; `getSessionDotState` second arg is "isActive".
- Create: `src/components/sidebar/utils/utils.test.ts` — tests for the helpers + sort.
- Modify: `src/components/sidebar/hooks/useSidebarController.ts` — pass
  `activeSessionIds` + `currentTime` to `sortProjects`.
- Modify: `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx` — always-on
  status dot (amber/green/yellow), Option-A selected style, border re-map.
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx` — activity
  dot + `+` new-session button (mobile + desktop).
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx` — remove
  both New Session buttons and the `onNewSession` pass-through.
- Modify: locale files — add `tooltips.newSession`.

## 7. Verification

- `npx tsx --test src/components/sidebar/utils/utils.test.ts` passes (new tests).
- `npm run typecheck && npm run lint` pass.
- `npm run build` passes.
- Manual (Playwright / browser):
  - Every session shows a dot: running-or-recent = green + spinner, idle = yellow,
    attention = amber pulsing (overrides).
  - Selected session shows border + left primary accent bar + tinted background + bolder
    name; clearly distinct from idle rows.
  - Project rows show green dot when any session is running, yellow otherwise; active
    projects sort above starred and idle ones.
  - No full-width "New Session" button anywhere; clicking the project-row `+` starts a
    new session in that project.
  - Mobile drawer mirrors the indicators; `+` visible; no big button.
