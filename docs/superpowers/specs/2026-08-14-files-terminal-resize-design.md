# Lovdex 终端高度可调 + 去标题栏 — 设计文档

- 日期：2026-08-14
- 状态：已批准
- 前身：`2026-08-14-files-terminal-embed-design.md`（内嵌终端，固定各占一半）

## 1. 背景与目标

内嵌终端已上线（文件列表与终端上下各占一半）。用户希望两点增强：

1. **终端与文件列表的高度可拖拽调整**（不再固定 50/50）。
2. **去掉终端面板的标题栏**（「终端 / 关闭即退出会话 / ✕」那一行），关闭统一用 Files 工具栏里的终端小按钮（开/关同键）。

## 2. 方案

复用代码库里编辑器宽度的拖拽模式（`useEditorSidebar`）与持久化 hook（`useLocalStorage`）。

### 2.1 组件结构

| 文件 | 动作 |
|---|---|
| `src/components/terminal/TerminalPanel.tsx` | 精简为裸面板：去掉 `onClose`、头部条、✕；只保留 `pane` + 新增 `style`（高度由父级控制） |
| `src/components/terminal/TerminalPanel.test.tsx` | 改断言：验证 pane 渲染 + 容器类（`border-t`），去掉标题/关闭按钮断言 |
| `src/components/file-tree/hooks/useTerminalResize.ts` | 新增：管理终端高度占比（持久化）+ 拖拽（复用 `useEditorSidebar` 的 mousemove/mouseup 模式） |
| `src/components/file-tree/view/FileTree.tsx` | 文件列表 `ScrollArea` 加 `min-h-0`；列表与终端之间渲染拖拽条 + `TerminalPanel`（传高度 style） |

### 2.2 数据流

- `terminalFraction`（0–1，默认 0.5）由 `useLocalStorage('filesTerminalHeight', 0.5)` 持久化，存 `src/components/file-tree/hooks/useTerminalResize.ts`。
- 拖拽：`mousedown` 开始 → `document` 上 `mousemove` 按 `(容器底 - clientY) / 容器高` 算占比并 clamp → `mouseup` 结束；拖拽中 `cursor: row-resize` + `userSelect: none`。
- 渲染：文件列表 `flex-1 min-h-0`；拖拽条 `h-1 flex-shrink-0 cursor-row-resize`；终端 `flex-shrink-0` + `style={{ height: \`${fraction*100}%\` }}`。

### 2.3 最小高度

- 终端 ≥ 140px、文件列表 ≥ 120px，拖拽时 clamp 到 `[140/容器高, 1 - 120/容器高]`。

## 3. 测试与验收

- `TerminalPanel.test.tsx`：更新为验证「渲染 pane」+「容器含 border-t」。拖拽 hook 与 `useEditorSidebar` 一致不加单测（DOM 事件难测），由 E2E 覆盖。
- 验证命令（先 `unset TSX_TSCONFIG_PATH`）：
  ```bash
  cd ~/.lovdex/lovdex-cli
  unset TSX_TSCONFIG_PATH
  npx tsx --test src/components/terminal/TerminalPanel.test.tsx src/components/terminal/terminalSession.test.ts
  npm run typecheck && npm run lint
  ```
- E2E：打开终端 → 拖动分隔条 → 终端变高/变矮；关掉再开、刷新后高度记住。

## 4. 涉及文件

- 修改：`src/components/terminal/TerminalPanel.tsx`、`src/components/terminal/TerminalPanel.test.tsx`、`src/components/file-tree/view/FileTree.tsx`
- 新增：`src/components/file-tree/hooks/useTerminalResize.ts`

## 5. 非目标（YAGNI）

- 双击复位、键盘调节、移动端触摸拖拽、按项目分别记忆。
