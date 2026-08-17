# Resizable Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop sidebar resizable by dragging its right edge (200–480px), persisting the width in localStorage, with double-click and keyboard reset.

**Architecture:** A `useSidebarWidth` hook owns width state (clamped, persisted to localStorage); a `SidebarResizeHandle` component renders a vertical drag strip at the sidebar's right edge and reports width changes. `Sidebar` calls the hook and threads `width`/`onWidthChange`/`onReset` into `SidebarContent`, which applies the width as an inline style (desktop only) and mounts the handle.

**Tech Stack:** React + TypeScript, Vite, Tailwind. Tests: `npx tsx --test <file>` (node:test + `node:assert/strict`; `react-dom/server` `renderToStaticMarkup` for component render tests). No `test` script in package.json.

**Spec:** `docs/superpowers/specs/2026-08-04-sidebar-resize-design.md`

---

## File Structure

- Create: `src/hooks/useSidebarWidth.ts` — width state + clamp + localStorage persistence (pure helpers exported for tests).
- Create: `src/hooks/useSidebarWidth.test.ts` — tests for `clampWidth` / `readStoredWidth`.
- Create: `src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx` — the drag handle.
- Create: `src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx` — SSR render test (aria attributes).
- Modify: `src/components/sidebar/view/Sidebar.tsx` — call `useSidebarWidth`, thread props.
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx` — `relative` + inline width + handle mount.

All new code follows existing conventions: named exports for hooks/helpers, default export for components, relative imports (`../../../hooks/...` from `src/components/sidebar/view/`).

---

### Task 1: `useSidebarWidth` hook (pure helpers)

**Files:**
- Test: `src/hooks/useSidebarWidth.test.ts`
- Create: `src/hooks/useSidebarWidth.ts`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useSidebarWidth.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampWidth,
  readStoredWidth,
} from './useSidebarWidth';

test('clampWidth bounds values to [200, 480]', () => {
  assert.equal(clampWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampWidth(600), SIDEBAR_WIDTH_MAX);
  assert.equal(clampWidth(300), 300);
});

test('clampWidth rounds to whole pixels and rejects non-finite values', () => {
  assert.equal(clampWidth(300.4), 300);
  assert.equal(clampWidth(300.6), 301);
  assert.equal(clampWidth(Number.NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampWidth(Number.POSITIVE_INFINITY), SIDEBAR_WIDTH_DEFAULT);
});

test('readStoredWidth reads and clamps stored value', () => {
  const storage = { getItem: () => '350' };
  assert.equal(readStoredWidth(storage), 350);

  const outOfRange = { getItem: () => '9999' };
  assert.equal(readStoredWidth(outOfRange), SIDEBAR_WIDTH_MAX);
});

test('readStoredWidth falls back to default for missing or garbage values', () => {
  const missing = { getItem: () => null };
  assert.equal(readStoredWidth(missing), SIDEBAR_WIDTH_DEFAULT);

  const garbage = { getItem: () => 'abc' };
  assert.equal(readStoredWidth(garbage), SIDEBAR_WIDTH_DEFAULT);
});

test('SIDEBAR_WIDTH_STORAGE_KEY matches the localStorage key used', () => {
  assert.equal(SIDEBAR_WIDTH_STORAGE_KEY, 'sidebarWidth');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/hooks/useSidebarWidth.test.ts`
Expected: FAIL — module `./useSidebarWidth` not found (no imports resolve).

- [ ] **Step 3: Write the implementation**

Create `src/hooks/useSidebarWidth.ts`:

```ts
import { useEffect, useState } from 'react';

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 288;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebarWidth';

type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return SIDEBAR_WIDTH_DEFAULT;
  }
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

export function readStoredWidth(storage: Pick<Storage, 'getItem'>): number {
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) {
      return SIDEBAR_WIDTH_DEFAULT;
    }
    return clampWidth(Number(raw));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function resolveStorage(): WidthStorage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useSidebarWidth(storage?: WidthStorage) {
  const resolved = storage ?? resolveStorage();
  const [width, setWidthState] = useState<number>(() =>
    resolved ? readStoredWidth(resolved) : SIDEBAR_WIDTH_DEFAULT,
  );

  const setWidth = (value: number) => setWidthState(clampWidth(value));
  const resetWidth = () => setWidthState(SIDEBAR_WIDTH_DEFAULT);

  useEffect(() => {
    if (!resolved) {
      return;
    }
    try {
      resolved.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // Ignore quota/security errors (e.g. private browsing).
    }
  }, [width, resolved]);

  return { width, setWidth, resetWidth };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/hooks/useSidebarWidth.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSidebarWidth.ts src/hooks/useSidebarWidth.test.ts
git commit -m "feat(sidebar): add useSidebarWidth hook with clamp + persistence
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `SidebarResizeHandle` component

**Files:**
- Test: `src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx`
- Create: `src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx`:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import SidebarResizeHandle from './SidebarResizeHandle';

test('renders a vertical separator with the current width as aria-valuenow', () => {
  const html = renderToStaticMarkup(
    <SidebarResizeHandle width={350} onWidthChange={() => {}} onReset={() => {}} />,
  );

  assert.ok(html.includes('role="separator"'));
  assert.ok(html.includes('aria-orientation="vertical"'));
  assert.ok(html.includes('aria-valuemin="200"'));
  assert.ok(html.includes('aria-valuemax="480"'));
  assert.ok(html.includes('aria-valuenow="350"'));
  assert.ok(html.includes('tabindex="0"'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx`
Expected: FAIL — module `./SidebarResizeHandle` not found.

- [ ] **Step 3: Write the implementation**

Create `src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx`:

```tsx
import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../../../../hooks/useSidebarWidth';

type SidebarResizeHandleProps = {
  width: number;
  onWidthChange: (width: number) => void;
  onReset: () => void;
};

const KEYBOARD_STEP = 16;

export default function SidebarResizeHandle({ width, onWidthChange, onReset }: SidebarResizeHandleProps) {
  // Pointer capture keeps pointermove/pointerup arriving on this element even
  // when the cursor leaves it mid-drag.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    onWidthChange(drag.startWidth + (event.clientX - drag.startX));
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width - KEYBOARD_STEP;
    else if (event.key === 'ArrowRight') next = width + KEYBOARD_STEP;
    else if (event.key === 'Home') next = SIDEBAR_WIDTH_MIN;
    else if (event.key === 'End') next = SIDEBAR_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    onWidthChange(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className="group absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div className="h-full w-full transition-colors group-hover:bg-border group-active:bg-primary/40" />
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx
git commit -m "feat(sidebar): add SidebarResizeHandle drag component
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Thread width into `Sidebar` → `SidebarContent`

**Files:**
- Modify: `src/components/sidebar/view/Sidebar.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`

- [ ] **Step 1: Call `useSidebarWidth` in `Sidebar`**

In `src/components/sidebar/view/Sidebar.tsx`:

1. Add the import after the `useSidebarController` import (line 6):

```ts
import { useSidebarWidth } from '../../../hooks/useSidebarWidth';
```

2. Inside the component body, after the `useSidebarController({ ... })` call (after line 143), add:

```ts
const { width: sidebarWidth, setWidth: setSidebarWidth, resetWidth: resetSidebarWidth } = useSidebarWidth();
```

3. Add three props to the `<SidebarContent ...>` element (after `isMobile={isMobile}`, line 278):

```tsx
width={sidebarWidth}
onWidthChange={setSidebarWidth}
onReset={resetSidebarWidth}
```

- [ ] **Step 2: Extend `SidebarContentProps` and apply the width**

In `src/components/sidebar/view/subcomponents/SidebarContent.tsx`:

1. Add to the `SidebarContentProps` type (after `isMobile: boolean;`, line 117):

```ts
width: number;
onWidthChange: (width: number) => void;
onReset: () => void;
```

2. Destructure them in the function signature (after `isMobile,`, line 158):

```ts
width,
onWidthChange,
onReset,
```

3. Add the import (after the `SidebarProjectList` import, line 16):

```tsx
import SidebarResizeHandle from './SidebarResizeHandle';
```

4. Change the root `<div>` (currently lines 197-200):

```tsx
    <div
      className="relative flex h-full flex-col bg-background/80 backdrop-blur-sm md:w-72 md:select-none"
      style={isMobile ? {} : { width }}
    >
```

(`md:w-72` is kept as the CSS default; the inline `width` overrides it on desktop. `isMobile` gates it so the mobile drawer's own width is untouched.)

5. Mount the handle as the last child, right after `</SidebarFooter>` and before the closing `</div>`:

```tsx
      {!isMobile && (
        <SidebarResizeHandle
          width={width}
          onWidthChange={onWidthChange}
          onReset={onReset}
        />
      )}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Lint the touched files**

Run: `npx eslint src/components/sidebar/view/Sidebar.tsx src/components/sidebar/view/subcomponents/SidebarContent.tsx src/hooks/useSidebarWidth.ts src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/view/Sidebar.tsx src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(sidebar): wire resizable width through Sidebar and SidebarContent
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Build + full test suite

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

Run: `npx tsx --test src/hooks/useSidebarWidth.test.ts src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx`
Expected: PASS — both suites green.

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

### Task 5: Manual verification

**Files:** none (interactive)

- [ ] **Step 1: Run the dev app**

Run: `npm run dev` (Vite HMR; backend not needed for layout checks). Open the app at the printed local URL.

- [ ] **Step 2: Verify drag resize**

Drag the handle at the sidebar's right edge. Expect: sidebar width follows the cursor, clamped between 200px and 480px; main content reflows; the handle highlights on hover and during drag.

- [ ] **Step 3: Verify persistence**

Reload the page. Expect: sidebar keeps the width you dragged to.

- [ ] **Step 4: Verify reset**

Double-click the handle. Expect: sidebar returns to 288px.

- [ ] **Step 5: Verify keyboard access**

Focus the handle (Tab), then:
- ArrowRight / ArrowLeft → width changes by 16px per press (clamped).
- Home → 200px; End → 480px.

- [ ] **Step 6: Verify collapse/expand**

Click the collapse chevron. Expect: rail is `w-12`. Expand again. Expect: the resized width is restored.

- [ ] **Step 7: Verify mobile unaffected**

Narrow the window below 768px (or use devtools device emulation). Expect: the sidebar becomes the slide-in drawer at `w-[85vw] max-w-sm`, no inline width applied, and no resize handle visible.

- [ ] **Step 8: Commit any manual-verification fixes**

If any check fails, fix, re-run the failed checks, and commit:

```bash
git add -A
git commit -m "fix(sidebar): address manual verification findings
Co-Authored-By: Claude <noreply@anthropic.com>"
```
