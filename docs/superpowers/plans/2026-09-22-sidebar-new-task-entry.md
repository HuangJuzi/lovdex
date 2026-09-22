# 侧栏新建任务入口 + 区块行风格统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧栏顶部按钮从「新建项目」改为「新建任务」（就地弹窗、建完跳 `/tasks`），新建项目能力挪到「项目」行的 hover `+`；同时把「项目」「最近会话」两行统一成 Lovdex助手 风格（箭头在右、动作 hover 显形、淡紫底）。

**Architecture:** 抽一个 `SidebarSectionRow` 共用行组件承载统一后的行样式；「项目」行与「最近会话」行都改用它。新建任务弹窗复用任务面板已有的 `CreateTaskDialog`，挂在侧栏的弹窗 hub `SidebarModals` 里，`onCreated` 时 `navigate('/tasks', { state: { createdTaskId } })`；`TaskBoard` 读这个 state 复用既有的「任务被筛选藏住」提示条。

**Tech Stack:** React 18 + TypeScript + react-router-dom + Tailwind（含 `touch:` 自定义变体）+ lucide-react；测试用 `node:test` + `renderToStaticMarkup`（无 DOM 环境）。

**Spec:** `docs/superpowers/specs/2026-09-22-sidebar-new-task-entry-design.md`

**基线（2026-09-22 实测，验收时对比）：**
- `npx tsc --noEmit -p tsconfig.json` → **0 errors**
- `npx eslint src/` → **0 errors / 227 warnings**
- web 测试命令必须带 `env -u TSX_TSCONFIG_PATH`（全局导出的 `TSX_TSCONFIG_PATH=server/tsconfig.json` 会让 `npx tsx` 直接崩）

**提交纪律：每个 Task 结束时的提交都必须让 `tsc` 保持 0 error。** 下面 Task 4 之所以把 5 个文件塞进同一个提交，是因为 `onCreateTask` 这个 prop 要在 `Sidebar.tsx → SidebarContent → SidebarHeader` 三层同时改名，拆开提交中间态必然编译不过。

---

## 文件结构

| 文件 | 职责 | 动作 | Task |
|---|---|---|---|
| `web/src/components/sidebar/view/subcomponents/SidebarSectionRow.tsx` | 侧栏区块整行标题（图标+标题在左、动作+箭头在右） | 新建 | 1 |
| `web/src/components/sidebar/view/subcomponents/SidebarSectionRow.test.tsx` | 上者的 SSR 测试 | 新建 | 1 |
| `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx` | 「最近会话」区块，改用行组件 | 修改 | 2 |
| `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx` | 补「箭头在右」断言 | 修改 | 2 |
| `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx` | 「项目」行改用行组件 + hover `新建项目`；转发 `onCreateTask` | 修改 | 3, 4 |
| `web/src/components/sidebar/view/subcomponents/SidebarContent.test.tsx` | 上者的 SSR 测试 | 新建 | 3, 4 |
| `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx` | 顶部按钮改为「新建任务」 | 修改 | 4 |
| `web/src/components/sidebar/view/subcomponents/SidebarHeader.test.tsx` | 上者的 SSR 测试 | 新建 | 4 |
| `web/src/components/sidebar/view/subcomponents/SidebarModals.tsx` | 挂 `CreateTaskDialog` | 修改 | 4 |
| `web/src/components/sidebar/view/Sidebar.tsx` | 接线：`showNewTask` + `navigate('/tasks')` | 修改 | 4 |
| `web/src/components/sidebar/hooks/useSidebarController.ts` | 新增 `showNewTask` state | 修改 | 4 |
| `web/src/components/tasks/createdTaskHandoff.ts` | 解析 `location.state.createdTaskId` | 新建 | 5 |
| `web/src/components/tasks/createdTaskHandoff.test.ts` | 上者的单元测试 | 新建 | 5 |
| `web/src/components/tasks/TaskBoard.tsx` | 消费 `createdTaskId`，复用 `hiddenCreated` 提示条 | 修改 | 5 |
| `web/src/i18n/locales/en/sidebar.json` | 新增 `tooltips.createTask` | 修改 | 4 |

---

## Task 0: 先落库工作区里已有的未提交改动

工作区里有一批**与本次需求无关**的未提交改动（会话开始前就在了）：把侧栏文案「最近任务」改成「最近会话」，共 6 个文件 14 行。其中 3 个正是本计划要改的文件，不先处理掉就会混进后面的提交。

**Files:**
- `backend/server/modules/database/repositories/sessions.db.ts`
- `web/src/components/sidebar/utils/utils.ts`
- `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx`
- `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx`
- `web/src/types/app.ts`

- [ ] **Step 1: 确认这批改动确实只是文案改名**

```bash
cd /mnt/b/workdir/github/lovdex && git diff --stat && git diff -U0 | grep -E '^[+-][^+-]' | grep -v '最近任务\|最近会话'
```

Expected: `--stat` 显示 6 files / 14 insertions / 14 deletions，第二条命令**无输出**（每一处改动都是这两个词之间的替换）。

若第二条命令**有输出**，说明这批改动不止文案 —— 停下来找用户确认，不要提交。

- [ ] **Step 2: 跑一遍受影响的测试确认是绿的**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx
```

Expected: `# pass 5` / `# fail 0`

- [ ] **Step 3: 单独提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add \
  backend/server/modules/database/repositories/sessions.db.ts \
  web/src/components/sidebar/utils/utils.ts \
  web/src/components/sidebar/view/subcomponents/SidebarContent.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx \
  web/src/types/app.ts
git commit -m "chore(sidebar): rename the 最近任务 copy to 最近会话"
```

- [ ] **Step 4: 确认工作区干净**

```bash
git status --short
```

Expected: 无输出（clean）。

> **若用户表示不要提交这批改动**：跳过 Task 0，改为在每个提交前用 `git add -p` 只 stage 自己的 hunk，并在最终汇报里说明工作区仍有未提交改动。

---

## Task 1: `SidebarSectionRow` 共用行组件

**Files:**
- Create: `web/src/components/sidebar/view/subcomponents/SidebarSectionRow.tsx`
- Test: `web/src/components/sidebar/view/subcomponents/SidebarSectionRow.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `web/src/components/sidebar/view/subcomponents/SidebarSectionRow.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { Folder } from 'lucide-react';

import SidebarSectionRow from './SidebarSectionRow';

const noop = () => {};

test('箭头渲染在标题之后（在右）', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed={false} onToggle={noop} />,
  );
  assert.ok(html.includes('>项目</span>'));
  // 「箭头都在右边」这条需求就靠这一条断言钉住：chevron 必须出现在标题文案之后。
  assert.ok(html.indexOf('lucide-chevron-down') > html.indexOf('>项目</span>'));
});

test('collapsed 时用 chevron-right，title 为「展开 X」', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed onToggle={noop} />,
  );
  assert.ok(html.includes('lucide-chevron-right'));
  assert.ok(!html.includes('lucide-chevron-down'));
  assert.ok(html.includes('展开 项目'));
});

test('展开时 title 为「收起 X」', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed={false} onToggle={noop} />,
  );
  assert.ok(html.includes('收起 项目'));
});

test('actions 渲染进行内动作区，且在箭头之前', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow
      icon={Folder}
      label="项目"
      collapsed={false}
      onToggle={noop}
      actions={<div title="新建项目" />}
    />,
  );
  assert.ok(html.includes('title="新建项目"'));
  assert.ok(html.indexOf('title="新建项目"') < html.indexOf('lucide-chevron-down'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarSectionRow.test.tsx
```

Expected: FAIL — `Cannot find module './SidebarSectionRow'`

- [ ] **Step 3: 实现组件**

创建 `web/src/components/sidebar/view/subcomponents/SidebarSectionRow.tsx`：

```tsx
import type { ComponentType, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

type SidebarSectionRowProps = {
  icon: ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * hover 才显形的右侧动作区。每个动作**自己**带
   * `opacity-0 group-hover:opacity-100 touch:opacity-100` —— 组件不替它兜底，
   * 因为各动作的配色不同（primary / foreground / destructive）。
   */
  actions?: ReactNode;
  /** 挂在最外层 wrapper 上，用于加分隔线等。tailwind-merge 会正确覆盖。 */
  className?: string;
  /**
   * 区块体（可折叠的列表等）。渲染在标题行**下方、同一个 wrapper 内**，
   * 这样 wrapper 的 `px-2 pt-1.5 md:px-1.5` 同时作用于标题与区块体 ——
   * 调用方不必在兄弟节点上复刻一遍内边距，`className` 里的 `pb-2` 也
   * 自然落在区块底部而不是标题与列表之间。
   */
  children?: ReactNode;
};

/**
 * 侧栏区块的整行标题：图标 + 标题在左，动作区 + 折叠箭头在右，**箭头永远在最右**。
 * 样式对齐 SidebarAssistant / SidebarScheduledEntry / SidebarInboxEntry 那几行。
 *
 * 触屏没有 hover，动作区靠 `touch:opacity-100` 常显 —— 那是 src/index.css 里
 * `@media (hover: none) and (pointer: coarse)` 下的 `opacity: 1 !important`。
 * 所以一份 markup 同时管桌面和触屏，不必像 SidebarAssistant 那样拆两套。
 */
export default function SidebarSectionRow({
  icon: Icon,
  label,
  collapsed,
  onToggle,
  actions,
  className,
  children,
}: SidebarSectionRowProps) {
  return (
    <div className={cn('group flex-shrink-0 px-2 pt-1.5 md:px-1.5', className)}>
      <Button
        variant="ghost"
        className="flex h-auto w-full justify-between bg-primary/5 p-2 font-normal hover:bg-muted"
        onClick={onToggle}
        title={`${collapsed ? '展开' : '收起'} ${label}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Icon className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">
            {label}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {actions}
          {collapsed ? (
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          )}
        </div>
      </Button>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarSectionRow.test.tsx
```

Expected: `# pass 4` / `# fail 0`

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add \
  web/src/components/sidebar/view/subcomponents/SidebarSectionRow.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarSectionRow.test.tsx
git commit -m "feat(sidebar): add a shared section-row component with the chevron on the right"
```

---

## Task 2: 「最近会话」行改用 `SidebarSectionRow`

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx:1-2,43-111`
- Test: `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `SidebarRecentSessions.test.tsx` 末尾追加：

```tsx
test('箭头渲染在标题之后（在右）', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z')])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('>最近会话</span>'));
  assert.ok(html.indexOf('lucide-chevron-down') > html.indexOf('>最近会话</span>'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx
```

Expected: FAIL 在新增那条 —— 改造前 chevron 在标题**之前**，`indexOf('lucide-chevron-down')` 小于标题位置。

- [ ] **Step 3: 换掉行 markup**

**3a.** 第 2 行 lucide import 只留 `History`：

```tsx
import { History } from 'lucide-react';
```

**3b.** 加一行 import：

```tsx
import SidebarSectionRow from './SidebarSectionRow';
```

**3c.** 把 `return (` 到文件末尾（当前第 43-111 行）整段替换为：

```tsx
  return (
    <SidebarSectionRow
      icon={History}
      label="最近会话"
      collapsed={collapsed}
      onToggle={toggleCollapsed}
      // 行组件自带 `px-2 pt-1.5 md:px-1.5`；分隔线与下间距通过 className 挂在它的 wrapper 上。
      // `pb-2` 落在整个区块底部 —— 因为列表作为 children 渲染在同一个 wrapper 内。
      className="border-t border-border/60 pb-2"
    >
      {!collapsed && (
        <div className="ml-3 max-h-[28vh] overflow-y-auto border-l border-border pl-3">
          {recent.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">暂无最近会话</p>
          ) : (
            <div className="space-y-0.5 py-1">
              {recent.map(({ session, project }) => {
                const provider = session.__provider ?? session.provider;
                return (
                  <button
                    key={`${project.projectId}-${session.id}`}
                    type="button"
                    onClick={() => onRecentSessionSelect(session, project)}
                    className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs font-normal text-foreground">
                        {resolveSessionTitle(session) ?? '新建会话'}
                      </span>
                      {provider && provider !== 'claude' && (
                        <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-4xs uppercase text-muted-foreground">
                          {provider}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3">
                      <span className="min-w-0 flex-1 truncate text-3xs text-muted-foreground">
                        {project.displayName || project.projectId}
                      </span>
                      <span className="flex-shrink-0 text-3xs text-muted-foreground/60">
                        {formatCompactSessionAge(getSessionTime(session), currentTime)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </SidebarSectionRow>
  );
}
```

> **注意**：`toggleCollapsed` 在原文件里**不存在** —— 折叠逻辑是内联在旧 `onClick` 里的，需要先按原样抽成具名函数（同一个 `COLLAPSE_KEY`、同一个 try/catch、同一个返回值）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx
```

Expected: `# pass 6` / `# fail 0`

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add \
  web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx
git commit -m "refactor(sidebar): move the 最近会话 chevron to the right via SidebarSectionRow"
```

---

## Task 3: 「项目」行改用 `SidebarSectionRow` + hover「新建项目」

本任务结束时顶部按钮**仍然**打开新建项目向导（`onCreateProject` 继续原样转发给 `SidebarHeader`）—— 那一步在 Task 4。这样拆是为了让每个提交都能编译。

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx:2,159-198`
- Test: `web/src/components/sidebar/view/subcomponents/SidebarContent.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `web/src/components/sidebar/view/subcomponents/SidebarContent.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarContent from './SidebarContent';
import type { SidebarProjectListProps } from './SidebarProjectList';

const noop = () => {};
const t = ((k: string) => k) as never;

// SidebarContent 的 props 太多，这里只填渲染路径真正会读到的字段；
// 空项目列表会让 SidebarProjectList 走 SidebarProjectsState 分支。
const projectListProps = {
  projects: [],
  filteredProjects: [],
  selectedProject: null,
  selectedSession: null,
  isLoading: false,
  loadingProgress: null,
  expandedProjects: new Set<string>(),
  editingProject: null,
  editingName: '',
  initialSessionsLoaded: new Set<string>(),
  currentTime: new Date(),
  editingSession: null,
  editingSessionName: '',
  deletingProjects: new Set<string>(),
  tasksEnabled: false,
  mcpServerStatus: {} as never,
  getProjectSessions: () => [],
  onLoadMoreSessions: noop,
  loadingMoreProjects: new Set<string>(),
  activeSessions: {},
  attentionSessionIds: new Set<string>(),
  isProjectStarred: () => false,
  onEditingNameChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onNewSession: noop,
  onEditingSessionNameChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  t,
} as unknown as SidebarProjectListProps;

const render = (overrides: { hasExpandedProjects?: boolean } = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SidebarContent
        activeSessionId={null}
        isPWA={false}
        isMobile={false}
        width={288}
        onWidthChange={noop}
        onReset={noop}
        isLoading={false}
        projects={[]}
        runningSessionsCount={0}
        searchFilter=""
        onSearchFilterChange={noop}
        onClearSearchFilter={noop}
        conversationResults={null}
        isSearching={false}
        searchProgress={null}
        onConversationResultClick={noop}
        onRefresh={noop}
        isRefreshing={false}
        onCreateProject={noop}
        onCollapseSidebar={noop}
        updateAvailable={false}
        restartRequired={false}
        releaseInfo={null}
        latestVersion={null}
        onShowVersionModal={noop}
        onShowSettings={noop}
        projectListProps={projectListProps}
        hasExpandedProjects={overrides.hasExpandedProjects ?? false}
        onCollapseAllProjects={noop}
        onRecentSessionSelect={noop}
        t={t}
      />
    </MemoryRouter>,
  );

test('「项目」行渲染出 hover 的新建项目按钮', () => {
  const html = render();
  assert.ok(html.includes('title="新建项目"'));
  assert.ok(html.includes('lucide-folder-plus'));
});

test('「项目」行的箭头在标题之后（在右）', () => {
  const html = render();
  assert.ok(html.includes('>项目</span>'));
  assert.ok(html.indexOf('lucide-chevron-down') > html.indexOf('>项目</span>'));
});

test('新建项目按钮在箭头之前', () => {
  const html = render();
  assert.ok(html.indexOf('title="新建项目"') < html.indexOf('lucide-chevron-down'));
});

test('没有展开项时不渲染「收起全部项目」', () => {
  assert.ok(!render({ hasExpandedProjects: false }).includes('title="收起全部项目"'));
});

test('有展开项时渲染「收起全部项目」', () => {
  assert.ok(render({ hasExpandedProjects: true }).includes('title="收起全部项目"'));
});

test('动作图标带 ! 前缀（否则被 Button 的 [&_svg]:size-4 顶成 16px）', () => {
  // 实测过：`Button` 基础类里的 `[&_svg]:size-4` 是后代选择器，特异度 (0,1,1)，
  // 高于 svg 上的普通 `.h-3\.5` (0,1,0)，所以不加 ! 会渲染成 16px 而不是 14px。
  assert.ok(render({ hasExpandedProjects: true }).includes('!h-3.5 !w-3.5'));
});

test('动作按钮带 group-focus-within:opacity-100（键盘 Tab 时也要显形）', () => {
  // 这条不只是样式断言：`group-focus-within:opacity-100` 此前只写在
  // SidebarSectionRow 的 JSDoc 注释里，Tailwind 3 的扫描器是**按原始字节正则扫**、
  // 不剥注释，所以那个工具类是靠注释文本才生成的。这里是它第一个真实消费者 ——
  // 断言钉住它，免得注释被改写后工具类静默消失、键盘用户又看不见动作按钮。
  assert.ok(render({ hasExpandedProjects: true }).includes('group-focus-within:opacity-100'));
});
```

> 这个测试会打到 React 的 `useLayoutEffect does nothing on the server` warning（`SidebarFooter` 引起），属正常噪声，不影响断言。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarContent.test.tsx
```

Expected: FAIL —— `title="新建项目"` 找不到（现在「新建项目」只是 header 按钮的 tooltip key，不是这个 title）。

- [ ] **Step 3: 改 `SidebarContent.tsx`**

**3a.** 第 2 行 lucide import —— 去掉 `ChevronDown, ChevronRight`（只有「项目」行在用），加上 `FolderPlus`：

```tsx
import { ChevronsDownUp, Folder, FolderPlus, MessageSquare, Search } from 'lucide-react';
```

**3b.** 在 `import SidebarRecentSessions from './SidebarRecentSessions';` 旁边加：

```tsx
import SidebarSectionRow from './SidebarSectionRow';
```

**3c.** 把第 159-198 行（`<div className="flex flex-shrink-0 items-center gap-1 px-2 pt-1.5 md:px-1.5">` 那一整块，含「项目」折叠按钮与「收起全部项目」按钮）整块替换为：

```tsx
      <SidebarSectionRow
        icon={Folder}
        label="项目"
        collapsed={projectsCollapsed}
        onToggle={() =>
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
        actions={
          <>
            {/* 结构对齐 SidebarAssistant 的「新建会话 +」：外层已经是 <button>，
                内层再用真 <button> 是非法嵌套，所以用 div role="button"；
                点击必须 stopPropagation，否则会连带把整行折叠掉。
                图标用 `!h-3.5 !w-3.5`（带 !）—— Button 基础类里的 `[&_svg]:size-4`
                是后代选择器，特异度高于 svg 上的普通 `h-3.5`，不加 ! 会渲染成 16px。
                `group-focus-within:opacity-100` 也不能省：Tab 进动作区时 group-hover
                不触发，焦点会落在 opacity:0 的元素上。 */}
            <div
              role="button"
              tabIndex={0}
              className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-primary/20 hover:text-primary hover:ring-1 hover:ring-primary/40 group-hover:opacity-100 group-focus-within:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onCreateProject();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onCreateProject();
                }
              }}
              title="新建项目"
              aria-label="新建项目"
            >
              <FolderPlus className="!h-3.5 !w-3.5" />
            </div>
            {/* 文案硬编码中文，与紧邻的「项目」「展开 项目 / 收起 项目」一致 ——
                仓库只 bundle 了 en locale，这一区块本来就是硬编码中文。
                区块整体收起时列表被 hidden，此时按钮没有可收起的可见对象，一并藏掉。 */}
            {hasExpandedProjects && !projectsCollapsed && (
              <div
                role="button"
                tabIndex={0}
                className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-foreground/15 hover:text-foreground hover:ring-1 hover:ring-foreground/30 group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onCollapseAllProjects();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCollapseAllProjects();
                  }
                }}
                title="收起全部项目"
                aria-label="收起全部项目"
              >
                <ChevronsDownUp className="!h-3.5 !w-3.5" />
              </div>
            )}
          </>
        }
      />
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarContent.test.tsx
```

Expected: `# pass 5` / `# fail 0`

- [ ] **Step 5: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json
```

Expected: **0 errors**

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add \
  web/src/components/sidebar/view/subcomponents/SidebarContent.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarContent.test.tsx
git commit -m "feat(sidebar): move new-project into a hover action on the 项目 row"
```

---

## Task 4: 顶部按钮改「新建任务」+ 弹窗接线（原子提交）

`onCreateTask` 这个 prop 要在 `Sidebar.tsx → SidebarContent → SidebarHeader` 三层同时改名，**必须一个提交做完**，否则中间态 `tsc` 过不了。`SidebarModals` / `useSidebarController` 一并接上，保证这个提交后按钮真的能开弹窗。

**Files:**
- Modify: `web/src/components/sidebar/hooks/useSidebarController.ts:109,724,758`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarModals.tsx`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx:1,23,39,116-124,215-220`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx`（props + 转发）
- Modify: `web/src/components/sidebar/view/Sidebar.tsx`
- Modify: `web/src/i18n/locales/en/sidebar.json:40`
- Test: `web/src/components/sidebar/view/subcomponents/SidebarHeader.test.tsx`
- Test: `web/src/components/sidebar/view/subcomponents/SidebarContent.test.tsx`（补 `onCreateTask`）

- [ ] **Step 1: 写失败测试**

创建 `web/src/components/sidebar/view/subcomponents/SidebarHeader.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarHeader from './SidebarHeader';

const noop = () => {};
// 直接把 key 回显出来，断言就不依赖 en locale 的具体措辞。
const t = ((k: string) => k) as never;

const render = (isMobile: boolean) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SidebarHeader
        isPWA={false}
        isMobile={isMobile}
        isLoading={false}
        projectsCount={1}
        runningSessionsCount={0}
        searchFilter=""
        onSearchFilterChange={noop}
        onClearSearchFilter={noop}
        onRefresh={noop}
        isRefreshing={false}
        onCreateTask={noop}
        onCollapseSidebar={noop}
        t={t}
      />
    </MemoryRouter>,
  );

test('桌面顶部按钮指向「新建任务」', () => {
  const html = render(false);
  assert.ok(html.includes('tooltips.createTask'));
  assert.ok(!html.includes('tooltips.createProject'));
});

test('移动端顶部按钮也指向「新建任务」', () => {
  const html = render(true);
  assert.ok(html.includes('tooltips.createTask'));
  assert.ok(!html.includes('tooltips.createProject'));
});

test('顶部按钮不再出现 FolderPlus 图标', () => {
  // FolderPlus 留给「项目」行的新建项目按钮。
  assert.ok(!render(false).includes('lucide-folder-plus'));
  assert.ok(!render(true).includes('lucide-folder-plus'));
});
```

并在 `SidebarContent.test.tsx` 的 `<SidebarContent ...>` props 里，`onCreateProject={noop}` 下面加一行：

```tsx
        onCreateTask={noop}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarHeader.test.tsx
```

Expected: FAIL —— 现在渲染的是 `tooltips.createProject`，且移动端有 `lucide-folder-plus`。

- [ ] **Step 3: `useSidebarController.ts` 加 state**

第 109 行 `const [showNewProject, setShowNewProject] = useState(false);` 下面加：

```ts
  const [showNewTask, setShowNewTask] = useState(false);
```

return 对象里 `showNewProject,` 下面加 `showNewTask,`；`setShowNewProject,` 下面加 `setShowNewTask,`。

- [ ] **Step 4: `SidebarModals.tsx` 挂弹窗**

**4a.** import：

```tsx
import ProjectCreationWizard from '../../../project-creation-wizard';
import { CreateTaskDialog } from '../../../tasks/CreateTaskDialog';
import type { Project, Task } from '../../../../types/app';
```

（原来那行是 `import type { Project } from '../../../../types/app';`，加上 `Task`。）

**4b.** props 类型里、`onProjectCreated` 下面加：

```tsx
  showNewTask: boolean;
  onCloseNewTask: () => void;
  onTaskCreated: (task: Task) => void;
```

**4c.** 函数签名解构里加 `showNewTask, onCloseNewTask, onTaskCreated,`。

**4d.** 在 `{showNewProject && ReactDOM.createPortal(...)}` 之后插入：

```tsx
      {/* 与 TaskBoard 同款常挂用法：`CreateTaskDialog` 的 `open` prop 驱动它自己的
          `useProviderModels` 与表单重置，也驱动 `Dialog` 的焦点还原 —— 条件挂载会
          让这三者全部失效（实测关闭后焦点掉到 body）。代价是侧栏挂载时多打一次
          /api/projects；侧栏只在 / 、/session/:id 、/inbox 挂载，且这几个路由之间
          切换不会重挂，可以忽略。 */}
      <CreateTaskDialog open={showNewTask} onClose={onCloseNewTask} onCreated={onTaskCreated} />
```

- [ ] **Step 5: `SidebarHeader.tsx` 改名**

**5a.** 第 1 行 lucide import 去掉 `FolderPlus`：

```tsx
import { BarChart3, ClipboardList, Plus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
```

**5b.** props 类型第 23 行 `onCreateProject: () => void;` → `onCreateTask: () => void;`

**5c.** 函数签名解构第 39 行 `onCreateProject,` → `onCreateTask,`

**5d.** 桌面按钮（第 116-124 行）—— 图标仍是 `Plus`，只改 handler 与 tooltip：

```tsx
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onCreateTask}
              title={t('tooltips.createTask')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
```

**5e.** 移动端按钮（第 215-220 行）—— 图标 `FolderPlus` → `Plus`，并补上此前缺失的 `title` / `aria-label`：

```tsx
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateTask}
              title={t('tooltips.createTask')}
              aria-label={t('tooltips.createTask')}
            >
              <Plus className="h-4 w-4" />
            </button>
```

- [ ] **Step 6: `SidebarContent.tsx` 加并转发 `onCreateTask`**

**6a.** props 类型里 `onCreateProject: () => void;` 下面加：

```tsx
  /** 侧栏顶部的「新建任务」入口：就地打开新建任务弹窗。 */
  onCreateTask: () => void;
```

**6b.** 函数签名解构里 `onCreateProject,` 后面加 `onCreateTask,`

**6c.** 第 149 行 `onCreateProject={onCreateProject}` 改成 `onCreateTask={onCreateTask}`

- [ ] **Step 7: `Sidebar.tsx` 接线**

**7a.** 第 1 行下面加 `useNavigate` import：

```tsx
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
```

**7b.** 在 `const { t } = useTranslation(['sidebar', 'common']);` 之后加：

```tsx
  const navigate = useNavigate();
```

**7c.** controller 解构里 `showNewProject,` 后面加 `showNewTask,`；`setShowNewProject,` 后面加 `setShowNewTask,`。

**7d.** `SidebarModals` 的 props 里，`onProjectCreated={handleProjectCreated}` 之后加：

```tsx
        showNewTask={showNewTask}
        onCloseNewTask={() => setShowNewTask(false)}
        onTaskCreated={(task) => {
          setShowNewTask(false);
          // 带上 task_id，让 /tasks 那边能认出「刚建的是哪一条」——被用户存下的
          // 筛选藏住时，TaskBoard 会用它点亮既有的提示条。
          navigate('/tasks', { state: { createdTaskId: task.task_id } });
        }}
```

**7e.** `SidebarContent` 的 props 里，`onCreateProject={() => setShowNewProject(true)}` 后面加：

```tsx
            onCreateTask={() => setShowNewTask(true)}
```

- [ ] **Step 8: i18n**

`web/src/i18n/locales/en/sidebar.json` 第 40 行 `"createProject": "Create new project",` 下面加一行：

```json
    "createTask": "Create new task",
```

- [ ] **Step 9: 跑测试 + typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/sidebar/view/subcomponents/SidebarHeader.test.tsx \
  src/components/sidebar/view/subcomponents/SidebarContent.test.tsx
npx tsc --noEmit -p tsconfig.json
```

Expected: 两个测试文件全绿（Header `# pass 3`、Content `# pass 5`）；typecheck **0 errors**

- [ ] **Step 10: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add \
  web/src/components/sidebar/hooks/useSidebarController.ts \
  web/src/components/sidebar/view/subcomponents/SidebarModals.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarHeader.test.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarContent.tsx \
  web/src/components/sidebar/view/subcomponents/SidebarContent.test.tsx \
  web/src/components/sidebar/view/Sidebar.tsx \
  web/src/i18n/locales/en/sidebar.json
git commit -m "feat(sidebar): point the top button at new-task and open it in place"
```

---

## Task 5: `TaskBoard` 认领 `createdTaskId`

**Files:**
- Create: `web/src/components/tasks/createdTaskHandoff.ts`
- Test: `web/src/components/tasks/createdTaskHandoff.test.ts`
- Modify: `web/src/components/tasks/TaskBoard.tsx`
- Modify: `web/src/components/sidebar/view/Sidebar.tsx`（写侧换成 `createdTaskNavState`）

- [ ] **Step 1: 写失败测试**

创建 `web/src/components/tasks/createdTaskHandoff.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { createdTaskNavState, readCreatedTaskId } from './createdTaskHandoff';

test('读出 createdTaskId', () => {
  assert.equal(readCreatedTaskId({ createdTaskId: 't1' }), 't1');
});

test('多余的字段不影响', () => {
  assert.equal(readCreatedTaskId({ createdTaskId: 't1', other: 1 }), 't1');
});

test('null / undefined / 非对象一律当没有', () => {
  assert.equal(readCreatedTaskId(null), null);
  assert.equal(readCreatedTaskId(undefined), null);
  assert.equal(readCreatedTaskId('t1'), null);
  assert.equal(readCreatedTaskId(42), null);
  assert.equal(readCreatedTaskId([]), null);
});

test('空串与非字符串的 createdTaskId 当没有', () => {
  assert.equal(readCreatedTaskId({ createdTaskId: '' }), null);
  assert.equal(readCreatedTaskId({ createdTaskId: 7 }), null);
  assert.equal(readCreatedTaskId({ createdTaskId: null }), null);
  assert.equal(readCreatedTaskId({}), null);
});

test('写出来的 state 能被读回来（导航契约两端同时钉住）', () => {
  // 读写两侧在同一个模块里，改 key 名字会同时挂掉这两条 —— 否则 Sidebar.tsx
  // 改个字段名、TaskBoard 静默读不到，正是这条链路最容易悄悄坏的方式。
  assert.equal(readCreatedTaskId(createdTaskNavState('t9')), 't9');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/createdTaskHandoff.test.ts
```

Expected: FAIL — `Cannot find module './createdTaskHandoff'`

- [ ] **Step 3: 实现**

创建 `web/src/components/tasks/createdTaskHandoff.ts`：

```ts
/**
 * 侧栏「新建任务」跳 `/tasks` 时携带的 navigation state。
 *
 * 读写两侧放在同一个模块里，是为了让「字段名」这份契约只有一个来源 ——
 * 写侧在 `Sidebar.tsx`，读侧在 `TaskBoard.tsx`，两边隔着一个路由，
 * 改坏了不会有编译错误。
 */
export function createdTaskNavState(taskId: string): { createdTaskId: string } {
  return { createdTaskId: taskId };
}

/**
 * 从 `/tasks` 的 `location.state` 里读出侧栏「新建任务」带过来的 task_id。
 *
 * URL state 是外部输入 —— 用户可以直接改历史记录，别的入口也能往这里塞东西 ——
 * 所以只认这一种 shape，其余一律当没有。
 */
export function readCreatedTaskId(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const id = (state as { createdTaskId?: unknown }).createdTaskId;
  return typeof id === 'string' && id !== '' ? id : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/createdTaskHandoff.test.ts
```

Expected: `# pass 5` / `# fail 0`

- [ ] **Step 5: 接进 `TaskBoard.tsx`**

**5a.** 第 2 行改成：

```tsx
import { useLocation, useNavigate } from 'react-router-dom';
```

**5b.** 在 `import { CreateTaskDialog } from './CreateTaskDialog';` 下面加：

```tsx
import { readCreatedTaskId } from './createdTaskHandoff';
```

**5b-2.** 回到 `web/src/components/sidebar/view/Sidebar.tsx`，把写侧也换成同一个模块的 helper，让「字段名」这份契约只有一处来源：

```tsx
import { createdTaskNavState } from '../../tasks/createdTaskHandoff';
```

（放在 `import type { MCPServerStatus, SidebarProps } from '../types/types';` 之后的本地 import 组里。）

并把 `onTaskCreated` 里的 `navigate` 改成：

```tsx
          navigate('/tasks', { state: createdTaskNavState(task.task_id) });
```

**5c.** `const navigate = useNavigate();` 下面加：

```tsx
  const location = useLocation();
```

**5d.** 在 `const [hiddenCreated, setHiddenCreated] = useState<Task | null>(null);` 下面加：

```tsx
  // 侧栏「新建任务」跳进来时带过来的 task_id。等任务列表到齐后认领一次，
  // 再清掉 URL state，免得浏览器前进/后退把它重放成又一次提示。
  const [pendingCreatedId, setPendingCreatedId] = useState<string | null>(() =>
    readCreatedTaskId(location.state),
  );

  useEffect(() => {
    if (!pendingCreatedId || loading) return;
    const task = tasks.find((t) => t.task_id === pendingCreatedId);
    setPendingCreatedId(null);
    // 无条件记下：显不显示提示条交给既有的 `filterStillHidesNewTask` 判断
    // （`hiddenCreated` 只是「刚建的任务」标记，不是「被藏住的任务」标记）。
    // 不在这里调 `isHiddenByFilters` —— 它是每次渲染重建的闭包，塞进依赖会死循环。
    if (task) setHiddenCreated(task);
    navigate(location.pathname, { replace: true, state: null });
  }, [pendingCreatedId, loading, tasks, navigate, location.pathname]);
```

- [ ] **Step 6: typecheck + lint**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json && npx eslint src/components/tasks/TaskBoard.tsx src/components/tasks/createdTaskHandoff.ts
```

Expected: typecheck **0 errors**；eslint 无 **error**

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add \
  web/src/components/tasks/createdTaskHandoff.ts \
  web/src/components/tasks/createdTaskHandoff.test.ts \
  web/src/components/tasks/TaskBoard.tsx \
  web/src/components/sidebar/view/Sidebar.tsx
git commit -m "feat(tasks): surface a sidebar-created task hidden by the current filter"
```

---

## Task 6: 验收

- [ ] **Step 1: 全量 web 测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/sidebar/view/subcomponents/SidebarSectionRow.test.tsx \
  src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx \
  src/components/sidebar/view/subcomponents/SidebarContent.test.tsx \
  src/components/sidebar/view/subcomponents/SidebarHeader.test.tsx \
  src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx \
  src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx \
  src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx \
  src/components/tasks/createdTaskHandoff.test.ts \
  src/components/tasks/CreateTaskDialog.test.tsx
```

Expected: 全绿，`# fail 0`

- [ ] **Step 2: typecheck / lint 对比基线**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
npx eslint src/ 2>&1 | tail -3
```

Expected: typecheck `0`（基线 0）；eslint **0 errors**，warning 数 **≤ 227**（基线 227）

- [ ] **Step 3: 浏览器 E2E**

dev server 已在 `:5188`（→ 后端 `:3188`）。用 `/tmp/node_modules` 里的 `puppeteer-core` + 缓存 chromium。

必须**逐个用计算样式 + 元素紧裁切取证**，不要拿整页截图当验收证据（整页截图的图像判读会编造内容）。

1. **「项目」行 hover 出 `+`**：视口高 ≥ 1400（矮视口下项目行会被挤到 ~16px，鼠标点击会落到别处）。
   - 未 hover 时断言 `getComputedStyle(document.querySelector('[title="新建项目"]')).opacity === '0'`
   - 对整行 `hover()` 后断言 `opacity === '1'`
   - 点它 → 断言新建项目向导的 DOM 出现
2. **顶部 `+` → 新建任务**：点 `[title="Create new task"]`
   - 断言弹窗「新建任务」出现
   - textarea 填一句需求 → 点 `[aria-label="创建任务"]`
   - 断言 URL 变成 `/tasks` 且看板里出现该任务标题
3. **箭头在右**：读 `>项目</span>` 与 `.lucide-chevron-down` 的 `getBoundingClientRect().x`，断言 chevron 的 x 明显更大。
4. **触屏常显**：用 CDP `Emulation.setEmulatedMedia` 模拟 `hover:none, pointer:coarse`，断言 `[title="新建项目"]` 的 opacity 为 `1`。

- [ ] **Step 4: 汇报**

如实说明：哪些断言实际跑过、哪些没跑（例如触屏模拟没做就说没做），以及工作区是否干净。

---

## 自检记录

- **Spec 覆盖**：§2.1→Task 1；§2.2→Task 3；§2.3→Task 2；§2.4→Task 4 Step 5/8；§2.5→Task 4 Step 3/4/7；§2.6→Task 5；§4 测试→Task 1/2/3/4/5；§5 验收→Task 6。§6「不做」无对应任务（正确）。
- **命名一致性**：`SidebarSectionRow`（组件）、`showNewTask`/`setShowNewTask`（controller）、`onCreateTask`（Sidebar.tsx→SidebarContent→SidebarHeader 三层同名的 prop）、`onCreateProject`（保留原名，语义收窄为「项目行按钮」）、`onTaskCreated`/`onCloseNewTask`（SidebarModals prop）、`readCreatedTaskId`（工具函数）、`pendingCreatedId`/`setPendingCreatedId`（TaskBoard state）—— 全计划一致。
- **编译绿性**：Task 3 结束时顶部按钮仍走 `onCreateProject`（未改名），Task 4 一次性把 `onCreateTask` 贯穿三层，每个提交后 `tsc` 均为 0 error。
- **无占位符**：每个代码步骤都给了完整代码与确切命令。
- **已知取舍**：Task 4 是纯接线 + 改名，无独立单测，由 Task 6 的 E2E 覆盖；「收起全部项目」由常显改 hover 显形（spec §2.2 已说明并经用户确认）。
- **Task 1 code review 后的修订**（2026-09-22，提交 `adccaa5` 之后）：
  1. **Task 3 的图标尺寸改对了。** 原稿写 `<FolderPlus className="h-3.5 w-3.5" />`，但 `Button` 基础类含 `[&_svg]:size-4`（后代选择器，特异度 (0,1,1)），会盖掉 svg 上的 `.h-3\.5` (0,1,0)。已用 puppeteer 实测确认：侧栏顶部在 `Button` 内的 `ClipboardList h-3.5 w-3.5` 计算宽度是 **16px**，而在 `Input` 内的 `Search h-3.5 w-3.5` 是 14px。已改为 `!h-3.5 !w-3.5`（仓库既有先例：`SidebarAssistant.tsx:460` 的 `!h-5 !w-5`），并补了一条 SSR 断言兜住。
  2. **动作按钮补 `group-focus-within:opacity-100`。** 否则键盘 Tab 进动作区时焦点落在 `opacity: 0` 的元素上，既看不见按钮也看不见焦点（`touch:` 只覆盖粗指针，不覆盖键盘）。
  3. **Task 2 改用 `className` 透传**（原稿是外层再包一个 div 持有 `border-t`）。与 spec §2.3 一致，少一层 div，且让 `className` 这个 prop 真的有消费者。
  4. **`SidebarSectionRow` 的 `aria-expanded`**：折叠控件，展开态此前在 DOM 里完全不可见。已在 Task 1 的修复提交里加上。
  5. **未修的已知问题（有意保留）**：行外层是真 `<button>`，内层动作是 `div role="button"` —— 严格说属非法嵌套，内层 `aria-label` 会被并进外层按钮的可访问名。这是仓库既有模式（`SidebarAssistant.tsx:442-481` 就是这么写的），改成合法结构要重排整行并多出一次 Tab 停靠点，收益不抵改动风险。三个既有行同样如此，属既有技术债，不在本次范围。re-review 也认可保留。
  6. **`group-focus-within:opacity-100` 的隐形依赖**（`38b7816` re-review 发现）：Tailwind 3 的扫描器是按原始字节正则扫文件、**不剥注释**，所以这个工具类在 Task 3 落地前，是靠在 `SidebarSectionRow.tsx` 的 JSDoc 里出现才被生成进 bundle 的。Task 3 的动作按钮是它第一个真实消费者；Task 3 的测试已加断言钉住，避免注释被改写后工具类静默消失。
