# 侧栏项目归属感（多展开 + 粘性分组头）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让侧栏的 Project 可以同时展开多个，并让展开的项目头在会话列表滚动时吸顶，会话区升级为「导轨 + 淡底」的整块面板，从而消除「不知道这条 session 属于哪个项目」。

**Architecture:** 三处独立改动叠加：状态层把 `expandedProjects` 从互斥手风琴改成累加集合（抽成纯函数以便测试）；结构层把 `sticky` 加在 `SidebarProjectItem` 的项目行 wrapper 上（它的包含块必须跨越会话列表，否则静默失效）；样式层把 1px 灰导轨换成 2px 主题色导轨 + 淡底面板。另配「全部收起」和展开时滚入视野两个配套。

**Tech Stack:** React 18 + TypeScript + Tailwind（CSS 变量主题 token）+ lucide-react；测试用 `node:test` + `react-dom/server` 的 `renderToStaticMarkup`（**无 DOM 环境**），运行器 `tsx`。

**设计文档：** `docs/superpowers/specs/2026-09-18-sidebar-project-context-design.md`

**所有命令都在 `web/` 目录下执行。**

---

## 开始前：记录验收基线

- [ ] **记录 typecheck / lint 的既有错误数**

```bash
cd web
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

仓库 baseline 本身不干净（存在与本次改动无关的 pre-existing 错误）。把这两个数字记下来，最后只要求**零新增**，不要试图修历史错误。

---

## Task 1: `toggleExpandedProject` 纯函数

把展开态切换抽成纯函数，这样无 DOM 环境下也能测 —— 这是本次唯一有真实逻辑的单元。

**Files:**
- Modify: `web/src/components/sidebar/utils/utils.ts`（在 `writeStoredExpandedProjects` 之后，约 :45 之后）
- Test: `web/src/components/sidebar/utils/utils.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/sidebar/utils/utils.test.ts` 顶部的 import 里加入 `toggleExpandedProject`（保持字母序，插在 `sortProjects` 与 `writeStoredExpandedProjects` 之间）：

```ts
import { excludeHiddenProjects, formatCompactSessionAge, getRecentSessions, getSessionDotState, isProjectActive, isSessionActive, isSessionRecentlyActive, readStoredExpandedProjects, sortProjects, toggleExpandedProject, writeStoredExpandedProjects } from './utils';
```

然后在文件末尾追加：

```ts
test('toggleExpandedProject adds a project that is not expanded', () => {
  const result = toggleExpandedProject(new Set<string>(), 'p1');
  assert.deepEqual([...result], ['p1']);
});

test('toggleExpandedProject removes a project that is already expanded', () => {
  const result = toggleExpandedProject(new Set(['p1']), 'p1');
  assert.deepEqual([...result], []);
});

test('toggleExpandedProject keeps other expanded projects', () => {
  const result = toggleExpandedProject(new Set(['p1', 'p2']), 'p3');
  assert.deepEqual([...result].sort(), ['p1', 'p2', 'p3']);
});

test('toggleExpandedProject does not mutate the input set', () => {
  const input = new Set(['p1']);
  toggleExpandedProject(input, 'p2');
  assert.deepEqual([...input], ['p1']);
});

test('toggleExpandedProject toggles back to the original state', () => {
  const input = new Set(['p1']);
  const once = toggleExpandedProject(input, 'p2');
  const twice = toggleExpandedProject(once, 'p2');
  assert.deepEqual([...twice].sort(), ['p1']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/utils/utils.test.ts
```

Expected: FAIL —— `toggleExpandedProject is not a function`（或 TS 报导出不存在）。

> `env -u TSX_TSCONFIG_PATH` 是必须的：shell 里可能残留全局导出的 `TSX_TSCONFIG_PATH=server/tsconfig.json`，会让 `tsx` 用错 tsconfig 而挂掉。

- [ ] **Step 3: 写最小实现**

在 `web/src/components/sidebar/utils/utils.ts` 的 `writeStoredExpandedProjects` 函数之后（约 :45 之后）插入：

```ts
/**
 * 切换单个 Project 的展开态，返回新集合（不修改入参）。
 * 侧栏支持同时展开多个 Project —— 展开集合是累加的，不再互斥。
 */
export const toggleExpandedProject = (
  expanded: ReadonlySet<string>,
  projectId: string,
): Set<string> => {
  const next = new Set(expanded);
  if (next.has(projectId)) {
    next.delete(projectId);
  } else {
    next.add(projectId);
  }
  return next;
};
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/utils/utils.test.ts
```

Expected: PASS，`# pass 34`（原 29 条 + 新增 5 条），`# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/sidebar/utils/utils.ts web/src/components/sidebar/utils/utils.test.ts
git commit -m "feat(sidebar): add toggleExpandedProject for additive expansion"
```

---

## Task 2: 控制器接线 —— 真正支持多展开

`useSidebarController.ts:353-361` 的 `toggleProject` 现在是「构造一个只含目标 id 的新 Set」，即点开 B 必收起 A。换成 Task 1 的纯函数。

**Files:**
- Modify: `web/src/components/sidebar/hooks/useSidebarController.ts:353-361`（函数体）与 `:11-22`（import）

- [ ] **Step 1: 加 import**

`useSidebarController.ts:11-22` 的 `../utils/utils` import 块里，在 `sortProjects,` 与 `writeStoredExpandedProjects,` 之间插入 `toggleExpandedProject,`：

```ts
import {
  clearLegacyStarredProjectIds,
  excludeHiddenProjects,
  filterProjects,
  getAllSessions,
  readLegacyStarredProjectIds,
  readStoredExpandedProjects,
  sortProjects,
  toggleExpandedProject,
  writeStoredExpandedProjects,
} from '../utils/utils';
```

- [ ] **Step 2: 替换 toggleProject 实现**

把 `useSidebarController.ts:353-361` 整段替换为：

```ts
  // All sidebar state keys (expanded, starred, loading, etc.) use the DB
  // `projectId` as their identifier after the migration.
  //
  // Expansion is additive: opening one project no longer collapses the others.
  // The persisted shape (a string array) already supports multiple ids, so
  // `readStoredExpandedProjects` / `writeStoredExpandedProjects` are unchanged.
  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => toggleExpandedProject(prev, projectId));
  }, []);
```

- [ ] **Step 3: typecheck**

```bash
cd web
npm run typecheck 2>&1 | tail -5
```

Expected: 错误数与「开始前」记录的 baseline 相同（零新增）。

- [ ] **Step 4: 提交**

```bash
git add web/src/components/sidebar/hooks/useSidebarController.ts
git commit -m "feat(sidebar): let multiple projects stay expanded"
```

---

## Task 3: 删除死代码 `forceExpanded`

`forceExpanded` 在 `SidebarProjectList` 里定义并使用，但**全仓没有任何调用方**（默认 `false`），且「强制全部展开」的语义与多展开冲突。删掉它，让展开态只有 `expandedProjects` 一个来源。

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarProjectList.tsx:33`、`:80`、`:132`

- [ ] **Step 1: 删除类型声明**

删除 `SidebarProjectList.tsx:33` 这一行：

```ts
  forceExpanded?: boolean;
```

- [ ] **Step 2: 删除解构默认值**

删除 `SidebarProjectList.tsx:80` 这一行：

```ts
  forceExpanded = false,
```

- [ ] **Step 3: 改用单一来源**

把 `SidebarProjectList.tsx:132` 的

```tsx
              isExpanded={forceExpanded || expandedProjects.has(project.projectId)}
```

改为

```tsx
              isExpanded={expandedProjects.has(project.projectId)}
```

- [ ] **Step 4: 确认全仓再无引用**

```bash
cd web
grep -rn "forceExpanded" src/
```

Expected: 无输出（退出码 1）。

- [ ] **Step 5: typecheck**

```bash
cd web
npm run typecheck 2>&1 | tail -5
```

Expected: 零新增错误。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/sidebar/view/subcomponents/SidebarProjectList.tsx
git commit -m "refactor(sidebar): drop dead forceExpanded prop"
```

---

## Task 4: 项目头吸顶

**这是本次最容易做错的一步。** `position: sticky` 只在元素的**包含块**范围内粘住。当前结构是：

```
<div className="md:space-y-1">            ← SidebarProjectItem.tsx:154，同时包含项目行与会话区
  <div className="md:group group">         ← :155，只包住项目行
    <div className="md:hidden">…</div>     ← :156 移动卡片
    <Button … />                           ← :318 桌面行
  </div>
  <SidebarProjectSessions … />             ← :484，在 :155 **外面**
</div>
```

所以 sticky **必须加在 `:155` 的 div 上**（它的包含块是 `:154`，跨越会话列表）。如果加在项目行按钮上，包含块只剩项目行自身高度，吸顶会**静默失效** —— 不报错，只是不吸顶。

同理，`:154` 与 `:155` 之间的祖先链上**不能**出现 `overflow-hidden` / `overflow-auto` / `overflow-scroll` 的容器，否则同样吃掉 sticky。

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx:155`

- [ ] **Step 1: 改 wrapper 的 className**

把 `SidebarProjectItem.tsx:155` 的

```tsx
      <div className="md:group group">
```

替换为：

```tsx
      {/* 项目头吸顶：sticky 的包含块是本元素的父级（:154 那个 div），而父级
          同时包含下面的 SidebarProjectSessions，所以项目头会一直粘到本项目
          会话列表结束，再被下一个项目行顶走。

          不要把它挪到项目行按钮上 —— 那样包含块只剩项目行自身高度，吸顶会
          静默失效。也不要在 :154 与本元素之间插入任何 overflow-hidden /
          overflow-auto 容器，同样会吃掉 sticky。 */}
      <div
        className={cn(
          'md:group group sticky top-0 z-20 bg-card',
          // 展开时才加底边：收起时后面没有会话，不需要「分组表头」语义。
          isExpanded && 'border-b border-border/50',
        )}
      >
```

- [ ] **Step 2: 确认 `cn` 已在该文件导入**

```bash
cd web
grep -n "from '../../../../lib/utils'" src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx
```

Expected: 命中 `import { cn } from '../../../../lib/utils';`（第 5 行已有，无需新增）。

- [ ] **Step 3: typecheck**

```bash
cd web
npm run typecheck 2>&1 | tail -5
```

Expected: 零新增错误。

- [ ] **Step 4: 浏览器验证吸顶（这一步不能跳过）**

启动前端（若未在运行），打开侧栏，展开一个会话数 ≥ 10 的项目，滚动项目列表：

```bash
cd web
npm run dev
```

Expected:
- 项目名一直贴在滚动区顶部，不会被会话行盖住
- 滚到本项目会话列表末尾时，项目头被下一个项目行**顶走**（不是突然消失）
- 同时展开两个项目时，各自的头分别吸顶

如果项目头被会话行盖住 → `z-20` 没生效或被更高层级覆盖，检查 `SidebarSessionItem` 是否有 `z-*`。
如果完全不吸顶 → 检查祖先链是否出现了 `overflow` 容器（见本节开头）。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx
git commit -m "feat(sidebar): stick the project row above its session list"
```

---

## Task 5: 展开时滚入视野

多展开之后列表会变长，点开靠下的项目时展开的内容可能落在视口外，看起来像「点了没反应」。

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx:1`（import）、`:145-151`（`selectAndToggleProject`）、`:154`（挂 ref）

- [ ] **Step 1: 加 useRef import**

把 `SidebarProjectItem.tsx:1` 的

```tsx
import { Check, ChevronDown, ChevronRight, Edit3, Plus, Server, Star, Trash2, X } from 'lucide-react';
```

替换为：

```tsx
import { useRef } from 'react';
import { Check, ChevronDown, ChevronRight, Edit3, Plus, Server, Star, Trash2, X } from 'lucide-react';
```

- [ ] **Step 2: 建 ref**

在 `SidebarProjectItem.tsx` 的 `const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);`（约 :118）之后插入：

```tsx
  // 挂在整个项目条目（项目行 + 会话区）上，用于展开后把内容滚进视野。
  const itemRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 3: 展开时滚入视野**

把 `SidebarProjectItem.tsx:145-151` 的

```tsx
  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };
```

替换为：

```tsx
  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    if (!isExpanded) {
      // 只在「本次是展开」时滚。'nearest' 保证元素已经在视口里就一动不动，
      // 避免每次点击都跳一下。等一帧让 React 先把会话列表渲染出来。
      requestAnimationFrame(() => {
        itemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    toggleProject();
  };
```

- [ ] **Step 4: 把 ref 挂到最外层 div**

把 `SidebarProjectItem.tsx:154` 的

```tsx
    <div className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none')}>
```

替换为：

```tsx
    <div
      ref={itemRef}
      className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none')}
    >
```

- [ ] **Step 5: typecheck**

```bash
cd web
npm run typecheck 2>&1 | tail -5
```

Expected: 零新增错误。

- [ ] **Step 6: 浏览器验证**

展开一个位于列表底部、展开后内容会超出视口的项目。

Expected: 页面平滑滚动，展开的会话可见。
Expected（反向）: 展开一个已经在视口内、内容也放得下的项目时，页面**不滚动**。

- [ ] **Step 7: 提交**

```bash
git add web/src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx
git commit -m "feat(sidebar): scroll an expanded project into view"
```

---

## Task 6: 会话区面板样式

导轨从 1px 灰线换成 2px 主题色，会话区加淡底 + 右侧圆角，与吸顶的项目头连成一整块面板。session 卡片本身是 `bg-card`，坐在淡底上会自然浮起来。

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx:87`
- Test: `web/src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx`（新建）

- [ ] **Step 1: 写失败的测试**

新建 `web/src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';

import type { Project } from '../../../../types/app';

import SidebarProjectSessions from './SidebarProjectSessions';

// 无 DOM 环境（见 Button.test.tsx）：只做静态渲染 + 类名断言。
const t = ((key: string) => key) as unknown as TFunction;

const project: Project = {
  projectId: 'p1',
  displayName: 'P1',
  fullPath: '/p1',
  sessions: [],
};

// 会话列表留空 + initialSessionsLoaded=true，走空态分支 —— 这样不必渲染
// SidebarSessionItem（它需要另外二十来个 props），但面板容器本身照样输出。
const baseProps = {
  project,
  sessions: [],
  selectedSession: null,
  initialSessionsLoaded: true,
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  activeSessions: new Map(),
  attentionSessionIds: new Set<string>(),
  currentTime: new Date('2026-09-18T12:00:00Z'),
  editingSession: null,
  editingSessionName: '',
  onEditingSessionNameChange: () => {},
  onStartEditingSession: () => {},
  onCancelEditingSession: () => {},
  onSaveEditingSession: () => {},
  onProjectSelect: () => {},
  onSessionSelect: () => {},
  onDeleteSession: () => {},
  onLoadMoreSessions: () => {},
  t,
};

test('renders nothing when the project is collapsed', () => {
  const html = renderToStaticMarkup(
    React.createElement(SidebarProjectSessions, { ...baseProps, isExpanded: false }),
  );
  assert.equal(html, '');
});

test('renders the session rail as a tinted panel when expanded', () => {
  const html = renderToStaticMarkup(
    React.createElement(SidebarProjectSessions, { ...baseProps, isExpanded: true }),
  );
  assert.match(html, /border-l-2/);
  assert.match(html, /bg-muted\/25/);
});
```

- [ ] **Step 2: 跑测试确认第一条通过、第二条失败**

```bash
cd web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx
```

Expected: 第 1 条 PASS（`isExpanded: false` 已经返回 `null`）；第 2 条 FAIL（当前导轨还是 `border-l border-border`，匹配不到 `border-l-2`）。

- [ ] **Step 3: 改样式**

把 `SidebarProjectSessions.tsx:87` 的

```tsx
    <div className="ml-3 space-y-1 border-l border-border pl-3">
```

替换为：

```tsx
    <div className="ml-3 space-y-1 rounded-r-lg border-l-2 border-primary/30 bg-muted/25 py-1 pl-3">
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx
```

Expected: PASS，`# pass 2`，`# fail 0`。

- [ ] **Step 5: 浏览器验证观感**

Expected:
- 导轨明显可辨，但不抢眼
- 会话区读起来是一整块面板，和项目头连在一起
- 浅色 / 深色主题下都不刺眼（切换系统主题各看一次）

若 `border-primary/30` 太重，先降到 `/20`；若 `bg-muted/25` 太脏，降到 `/15`。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx web/src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx
git commit -m "feat(sidebar): turn the session rail into a tinted panel"
```

---

## Task 7: 「全部收起」

多展开后列表会变长，需要一个一键复位。按钮放在「项目」区块标题行右侧，仅当有项目展开时出现。

**Files:**
- Modify: `web/src/components/sidebar/hooks/useSidebarController.ts`（新增回调 + 返回对象）
- Modify: `web/src/components/sidebar/view/Sidebar.tsx:91`（解构）、`:270-290`（传 props）
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx:1`（import）、`:52-75`（props 类型）、`:96-123`（解构）、`:152-177`（标题行）

- [ ] **Step 1: 控制器加回调**

在 `useSidebarController.ts` 的 `toggleProject` 定义（Task 2 改完后的那几行）**之后**插入：

```ts
  /** 一键收起所有已展开的 Project。 */
  const collapseAllProjects = useCallback(() => {
    setExpandedProjects(new Set<string>());
  }, []);
```

- [ ] **Step 2: 控制器导出回调**

在 `useSidebarController.ts` 的 return 对象里，`toggleProject,` 这一行**之后**插入：

```ts
    collapseAllProjects,
```

- [ ] **Step 3: Sidebar 解构**

在 `Sidebar.tsx:91` 的 `toggleProject,` 之后插入：

```ts
    collapseAllProjects,
```

- [ ] **Step 4: Sidebar 透传两个 props**

在 `Sidebar.tsx` 的 `<SidebarContent …>`（:270 起）里，`onRecentSessionSelect={…}`（:330）那一行**之前**插入：

```tsx
            hasExpandedProjects={filteredProjects.some((project) => expandedProjects.has(project.projectId))}
            onCollapseAllProjects={collapseAllProjects}
```

> 只传布尔值，不把整个 `Set` 漏进内容组件。
>
> **实现时修正**：原稿这里写的是 `expandedProjects.size > 0`，落地后改为按「可见项目」派生。原因是 `expandedProjects` 从不清理失效 id（项目被删、或被 `excludeHiddenProjects` 滤掉的 operator 工作区），用 `size` 会出现「按钮在、但列表里没有任何可见的展开项」，点下去唯一的变化是按钮自己消失。见 commit `9800c3b`。

- [ ] **Step 5: SidebarContent 加 import**

把 `SidebarContent.tsx:1-2` 的

```tsx
import { type ReactNode, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, MessageSquare, Search } from 'lucide-react';
```

替换为：

```tsx
import { type ReactNode, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, Folder, MessageSquare, Search } from 'lucide-react';
```

- [ ] **Step 6: SidebarContent 加 props 类型**

在 `SidebarContent.tsx` 的 `SidebarContentProps` 里，`/** 点击「最近任务」里某条会话：打开该会话对话。 */` 那一行**之前**插入：

```ts
  /** 是否有 Project 处于展开态 —— 决定「全部收起」按钮是否出现。 */
  hasExpandedProjects: boolean;
  /** 一键收起所有已展开的 Project。 */
  onCollapseAllProjects: () => void;
```

- [ ] **Step 7: SidebarContent 解构**

在 `SidebarContent.tsx` 的函数参数解构里，`projectListProps,` 之后插入：

```ts
  hasExpandedProjects,
  onCollapseAllProjects,
```

- [ ] **Step 8: 改写「项目」标题行**

把 `SidebarContent.tsx:152-177` 整段（`<div className="flex-shrink-0 px-2 pt-1.5 md:px-1.5">` 到它对应的 `</div>`）替换为：

```tsx
      <div className="flex flex-shrink-0 items-center gap-1 px-2 pt-1.5 md:px-1.5">
        <button
          type="button"
          onClick={() =>
            setProjectsCollapsed((prev) => {
              const next = !prev;
              try {
                localStorage.setItem('lovdex:sidebar:projects-collapsed', next ? '1' : '0');
              } catch {
                // ignore storage failures
              }
              return next;
            })
          }
          title={projectsCollapsed ? '展开 项目' : '收起 项目'}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
        >
          {projectsCollapsed ? (
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          )}
          <Folder className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">项目</span>
        </button>
        {/* 文案硬编码中文，与紧邻的「项目」「展开 项目 / 收起 项目」一致 ——
            仓库只有 en locale，这一区块本来就是硬编码中文。 */}
        {hasExpandedProjects && (
          <button
            type="button"
            onClick={onCollapseAllProjects}
            title="收起全部项目"
            aria-label="收起全部项目"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
```

> 注意 `w-full` 改成了 `min-w-0 flex-1`：标题按钮和收起按钮现在是同一 flex 行里的兄弟节点。收起按钮**不是**嵌套在标题按钮里，所以不需要 `stopPropagation`。

- [ ] **Step 9: typecheck + lint**

```bash
cd web
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: 两者都是零新增。若 `npm run typecheck` 报 `SidebarContent` 缺少 `hasExpandedProjects`，说明 Step 4 的透传没加上。

- [ ] **Step 10: 浏览器验证**

Expected:
- 没有任何项目展开时，「全部收起」按钮**不出现**
- 展开一个项目 → 按钮出现，点击后所有项目收起，按钮随即消失
- 按钮与「项目」标题在同一行，标题仍占满剩余宽度、长标题会截断
- 点击按钮**不会**连带切换「项目」区块的折叠状态（那是左边那个按钮的事）

- [ ] **Step 11: 提交**

```bash
git add web/src/components/sidebar/hooks/useSidebarController.ts web/src/components/sidebar/view/Sidebar.tsx web/src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(sidebar): add a collapse-all button for expanded projects"
```

---

## Task 8: 全量验收

**Files:** 无改动（只跑验证）

- [ ] **Step 1: 跑侧栏相关的全部前端测试**

```bash
cd web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/utils/utils.test.ts
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx
```

Expected: 分别 `# fail 0`。

- [ ] **Step 2: typecheck / lint 对照 baseline**

```bash
cd web
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: 与「开始前」记录的数字一致（零新增）。

- [ ] **Step 3: 浏览器手动清单（无 DOM 环境，这些只能靠人眼）**

sticky 的包含块、滚动容器的 padding 边界都由 CSS 布局解析，自动化测试覆盖不到。逐条走：

1. 桌面端：展开一个会话数 ≥ 10 的项目，滚动 —— 项目名一直贴在滚动区顶部，滚到末尾被下一个项目顶走
2. 同时展开两个项目 —— 两个都保持展开，各自的头分别吸顶
3. 刷新页面 —— 两个项目的展开态都从 localStorage 恢复
4. 「全部收起」一键复位；无展开项目时按钮不出现
5. 展开靠下方的项目 —— 自动滚入视野
6. 移动端抽屉（窗口宽度 < 768px）：同样的滚动 / 吸顶行为，且不遮挡底部「最近任务」「定时任务」区块
7. 搜索会话（输入 ≥ 2 个字符）→ 清空 —— 展开态在搜索前后保持
8. 深色主题下再看一遍导轨与面板的对比度

- [ ] **Step 4: 确认工作区干净**

```bash
git status --short
```

Expected: 只剩与本次无关的既有未跟踪文件（如 `backend/asyncify-tmp.cjs`）。

---

## 已知不做（避免实现时跑偏）

- **项目色**（按 `projectId` 哈希分配稳定强调色）：会与侧栏已有的 primary / 绿 / 琥珀 / 靛四套语义色冲突，暗色模式还要重调。将来若仍觉得不够，可以叠在本次改动上加，不需要返工。
- **「最近任务」区块的项目归属提示**（`SidebarRecentSessions.tsx:95-98` 的项目名是 10px 灰字）：用户明确本次不做。
- **项目行路径截断 / 重名区分**：本次不做。
- **session 行上的项目面包屑**：与嵌套结构重复，会加噪音。
- **「吸顶时才显示底边」**：需要 `IntersectionObserver`，成本高于收益。当前是展开态常显底边。
- **移动端卡片的滚入视野**：Task 5 只把 `scrollIntoView` 接在 `selectAndToggleProject` 上，而移动端卡片（`md:hidden` 那个分支）走的是裸 `toggleProject`，所以移动抽屉里展开靠下的项目不会自动滚入视野。桌面端正常。设计 §5 给移动端的缓解手段本就是「全部收起」，这里是有意取舍；若要补齐，需抽一个只做滚动的 helper（直接复用 `selectAndToggleProject` 会顺带触发 `onProjectSelect`，语义会变）。
- **视口高度不足时项目列表被挤扁**：侧栏是 flex 列，助手区与「最近任务」（`max-h-[28vh]`）都是 `flex-shrink-0`，在 900px 高的视口里两者合计可占满，`flex-1` 的项目列表会被压到接近 0 高度。这是**既有**布局特性，本次改动未加剧，但会在矮窗口 + 助手会话较多时让项目列表几乎不可见。属独立问题，另行处理。
