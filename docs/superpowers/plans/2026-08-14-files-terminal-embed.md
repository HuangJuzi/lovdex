# Files 页内嵌终端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有右侧滑出终端抽屉完全替换为 Files 页内嵌下半屏面板，用 Files 工具栏小按钮开合，默认隐藏。

**Architecture:** 删除抽屉外壳与所有呼出入口（头部按钮 + Ctrl+` 快捷键 + 任务页按钮）；把 `TerminalDrawerPanel` 改造成内嵌 `TerminalPanel`；`open` 状态改为 `FileTree` 本地 state；`cwd` 仍由 `useTerminalDrawer` context 管理（`AppContent` 写入、`TerminalPane` 读取），后端零改动。

**Tech Stack:** React 18 + TypeScript + Tailwind + `@xterm/xterm`（沿用）+ node:test（SSR `renderToStaticMarkup`）+ `npx tsx --test`。

---

## Pre-flight（必读）

1. **测试需先清 env**：`TSX_TSCONFIG_PATH` 在全局被导出（指向 `server/tsconfig.json`），会破坏 lovdex-cli 的 `npx tsx`。每个跑测试的命令前先 `unset TSX_TSCONFIG_PATH`。
2. **工作树已有未提交改动**（与本任务无关）：`src/components/main-content/view/MainContent.tsx`、`src/components/tasks/TaskBoard.tsx`、`src/components/tasks/TaskTableView.tsx`、`src/hooks/useProjectsState.ts`。其中 `MainContent.tsx`、`TaskBoard.tsx` 也是本任务要改的文件。提交时**只 `git add` 本任务涉及的文件**，并先用 `git diff <file>` 确认暂存内容只含本任务改动；不要把无关改动混进本功能提交。
3. 所有命令在 `/mnt/b/workdir/github/lovdex/lovdex-cli` 下执行。
4. 参考 spec：`docs/superpowers/specs/2026-08-14-files-terminal-embed-design.md`。

---

### Task 1: 删除抽屉与其所有呼出入口

**Files:**
- Delete: `src/components/terminal/TerminalDrawer.tsx`
- Delete: `src/components/terminal/TerminalToggleButton.tsx`
- Delete: `src/components/terminal/TerminalToggleButton.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/main-content/view/MainContent.tsx`
- Modify: `src/components/tasks/TaskBoard.tsx`
- Modify: `src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 删除三个文件**

```bash
git rm src/components/terminal/TerminalDrawer.tsx \
       src/components/terminal/TerminalToggleButton.tsx \
       src/components/terminal/TerminalToggleButton.test.tsx
```

- [ ] **Step 2: `src/App.tsx` 移除抽屉（保留 Provider）**

删除这一行（第 11 行）：

```tsx
import { TerminalDrawer } from './components/terminal/TerminalDrawer';
```

删除这一行（第 123 行，`</Routes>` 之后）：

```tsx
                <TerminalDrawer />
```

保留 `import { TerminalDrawerProvider } from './hooks/useTerminalDrawer';` 与 `<TerminalDrawerProvider>`/`</TerminalDrawerProvider>` 包裹。

- [ ] **Step 3: `src/components/main-content/view/MainContent.tsx` 移除按钮**

删除第 12 行：

```tsx
import { TerminalToggleButton } from '../../terminal/TerminalToggleButton';
```

删除第 126 行：

```tsx
        <TerminalToggleButton />
```

- [ ] **Step 4: `src/components/tasks/TaskBoard.tsx` 移除按钮**

删除第 42 行：

```tsx
import { TerminalToggleButton } from '../terminal/TerminalToggleButton';
```

删除第 346 行：

```tsx
        <TerminalToggleButton />
```

- [ ] **Step 5: `src/components/tasks/TaskDetail.tsx` 移除按钮与 setCwd**

删除第 39–40 行：

```tsx
import { TerminalToggleButton } from '../terminal/TerminalToggleButton';
import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
```

删除第 64 行：

```tsx
  const { setCwd } = useTerminalDrawer();
```

删除第 137–141 行（含注释与 effect）：

```tsx
  // The task detail page's "current project" is the task's own project, so the
  // terminal drawer should open there.
  useEffect(() => {
    setCwd(task?.project_path || null);
  }, [task?.project_path, setCwd]);
```

删除第 486 行：

```tsx
        <TerminalToggleButton />
```

- [ ] **Step 6: 验证 typecheck + lint + 现有测试**

```bash
npm run typecheck
npm run lint
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalDrawerPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

Expected：typecheck 0 错误、lint 无新增错误（baseline 若本就有错误则「零新增」）、两个测试通过（`TerminalDrawerPanel` 此时尚未改名，仍存在且未被动）。

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/components/main-content/view/MainContent.tsx \
        src/components/tasks/TaskBoard.tsx src/components/tasks/TaskDetail.tsx
# 先 git diff --cached 确认只含本任务改动，再提交
git commit -m "refactor: remove terminal drawer and its entry points

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 把 `useTerminalDrawer` context 精简为只存 `cwd`

**Files:**
- Modify: `src/hooks/useTerminalDrawer.tsx`
- Delete: `src/hooks/useTerminalDrawer.test.ts`

- [ ] **Step 1: 删除只剩 shortcut 测试的测试文件**

```bash
git rm src/hooks/useTerminalDrawer.test.ts
```

- [ ] **Step 2: 重写 `src/hooks/useTerminalDrawer.tsx` 为 cwd-only**

用以下完整内容覆盖原文件（删除 `isTerminalShortcut`、`open/toggle/setOpen`、keydown 监听；保留 `cwd/setCwd` 与 Provider 名，最小化 `AppContent`/`TerminalPane` 的改动）：

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type TerminalDrawerContextValue = {
  /** The directory the terminal should open in (the current project path), if any. */
  cwd: string | null;
  setCwd: (cwd: string | null) => void;
};

const TerminalDrawerContext = createContext<TerminalDrawerContextValue | null>(null);

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [cwd, setCwdState] = useState<string | null>(null);
  const setCwd = useCallback((next: string | null) => setCwdState(next), []);

  const value = useMemo<TerminalDrawerContextValue>(() => ({ cwd, setCwd }), [cwd, setCwd]);
  return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
}

export function useTerminalDrawer(): TerminalDrawerContextValue {
  const context = useContext(TerminalDrawerContext);
  if (!context) throw new Error('useTerminalDrawer must be used within TerminalDrawerProvider');
  return context;
}
```

- [ ] **Step 3: 验证 typecheck + lint + 现有测试**

```bash
npm run typecheck
npm run lint
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalDrawerPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

Expected：全部通过（`TerminalPane`/`AppContent` 仍只用到 `cwd`/`setCwd`，不报错）。

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useTerminalDrawer.tsx
git commit -m "refactor: strip terminal context to cwd only

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `TerminalDrawerPanel` 改造为内嵌 `TerminalPanel`（TDD）

**Files:**
- Create: `src/components/terminal/TerminalPanel.tsx`
- Create: `src/components/terminal/TerminalPanel.test.tsx`
- Delete: `src/components/terminal/TerminalDrawerPanel.tsx`
- Delete: `src/components/terminal/TerminalDrawerPanel.test.tsx`

- [ ] **Step 1: 写失败测试 `src/components/terminal/TerminalPanel.test.tsx`**

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TerminalPanel } from './TerminalPanel';

test('renders the terminal header with close affordance', () => {
  const html = renderToStaticMarkup(
    React.createElement(TerminalPanel, {
      onClose: () => {},
      pane: React.createElement('div', null, 'pane-stub'),
    }),
  );
  assert.match(html, /终端/);
  assert.match(html, /关闭即退出会话/);
  assert.match(html, /关闭终端/);
});

test('renders the injected pane', () => {
  const html = renderToStaticMarkup(
    React.createElement(TerminalPanel, {
      onClose: () => {},
      pane: React.createElement('div', null, 'pane-stub'),
    }),
  );
  assert.match(html, /pane-stub/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx
```

Expected：FAIL（`Cannot find module './TerminalPanel'`）。

- [ ] **Step 3: 创建 `src/components/terminal/TerminalPanel.tsx`**

```tsx
import type { ReactNode } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';

type TerminalPanelProps = {
  onClose: () => void;
  /** The terminal pane to mount; injectable for tests. */
  pane?: ReactNode;
};

/**
 * Embedded terminal panel at the bottom of the Files page. The parent mounts it
 * only while the terminal is open, so the pane's WebSocket (and the remote PTY)
 * lives exactly for the panel's lifetime — closing exits the shell.
 */
export function TerminalPanel({ onClose, pane }: TerminalPanelProps) {
  return (
    <div className="flex min-h-[140px] flex-1 flex-col border-t border-border/60 bg-card">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5">
        <TerminalIcon className="h-4 w-4 text-emerald-500" />
        <span className="text-sm font-semibold">终端</span>
        <span className="ml-auto text-[11px] text-muted-foreground">关闭即退出会话</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭终端"
          className="ml-1 rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <div className="relative min-h-0 flex-1">{pane}</div>
    </div>
  );
}
```

- [ ] **Step 4: 删除旧抽屉外壳及其测试**

```bash
git rm src/components/terminal/TerminalDrawerPanel.tsx \
       src/components/terminal/TerminalDrawerPanel.test.tsx
```

- [ ] **Step 5: 跑测试确认通过**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

Expected：PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/terminal/TerminalPanel.tsx src/components/terminal/TerminalPanel.test.tsx
git commit -m "refactor: convert terminal drawer panel to embedded panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 接入 FileTree 与 FileTreeHeader

**Files:**
- Modify: `src/components/file-tree/view/FileTree.tsx`
- Modify: `src/components/file-tree/view/FileTreeHeader.tsx`

- [ ] **Step 1: `FileTreeHeader.tsx` 加图标与按钮**

改第 3 行 lucide 导入，追加 `Terminal`：

```tsx
import { ChevronDown, Eye, FileText, FolderPlus, List, Loader2, RefreshCw, Search, TableProperties, Terminal, Upload, X } from 'lucide-react';
```

在 `FileTreeHeaderProps` 类型里（`uploadProgress?: number | null;` 之后）加两个可选 prop：

```tsx
  // Terminal panel toggle
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
```

在函数解构参数里（`uploadProgress,` 之后）加：

```tsx
  terminalOpen,
  onToggleTerminal,
```

在 `{/* Divider */}`（第 157 行）之前、`onCollapseAll` 按钮块之后，插入终端开关按钮：

```tsx
          {onToggleTerminal && (
            <Button
              variant={terminalOpen ? 'default' : 'ghost'}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onToggleTerminal}
              title="终端"
              aria-label="终端"
              aria-pressed={terminalOpen}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
          )}
```

- [ ] **Step 2: `FileTree.tsx` 引入组件、本地 state、渲染面板**

在 `import { ScrollArea, Input } from '../../../shared/view/ui';`（第 16 行）之后加：

```tsx
import { TerminalPanel } from '../../terminal/TerminalPanel';
import { TerminalPane } from '../../terminal/TerminalPane';
```

在 `const renameInputRef = useRef<HTMLInputElement>(null);`（第 35 行）之后加本地 state：

```tsx
  // 终端面板开合是 Files 页本地状态：默认隐藏；切走 tab 即卸载、退出 shell。
  const [terminalOpen, setTerminalOpen] = useState(false);
```

在 `<FileTreeHeader ... />`（约第 148–162 行）的 props 里，`uploadProgress={...}` 之后加：

```tsx
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen((prev) => !prev)}
```

在 `</ScrollArea>`（第 228 行）之后、`{selectedImage && (` 之前，插入面板：

```tsx
      {terminalOpen && (
        <TerminalPanel onClose={() => setTerminalOpen(false)} pane={<TerminalPane />} />
      )}
```

- [ ] **Step 3: 验证 typecheck + lint + 现有测试**

```bash
npm run typecheck
npm run lint
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

Expected：全部通过。

- [ ] **Step 4: Commit**

```bash
git add src/components/file-tree/view/FileTree.tsx src/components/file-tree/view/FileTreeHeader.tsx
# 先 git diff --cached 确认只含本任务改动，再提交
git commit -m "feat: embed terminal in Files page with toolbar toggle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 最终验收

- [ ] **Step 1: 全量 typecheck + lint**

```bash
npm run typecheck
npm run lint
```

Expected：typecheck 0 错误；lint 无新增错误（对照 baseline 零新增）。

- [ ] **Step 2: 全量单元测试**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

Expected：PASS（其余测试文件若存在可一并 `npx tsx --test src/**/*.test.ts*` 跑，但 terminal 相关为本次核心）。

- [ ] **Step 3: 浏览器 E2E（连 :5187 live dev server，puppeteer-core + 缓存 chromium）**

1. 打开 Files 页：默认只显示文件列表，无终端。
2. 点 Files 头部小图标按钮（终端图标）：下半屏出现终端，与文件列表各占一半。
3. 再点同一按钮（或面板右上 ✕）：终端消失，文件列表恢复全高。
4. 打开终端后切到 chat/git tab 再切回 Files：终端仍是隐藏（shell 已退出）。

- [ ] **Step 4: 确认无残留引用**

```bash
grep -rn "TerminalDrawer\|TerminalToggleButton\|isTerminalShortcut" src --include="*.ts" --include="*.tsx"
```

Expected：仅 `useTerminalDrawer`（context 名，保留）与 `TerminalDrawerProvider` 出现，无 `TerminalDrawer.tsx`/`TerminalToggleButton`/`isTerminalShortcut` 残留。
