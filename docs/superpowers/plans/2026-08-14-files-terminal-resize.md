# Files 页终端高度可调 + 去标题栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Files 页内嵌终端与文件列表的高度可拖拽调整（持久化），并去掉终端面板的标题栏。

**Architecture:** `TerminalPanel` 精简为裸面板（去 `onClose`/头部，加 `style` 透传高度）；新增 `useTerminalResize` hook 用 `useLocalStorage` 持久化高度占比并复用 `useEditorSidebar` 的拖拽模式；`FileTree` 渲染拖拽条 + 按占比给终端设高度。

**Tech Stack:** React 18 + TypeScript + Tailwind + `useLocalStorage`（现有）+ node:test（SSR）。

---

## Pre-flight（必读）

1. **工作目录是 `~/.lovdex`**，不是 `/mnt/b/workdir/github/lovdex`。所有命令在 `cd ~/.lovdex/lovdex-cli` 后执行。
2. 跑测试前先 `unset TSX_TSCONFIG_PATH`（全局指向 backend tsconfig 会破坏本仓库 `npx tsx`）。
3. 参考 spec：`~/.lovdex/docs/superpowers/specs/2026-08-14-files-terminal-resize-design.md`。

---

### Task 1: TerminalPanel 去掉标题栏（TDD）

**Files:**
- Modify: `src/components/terminal/TerminalPanel.tsx`
- Modify: `src/components/terminal/TerminalPanel.test.tsx`

- [ ] **Step 1: 重写测试 `src/components/terminal/TerminalPanel.test.tsx`**

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TerminalPanel } from './TerminalPanel';

test('renders the injected pane without a header bar', () => {
  const html = renderToStaticMarkup(
    React.createElement(TerminalPanel, { pane: React.createElement('div', null, 'pane-stub') }),
  );
  assert.match(html, /pane-stub/);
  assert.doesNotMatch(html, /关闭即退出会话/);
});

test('renders a bordered container', () => {
  const html = renderToStaticMarkup(
    React.createElement(TerminalPanel, { pane: React.createElement('div', null, 'pane-stub') }),
  );
  assert.match(html, /border-t/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx
```

Expected：FAIL（旧组件仍有 `关闭即退出会话` 标题 → `doesNotMatch` 失败）。

- [ ] **Step 3: 重写 `src/components/terminal/TerminalPanel.tsx`**

```tsx
import type { CSSProperties, ReactNode } from 'react';

type TerminalPanelProps = {
  /** The terminal pane to mount; injectable for tests. */
  pane?: ReactNode;
  /** Inline style (height) controlled by the parent for resizing. */
  style?: CSSProperties;
};

/**
 * Embedded terminal panel at the bottom of the Files page. The parent mounts it
 * only while the terminal is open, so the pane's WebSocket (and the remote PTY)
 * lives exactly for the panel's lifetime — closing (via the toolbar toggle)
 * exits the shell.
 */
export function TerminalPanel({ pane, style }: TerminalPanelProps) {
  return (
    <div className="relative flex-shrink-0 border-t border-border/60 bg-card" style={style}>
      {pane}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

Expected：PASS（此时 `FileTree.tsx` 仍传 `onClose` 给 TerminalPanel，typecheck 会报错，但测试本身通过；Task 2 会修掉 FileTree）。

- [ ] **Step 5: 不单独提交** —— TerminalPanel 去 `onClose` 会让 `FileTree.tsx` 短暂 typecheck 报错，因此与 Task 2 一起提交（单个 commit），保持每步绿。

---

### Task 2: 新增 useTerminalResize + 接入 FileTree

**Files:**
- Create: `src/components/file-tree/hooks/useTerminalResize.ts`
- Modify: `src/components/file-tree/view/FileTree.tsx`

- [ ] **Step 1: 创建 `src/components/file-tree/hooks/useTerminalResize.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import useLocalStorage from '../../../hooks/useLocalStorage';

const MIN_TERMINAL_HEIGHT = 140;
const MIN_FILE_LIST_HEIGHT = 120;

/**
 * Manages the resizable terminal height on the Files page.
 *
 * The height is stored as a fraction (0–1) of the Files content area and
 * persisted in localStorage so the user's chosen split survives closing the
 * terminal, tab switches, and reloads. Dragging the handle between the file
 * list and the terminal updates the fraction, clamped so both panels keep a
 * usable minimum height.
 */
export function useTerminalResize() {
  const [terminalFraction, setTerminalFraction] = useLocalStorage<number>('filesTerminalHeight', 0.5);
  const [isResizing, setIsResizing] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  // useLocalStorage's setter is recreated each render; keep the latest in a ref
  // so the drag effect can subscribe only on [isResizing] without churn.
  const setFractionRef = useRef(setTerminalFraction);
  setFractionRef.current = setTerminalFraction;

  const handleResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    setIsResizing(true);
    event.preventDefault();
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      if (!isResizing) return;
      const container = resizeHandleRef.current?.parentElement;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      // The terminal sits at the bottom of the container, so its height is the
      // distance from the pointer to the container's bottom edge.
      const terminalHeight = rect.bottom - event.clientY;
      const minFraction = MIN_TERMINAL_HEIGHT / rect.height;
      const maxFraction = 1 - MIN_FILE_LIST_HEIGHT / rect.height;
      const fraction = Math.min(Math.max(terminalHeight / rect.height, minFraction), maxFraction);
      setFractionRef.current(fraction);
    };

    const handleMouseUp = () => setIsResizing(false);

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return { terminalFraction, resizeHandleRef, handleResizeStart };
}
```

- [ ] **Step 2: `FileTree.tsx` 引入 hook**

在 `import { useFileTreeUpload } from '../hooks/useFileTreeUpload';`（第 12 行）之后加：

```tsx
import { useTerminalResize } from '../hooks/useTerminalResize';
```

在 `const [terminalOpen, setTerminalOpen] = useState(false);`（第 41 行）之后加：

```tsx
  const { terminalFraction, resizeHandleRef, handleResizeStart } = useTerminalResize();
```

- [ ] **Step 3: `FileTree.tsx` 文件列表允许收缩**

把第 175 行：

```tsx
      <ScrollArea className="flex-1 px-2 py-1">
```

改成：

```tsx
      <ScrollArea className="min-h-0 flex-1 px-2 py-1">
```

- [ ] **Step 4: `FileTree.tsx` 渲染拖拽条 + 终端面板**

把第 237–239 行：

```tsx
      {terminalOpen && (
        <TerminalPanel onClose={() => setTerminalOpen(false)} pane={<TerminalPane />} />
      )}
```

改成：

```tsx
      {terminalOpen && (
        <>
          <div
            ref={resizeHandleRef}
            onMouseDown={handleResizeStart}
            className="h-1 flex-shrink-0 cursor-row-resize bg-border transition-colors hover:bg-blue-500"
            title="拖拽调整终端高度"
          />
          <TerminalPanel style={{ height: `${terminalFraction * 100}%` }} pane={<TerminalPane />} />
        </>
      )}
```

- [ ] **Step 5: 验证 typecheck + lint + 测试**

```bash
cd ~/.lovdex/lovdex-cli
npm run typecheck
npm run lint
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

Expected：全部通过（typecheck 0 错误、lint 零新增、测试 6/6）。

- [ ] **Step 6: Commit（Task 1 + Task 2 一起，单个 commit）**

```bash
git add src/components/terminal/TerminalPanel.tsx src/components/terminal/TerminalPanel.test.tsx \
        src/components/file-tree/hooks/useTerminalResize.ts src/components/file-tree/view/FileTree.tsx
git commit -m "feat: make terminal height resizable, drop terminal header

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 最终验收

- [ ] **Step 1: 全量 typecheck + lint + 单测**

```bash
cd ~/.lovdex/lovdex-cli
npm run typecheck && npm run lint
unset TSX_TSCONFIG_PATH
npx tsx --test $(find src -name '*.test.ts' -o -name '*.test.tsx' | sort)
```

Expected：typecheck 0 错误；lint 0 错误（200 warnings 零新增）；全量单测全绿。

- [ ] **Step 2: 浏览器 E2E（连 :5187 live dev server）**

1. 打开 Files 页 → 点工具栏终端按钮 → 出现下半屏终端，**无标题栏**。
2. 拖动分隔条 → 终端变高/变矮；文件列表随之伸缩。
3. 关掉终端再开、或刷新页面 → 高度保持上次拖动的值。
4. 拖到两端：终端 ≥140px、文件列表 ≥120px 无法再压。

- [ ] **Step 3: 确认无残留**

```bash
grep -rn "关闭即退出会话\|onClose" ~/.lovdex/lovdex-cli/src/components/terminal/TerminalPanel.tsx
```

Expected：无匹配（标题栏与 onClose 已彻底移除）。
