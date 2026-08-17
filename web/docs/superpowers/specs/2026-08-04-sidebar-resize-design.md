# Resizable Sidebar — Design

- Date: 2026-08-04
- Status: Approved (brainstormed)
- Scope: `lovdex-cli` frontend (React + Vite SPA)

## 1. Goal

Make the desktop sidebar width adjustable by dragging its right edge, so long session
names can be shown in full instead of being truncated at the fixed `md:w-72` (288px)
width. The adjusted width persists across app restarts.

## 2. Background — current layout

- `src/components/app/AppContent.tsx:197-200` — desktop sidebar sits in a
  `h-full flex-shrink-0 border-r` container; the sidebar's width is determined entirely
  by its content (`flex-shrink-0` shrinks to fit).
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx:198` — the expanded
  sidebar is hardcoded to `md:w-72` (288px). This is the single source of the width.
- `src/components/sidebar/view/Sidebar.tsx:265-273` — collapse toggle switches between
  `<SidebarCollapsed>` (fixed `w-12`) and `<SidebarContent>`. Only one is rendered at a
  time.
- Mobile (< md) renders a full-screen drawer (`w-[85vw] max-w-sm sm:w-80`) in
  `AppContent.tsx:219-224`; `SidebarContent` is reused inside it and currently has no
  explicit width below `md` (fills the drawer).
- Session names truncate via `truncate` in `SidebarSessionItem.tsx:173` / `:242`.

## 3. Non-goals (YAGNI)

- No resize on mobile — the drawer already uses most of the screen width; inline width
  is deliberately not applied there.
- No library dependency (`react-resizable-panels` rejected).
- No separate settings UI / width input field. Drag + double-click-reset only.
- No multi-panel resizing; only the sidebar is resizable.

## 4. Design

### 4.1 New hook — `src/hooks/useSidebarWidth.ts`

```ts
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;
const SIDEBAR_WIDTH_DEFAULT = 288;
const STORAGE_KEY = 'sidebarWidth';

clampWidth(w)          // clamp to [MIN, MAX]
readInitialWidth()     // lazy init: parseInt(localStorage[STORAGE_KEY]), clamp, fallback DEFAULT

useSidebarWidth() => { width, setWidth, resetWidth }
```

- `setWidth(w)` clamps to `[200, 480]` before storing in state.
- Persist to `localStorage[STORAGE_KEY]` via `useEffect` on width change.
- `resetWidth()` sets `SIDEBAR_WIDTH_DEFAULT`.
- Lazy initializer avoids a flash of wrong width on first paint.

### 4.2 New component — `SidebarResizeHandle`

`src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx`

Props: `{ width, onWidthChange(width: number), onReset() }`

- Renders a narrow vertical strip at the sidebar's right edge.
- `role="separator" aria-orientation="vertical"` with
  `aria-valuenow={width}` / `aria-valuemin={200}` / `aria-valuemax={480}` for
  accessibility.
- Pointer events: `pointerdown` records `startX` + `startWidth` and calls
  `setPointerCapture`; `pointermove` calls `onWidthChange(startWidth + (clientX - startX))`
  (clamping happens in the hook); `pointerup`/`pointercancel` release capture.
- `onDoubleClick` calls `onReset()` (double-click resets to 288px).
- Keyboard: ArrowLeft/ArrowRight adjust `width` by ±16px; Home sets MIN, End sets MAX.
- `touch-action: none` and `select-none` so dragging works on touch and never selects
  sidebar text.

### 4.3 Wiring — `Sidebar.tsx`

Call `useSidebarWidth()` in `Sidebar`. Pass `width`, `onWidthChange={setWidth}`,
`onReset={resetWidth}` down to `SidebarContent`.

### 4.4 `SidebarContent.tsx`

- Root container: add `relative`; **keep `md:w-72` as the CSS default fallback**. Inline
  `style={{ width }}` applied only on desktop (`!isMobile`) overrides it (inline beats
  class). This avoids switching to `w-full`, which would circularly resolve against the
  `flex-shrink-0` auto-width parent and collapse the sidebar.
- Render `<SidebarResizeHandle width={width} onWidthChange={onWidthChange} onReset={onReset} />`
  only when `!isMobile`.

### 4.5 Edge cases

- **Collapsed state**: when collapsed, `SidebarContent` (and the handle) unmount; width
  state persists in the hook, so expanding restores the last width. `SidebarCollapsed`
  (`w-12`) is untouched.
- **Main content**: `flex min-w-0 flex-1` in `AppContent` already reflows — no change.
- **Mobile**: `isMobile` guard means the drawer keeps `w-[85vw] max-w-sm`; no inline
  width leaks in.
- **Invalid stored value** (NaN / out of range): clamped to the nearest bound on init.

## 5. Files touched

- New: `src/hooks/useSidebarWidth.ts`
- New: `src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx`
- Edit: `src/components/sidebar/view/Sidebar.tsx` (hook call + prop threading)
- Edit: `src/components/sidebar/view/subcomponents/SidebarContent.tsx` (width class,
  inline style, handle mount)

## 6. Verification

- `npm run build` (tsc type-check + vite build) passes.
- Manual:
  - Drag handle → sidebar widens/narrows within 200–480px; main content reflows.
  - Reload page → width restored from localStorage.
  - Double-click handle → back to 288px.
  - Arrow keys on focused handle adjust width; Home/End jump to bounds.
  - Collapse → rail `w-12`; expand → last width.
  - Mobile viewport → drawer unchanged, no inline width.
