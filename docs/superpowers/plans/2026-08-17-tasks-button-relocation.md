# Tasks 按钮迁至 Lovdex 行 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Tasks 入口从主内容区顶部 tabs 挪到侧边栏 Lovdex 行（与刷新/创建/隐藏同行），图标用 amber 橙。

**Architecture:** 纯前端展示层改动，共 3 个文件。`SidebarHeader` 新增 Tasks 图标按钮并直接 `navigate('/tasks')`（沿用 `MainContentTabs` 已有的直接导航模式，不在 Sidebar→SidebarContent→SidebarHeader 三层穿参）；`MainContentTabs` 删除 Tasks 项；`sidebar.json` 加 tooltip 文案。

**Tech Stack:** React 18 + TypeScript + Tailwind CSS + lucide-react + react-router-dom v6。

**测试说明：** `web` 包无测试运行器（package.json 只有 `typecheck`/`lint`/`build`，无 vitest/jest，也未安装 @testing-library）。因此本计划用 `typecheck` + `lint` + `build` 作为自动化验证，外加浏览器手动确认。不为这两个纯展示组件新建测试框架（YAGNI，超出本次范围）。

---

### Task 1: SidebarHeader 新增 Tasks 图标按钮

**Files:**
- Modify: `web/src/i18n/locales/en/sidebar.json:39-58`（tooltips 区）
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx`

- [ ] **Step 1: 加 tooltip 文案**

在 `web/src/i18n/locales/en/sidebar.json` 的 `tooltips` 对象里，`"refresh"` 行之后新增一行：

```json
    "refresh": "Refresh projects and sessions (Ctrl+R)",
    "tasks": "Tasks",
```

（注意保留原 `"refresh"` 行的逗号，新行以逗号结尾。）

- [ ] **Step 2: 修改 SidebarHeader import**

`web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx` 第 1 行改为：

```tsx
import { Activity, ClipboardList, Folder, FolderPlus, Plus, RefreshCw, Search, Star, X, PanelLeftClose } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
```

（原第 1 行没有 `ClipboardList`，且没有 react-router-dom 的 import；其余 import 不变。）

- [ ] **Step 3: 在组件内加 navigate**

在 `export default function SidebarHeader({ ... }: SidebarHeaderProps)` 函数体开头（`const showSearchTools = ...` 之前）加：

```tsx
  const navigate = useNavigate();
```

- [ ] **Step 4: 桌面端按钮组加 Tasks 按钮**

在桌面端 `<div className="flex flex-shrink-0 items-center gap-0.5">`（含刷新/创建/隐藏三个 `Button`）里，作为第一个子元素插入：

```tsx
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-amber-500 hover:bg-muted hover:text-amber-500"
              onClick={() => navigate('/tasks')}
              title={t('tooltips.tasks')}
            >
              <ClipboardList className="h-3.5 w-3.5" />
            </Button>
```

插入后按钮顺序为：Tasks → 刷新 → 创建 → 隐藏。

- [ ] **Step 5: 移动端头部加 Tasks 按钮**

在移动端 `<div className="flex flex-shrink-0 gap-1.5">`（含刷新/创建两个 `<button>`）里，作为第一个子元素插入：

```tsx
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
              onClick={() => navigate('/tasks')}
              title={t('tooltips.tasks')}
            >
              <ClipboardList className="h-4 w-4 text-amber-500" />
            </button>
```

插入后按钮顺序为：Tasks → 刷新 → 创建。

- [ ] **Step 6: typecheck**

Run: `cd web && npm run typecheck`
Expected: 无错误（退出码 0）。

- [ ] **Step 7: Commit**

```bash
git add web/src/i18n/locales/en/sidebar.json web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx
git commit -m "feat(web): add Tasks entry to Lovdex header row"
```

---

### Task 2: MainContentTabs 移除 Tasks 项

**Files:**
- Modify: `web/src/components/main-content/view/subcomponents/MainContentTabs.tsx`

- [ ] **Step 1: 删除不再使用的 import**

第 1 行删掉 `ClipboardList`，第 2 行整行删除 `useNavigate` import。改后顶部为：

```tsx
import { FolderOpen, GitBranch, MessageSquare } from 'lucide-react';
import type { AppTab } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
```

- [ ] **Step 2: 删除组件内 navigate**

删除 `function MainContentTabs(...)` 函数体开头的 `const navigate = useNavigate();` 一行。

- [ ] **Step 3: 删除 Tasks 按钮 JSX**

删除 `<button type="button" aria-pressed={false} title="Tasks" ... > ... </button>` 整块（含 `ClipboardList` 图标与 `Tasks` 文本）。删完后 `workspace.map(...)` 之后直接是 `</div>`。

- [ ] **Step 4: 更新组件注释**

把文件顶部 `MainContentTabs` 的 JSDoc 注释替换为：

```tsx
/**
 * Workspace tabs: chat / files / git switch the in-place activeTab.
 * The Tasks entry point now lives in the sidebar header (Lovdex row).
 */
```

- [ ] **Step 5: lint + typecheck**

Run: `cd web && npm run lint && npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/main-content/view/subcomponents/MainContentTabs.tsx
git commit -m "refactor(web): drop Tasks tab from workspace tabs"
```

---

### Task 3: 构建验证

**Files:** 无（仅验证）

- [ ] **Step 1: build**

Run: `cd web && npm run build`
Expected: 构建成功，`dist/` 产出。

- [ ] **Step 2: 手动确认**

`cd web && npm run dev`（或运行打包产物）后确认：
- 桌面端 Lovdex 行出现 amber 橙 Tasks 按钮，点击跳转 `/tasks`。
- 移动端侧边栏头部出现 Tasks 按钮（在刷新、创建之前）。
- 主内容区顶部 tabs 只剩 Chat / Files / Source Control，无 Tasks。

---

## Self-Review

- **Spec coverage:** spec 三处改动（SidebarHeader / MainContentTabs / sidebar.json）分别对应 Task 1、Task 2、Task 1-Step 1。范围外项（路由、TaskBackNav、隐藏按钮仅桌面端）均未触碰。
- **Placeholder scan:** 无 TBD/TODO，所有代码步骤均含完整代码。
- **Type consistency:** `useNavigate`/`navigate('/tasks')`、`t('tooltips.tasks')`、`ClipboardList` 在各步骤一致；`tooltips.tasks` 键在 Task 1-Step 1 定义、Task 1-Step 4/5 使用。
