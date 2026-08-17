# Lovdex 终端内嵌 Files 页 — 设计文档

- 日期：2026-08-14
- 状态：已批准
- 前身：`2026-08-13-terminal-drawer-design.md`（侧滑抽屉版，本次完全替换）

## 1. 背景与目标

当前终端是**全局侧滑抽屉**（`TerminalDrawer`），由三处顶栏按钮（主区 `MainContent`、任务看板 `TaskBoard`、任务详情 `TaskDetail`）与 `Ctrl+\`` 快捷键呼出，抽屉挂在整个应用顶层。

用户希望把终端**内嵌到 Files 页**，与文件列表上下各占一半，用 Files 工具栏里的小按钮开合，默认打开 Files 时只显示文件。

### 1.1 已确认决策

| 决策点 | 结论 |
|---|---|
| 与现有抽屉的关系 | **完全替换**：移除右侧抽屉，终端只存在于 Files 页内嵌面板 |
| 任务详情页「终端」按钮 | **去掉** |
| 主区头部「终端」按钮 + `Ctrl+\`` 快捷键 | **只留 Files 小按钮**：头部大按钮与快捷键都移除 |
| 布局 | 上下排列，各占一半（50/50），默认隐藏终端 |

### 1.2 非目标（YAGNI）

- 不引入可拖拽分隔条 / 自定义高度（固定各占一半）。
- 不做多标签多会话（沿用 v1 单会话，关面板即退出 shell）。
- 后端零改动（`/ws/terminal`、`node-pty`、cwd 校验全部沿用）。
- 不给 Files 页之外的其他页面加终端入口。

## 2. 实现方案（方案 B：复用现有组件，最小改动）

保留终端抽屉的现有基建（context、`TerminalPane`、面板外壳），仅把「抽屉外壳」改成「内嵌面板」，删掉所有抽屉呼出入口（头部按钮 + 快捷键），在 Files 页接入。

### 2.1 组件结构

| 文件 | 动作 |
|---|---|
| `src/hooks/useTerminalDrawer.tsx` | **保留** context 与 `cwd/setCwd`；**删除** `open/toggle/setOpen`、`Ctrl+\`` keydown 监听与 `isTerminalShortcut` 导出（`open` 改为 FileTree 本地 state） |
| `src/components/terminal/TerminalPane.tsx` | **不动**（继续从 context 读 `cwd`，挂载即连 WS、卸载即退出） |
| `src/components/terminal/TerminalDrawerPanel.tsx` | **改名 `TerminalPanel.tsx`**：外壳从 `fixed inset-0` 抽屉改成内嵌 `flex flex-col h-full`（去掉遮罩与右侧滑入动画），保留头部条（`终端` 标题 + 「关闭即退出会话」 + ✕） |
| `src/components/terminal/TerminalDrawer.tsx` | **删除**（抽屉包装器，不再需要） |
| `src/components/terminal/TerminalToggleButton.tsx` | **删除**（头部大按钮，不再需要） |
| `src/components/file-tree/view/FileTree.tsx` | 加本地 `terminalOpen` state（默认 `false`）；文件列表 `ScrollArea` 与 `<TerminalPanel/>` 各 `flex-1`，终端关闭时不渲染面板 → 打开时上下各半 |
| `src/components/file-tree/view/FileTreeHeader.tsx` | 在 upload/newfile 那排图标按钮里、divider 之前加一个 `TerminalSquare` 小按钮（`h-7 w-7 p-0`，与现有按钮同款），点击 `toggle` |
| `src/App.tsx` | 移除 `<TerminalDrawer/>`，保留 `<TerminalDrawerProvider>` |
| `src/components/app/AppContent.tsx` | **不动**（继续 `setCwd` 同步项目路径） |
| `src/components/main-content/view/MainContent.tsx` | 移除 `TerminalToggleButton` 引用 |
| `src/components/tasks/TaskBoard.tsx` | 移除 `TerminalToggleButton` 引用 |
| `src/components/tasks/TaskDetail.tsx` | 移除 `TerminalToggleButton` 引用与 `useTerminalDrawer` 的 `setCwd` 相关代码 |

### 2.2 数据流

- `cwd`：`AppContent` 依据 `selectedProject` 写入 context（现有逻辑）→ `TerminalPane` 挂载时用 `cwdRef` 冻结，中途切项目不重启 shell。
- `open`：FileTree 本地 `terminalOpen` state（默认 `false`），唯一入口是 Files 头部小按钮 toggle。切走 Files tab 即卸载、shell 退出；重挂载默认隐藏，天然满足「每次打开 Files 默认只显示文件」且不误 spawn shell。

### 2.3 生命周期语义

- 打开面板 = 新建 shell（前端连 WS，后端 spawn PTY）。
- 关闭面板 / 切走 Files tab = `TerminalPane` 卸载 → shell 退出。
- 重开 = 全新 shell。与现状「关闭即退出会话」一致。

## 3. 错误处理 / 边界

- xterm 需要最小可渲染高度：终端面板加 `min-h-[140px]` 兜底，窗口过矮时文件列表与终端仍可读。
- `TerminalPane` 现有的 `fit()` 竞态处理（`rAF` + `ResizeObserver`）原样沿用，无需改。
- 面板关闭时 `TerminalPane` 卸载，`session.dispose()` 断开 WS → 后端 `pty.kill()`，无泄漏。

## 4. 测试与验收

### 4.1 单元测试（lovdex-cli）

- `TerminalDrawerPanel.test.tsx` → 改名 `TerminalPanel.test.tsx`：更新为验证内嵌面板的 open/close 与 ✕ 行为。
- `TerminalToggleButton.test.tsx` → 删除。
- `useTerminalDrawer.test.ts` → 删除（原文件只测 `isTerminalShortcut`，删除后无剩余可测逻辑）。
- `terminalSession.test.ts` → 不动。

验证命令（lovdex-cli 无 `npm test` 脚本，需显式跑文件；先 `unset TSX_TSCONFIG_PATH`）：

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/terminal/TerminalPanel.test.tsx src/components/terminal/terminalSession.test.ts
```

### 4.2 浏览器 E2E（连 :5187 live dev server）

1. 打开 Files 页：默认只显示文件，无终端。
2. 点 Files 头部小按钮：出现下半屏终端，与文件列表各占一半。
3. 再点小按钮（或面板 ✕）：终端消失，文件列表恢复全高。
4. 打开终端后切到 chat/git tab，再切回 Files：终端仍是隐藏。

## 5. 涉及文件汇总

### 前端（lovdex-cli）

- 删除：`src/components/terminal/TerminalDrawer.tsx`、`src/components/terminal/TerminalToggleButton.tsx`、`src/components/terminal/TerminalToggleButton.test.tsx`、`src/hooks/useTerminalDrawer.test.ts`
- 改名：`src/components/terminal/TerminalDrawerPanel.tsx` → `TerminalPanel.tsx`；`TerminalDrawerPanel.test.tsx` → `TerminalPanel.test.tsx`
- 修改：`src/hooks/useTerminalDrawer.tsx`、`src/components/file-tree/view/FileTree.tsx`、`src/components/file-tree/view/FileTreeHeader.tsx`、`src/App.tsx`、`src/components/main-content/view/MainContent.tsx`、`src/components/tasks/TaskBoard.tsx`、`src/components/tasks/TaskDetail.tsx`
- 无改动：`src/components/terminal/TerminalPane.tsx`（继续从 context 读 `cwd`）、`src/components/terminal/terminalSession.ts`、`src/components/terminal/terminalSession.test.ts`

### 后端（lovdex-backend）

- 无改动。
