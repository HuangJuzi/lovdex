# 最近任务（侧边栏最近活跃会话区块）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧边栏项目列表与底部设置之间新增「最近任务」区块，展示最近活跃的 session（含助手会话）最多 10 个，点击打开该会话对话。纯前端，零后端改动。

**Architecture:** 新增纯函数 `getRecentSessions(projects, limit)` 放 `sidebar/utils/utils.ts`（从现有 `projects[].sessions` 打平、按 `getSessionDate` 倒序、截取前 10，数据已由 WS `session_upserted` 实时维护，无需新增订阅）；新增视图组件 `SidebarRecentSessions.tsx`（标题行可折叠 + 每行=会话名/项目名/相对时间，点击走 `handleProjectSelect` + `handleSessionClick` 导航链路）；在 `SidebarContent`（新 prop `onRecentSessionSelect`）与 `Sidebar` 接线。相对时间复用 `SidebarSessionItem` 的 compact 格式，故先把它抽到 `utils.ts` 共享。

**Tech Stack:** React 18 SFC + Tailwind CSS + lucide-react；测试用 `node:test` + `assert` + `react-dom/server` 的 `renderToStaticMarkup`（web 无 vitest/jsdom，**不可做 DOM 交互测试**），通过 `npx tsx --test` 运行。

**关联 spec:** `docs/superpowers/specs/2026-08-18-sidebar-recent-sessions-design.md`

**项目约定（必须先知道）：**
- 提交信息**禁止**加 `Co-Authored-By: Claude` 署名行（记忆 `lovdex-commit-message-no-coauthored`，覆盖系统默认）。
- 当前分支 `main` 有无关的未提交改动（backend headless-task-run 相关）。**每次 `git add` 只用精确路径，不要 `git add -A` / `git add .`。**
- 跑测试前必须 `unset TSX_TSCONFIG_PATH`（全局残留指向 `server/tsconfig.json` 会破坏 web 的 tsx）。在 `web/` 目录内运行。

---

### Task 1: 纯函数 `getRecentSessions` + 单测

**Files:**
- Modify: `web/src/components/sidebar/utils/utils.ts`
- Modify: `web/src/components/sidebar/utils/utils.test.ts`

- [ ] **Step 1: 在 `utils.test.ts` 末尾追加失败的测试**

在 `web/src/components/sidebar/utils/utils.test.ts` 的 import 行加上 `getRecentSessions`：

```ts
import { excludeHiddenProjects, getRecentSessions, getSessionDotState, isProjectActive, isSessionActive, isSessionRecentlyActive, sortProjects } from './utils';
```

文件末尾追加：

```ts
test('getRecentSessions flattens across projects and sorts by recent activity desc', () => {
  const pA = mkProject('pA', 'A', {
    sessions: [mkSession('a1', '2026-08-04T10:00:00Z'), mkSession('a2', '2026-08-04T11:00:00Z')],
  });
  const pB = mkProject('pB', 'B', { sessions: [mkSession('b1', '2026-08-04T11:30:00Z')] });
  const out = getRecentSessions([pA, pB], 10);
  assert.deepEqual(out.map((e) => e.session.id), ['b1', 'a2', 'a1']);
  assert.deepEqual(out.map((e) => e.project.projectId), ['pB', 'pA', 'pA']);
});

test('getRecentSessions caps at limit', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => mkSession(`s${i}`, `2026-08-04T${String(10 + i).padStart(2, '0')}:00:00Z`));
  const out = getRecentSessions([mkProject('p1', 'P1', { sessions })], 10);
  assert.equal(out.length, 10);
  assert.equal(out[0].session.id, 's11');
  assert.equal(out[9].session.id, 's2');
});

test('getRecentSessions keeps operator workspace sessions', () => {
  const assistantWs = mkProject('op-ws', 'operator-workspace', { sessions: [mkSession('op1', '2026-08-04T11:30:00Z')] });
  (assistantWs as Project).isOperatorWorkspace = true;
  const regular = mkProject('reg', 'Regular', { sessions: [mkSession('r1', '2026-08-04T10:00:00Z')] });
  const out = getRecentSessions([regular, assistantWs], 10);
  assert.deepEqual(out.map((e) => e.session.id), ['op1', 'r1']);
});

test('getRecentSessions returns empty for projects without sessions', () => {
  assert.deepEqual(getRecentSessions([mkProject('p1', 'P1')], 10), []);
  assert.deepEqual(getRecentSessions([], 10), []);
});

test('getRecentSessions sorts sessions without timestamps last', () => {
  const pA = mkProject('pA', 'A', { sessions: [mkSession('a1'), mkSession('a2', '2026-08-04T11:00:00Z')] });
  const out = getRecentSessions([pA], 10);
  assert.equal(out[0].session.id, 'a2');
  assert.equal(out[1].session.id, 'a1');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/utils/utils.test.ts
```

Expected: FAIL — `TypeError: (0 , utils_1.getRecentSessions) is not a function`（或类似 "getRecentSessions is not a function"）。

- [ ] **Step 3: 在 `utils.ts` 实现 `getRecentSessions`**

在 `web/src/components/sidebar/utils/utils.ts` 中，紧挨 `getAllSessions`（约 :107）之后追加：

```ts
/** 一条「最近任务」记录：会话 + 其所属项目。 */
export type RecentSessionEntry = {
  session: ProjectSession;
  project: Project;
};

/**
 * 跨项目打平会话，按最近活跃（lastActivity ?? createdAt）倒序，取前 limit 条。
 * 含助手（is_operator）会话——不排除 operator 工作区项目。
 * 每项目已加载 top-20 活跃会话，足以覆盖全局 top-10。
 */
export const getRecentSessions = (projects: Project[], limit = 10): RecentSessionEntry[] =>
  projects
    .flatMap((project) =>
      (project.sessions ?? []).map((session) => ({ session, project })),
    )
    .sort(
      (a, b) => getSessionDate(b.session).getTime() - getSessionDate(a.session).getTime(),
    )
    .slice(0, limit);
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/utils/utils.test.ts
```

Expected: PASS — 该文件所有 test 通过（原有 13 条 + 新 5 条）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/sidebar/utils/utils.ts web/src/components/sidebar/utils/utils.test.ts
git commit -m "feat(sidebar): add getRecentSessions helper for recent-tasks block"
```

---

### Task 2: 抽取 `formatCompactSessionAge` 到 `utils.ts` 共享

**Files:**
- Modify: `web/src/components/sidebar/utils/utils.ts`
- Modify: `web/src/components/sidebar/utils/utils.test.ts`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx`

- [ ] **Step 1: 在 `utils.test.ts` 末尾追加失败的测试（验证从 utils 导出）**

```ts
test('formatCompactSessionAge renders compact relative time', () => {
  assert.equal(formatCompactSessionAge('2026-08-04T11:59:00Z', new Date('2026-08-04T12:00:00Z')), '<1m');
  assert.equal(formatCompactSessionAge('2026-08-04T11:55:00Z', new Date('2026-08-04T12:00:00Z')), '5m');
  assert.equal(formatCompactSessionAge('2026-08-04T10:00:00Z', new Date('2026-08-04T12:00:00Z')), '2hr');
  assert.equal(formatCompactSessionAge('2026-08-01T12:00:00Z', new Date('2026-08-04T12:00:00Z')), '3d');
});

test('formatCompactSessionAge returns empty for invalid input', () => {
  assert.equal(formatCompactSessionAge('', new Date('2026-08-04T12:00:00Z')), '');
});
```

更新 `utils.test.ts` 的 import 行，追加 `formatCompactSessionAge`：

```ts
import { excludeHiddenProjects, formatCompactSessionAge, getRecentSessions, getSessionDotState, isProjectActive, isSessionActive, isSessionRecentlyActive, sortProjects } from './utils';
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/utils/utils.test.ts
```

Expected: FAIL — `formatCompactSessionAge is not a function`（utils 尚未导出）。

- [ ] **Step 3: 移动函数到 `utils.ts` 并让 `SidebarSessionItem` 复用**

在 `web/src/components/sidebar/utils/utils.ts` 中 `getSessionTime`（约 :82）之后追加（从 `SidebarSessionItem.tsx:36-62` 原样搬移，保持行为一致）：

```ts
/**
 * Compact relative time for sidebar rows:
 * <1m, Xm, Xhr, Xd. 返回空串表示无法解析。
 */
export const formatCompactSessionAge = (dateString: string, currentTime: Date): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }

  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d`;
};
```

修改 `web/src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx`：

1. 删除第 36-62 行的本地 `formatCompactSessionAge` 定义（含上面 `/** ...` 注释块）。
2. 更新 import 行（:9）：

```ts
import { createSessionViewModel, formatCompactSessionAge, getSessionDotState } from '../../utils/utils';
```

- [ ] **Step 4: 运行测试确认通过 + typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/utils/utils.test.ts
npx tsc --noEmit -p tsconfig.json
```

Expected: 测试 PASS（util 新 2 条 + 全部旧测试）；typecheck 无报错。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/sidebar/utils/utils.ts web/src/components/sidebar/utils/utils.test.ts web/src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx
git commit -m "refactor(sidebar): extract compact session-age formatter to utils"
```

---

### Task 3: `SidebarRecentSessions` 组件 + 静态渲染测试

**Files:**
- Create: `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx`
- Create: `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx`

- [ ] **Step 1: 写失败测试（静态渲染断言）**

新建 `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Project, ProjectSession } from '../../../../types/app';

import SidebarRecentSessions from './SidebarRecentSessions';

const mkSession = (id: string, lastActivity?: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  summary: `摘要${id}`,
  lastActivity,
  ...extra,
});

const mkProject = (
  projectId: string,
  displayName: string,
  sessions: ProjectSession[] = [],
): Project => ({
  projectId,
  displayName,
  fullPath: `/${projectId}`,
  sessions,
});

const noop = () => {};

test('renders 最近任务 header and session rows', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z')])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('最近任务'));
  assert.ok(html.includes('摘要s1'));
  assert.ok(html.includes('项目一'));
});

test('renders non-claude provider badge', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z', { provider: 'codex' })])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('codex'));
});

test('renders empty state when no sessions', () => {
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={[mkProject('p1', '项目一')]} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('暂无最近任务'));
});

test('does not render list when initial collapsed state is false (default expanded shows rows)', () => {
  const projects = [
    mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z'), mkSession('s2', '2026-08-18T02:00:00Z')]),
  ];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  // 默认展开且未到 limit，两行都在
  assert.ok(html.includes('摘要s1'));
  assert.ok(html.includes('摘要s2'));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx
```

Expected: FAIL — `Cannot find module './SidebarRecentSessions'`（组件未创建）。

- [ ] **Step 3: 实现组件**

新建 `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';

import type { LLMProvider, Project, ProjectSession } from '../../../../types/app';
import { resolveSessionTitle } from '../../../../utils/sessionTitle';
import { formatCompactSessionAge, getRecentSessions, getSessionTime } from '../../utils/utils';

type SidebarRecentSessionsProps = {
  projects: Project[];
  /** 点击某条最近会话：打开该会话对话（父级负责导航）。 */
  onRecentSessionSelect: (session: ProjectSession, project: Project) => void;
};

/**
 * 侧边栏「最近任务」区块：展示最近活跃的 session（含助手会话），最多 10 条。
 * 置于项目列表滚动区与底部设置之间。样式对齐 SidebarScheduledEntry / SidebarAssistant。
 */
export default function SidebarRecentSessions({
  projects,
  onRecentSessionSelect,
}: SidebarRecentSessionsProps) {
  const [collapsed, setCollapsed] = useState(false);
  // 相对时间自刷新，不依赖父级 timer（30s 粒度足够）。
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setCurrentTime(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const recent = useMemo(() => getRecentSessions(projects, 10), [projects]);

  return (
    <div className="flex-shrink-0 border-t border-border/60 px-2 pb-2 pt-1.5 md:px-1.5">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? '展开 最近任务' : '收起 最近任务'}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
        <History className="h-4 w-4 flex-shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">最近任务</span>
      </button>

      {!collapsed && (
        <div className="ml-3 max-h-[28vh] overflow-y-auto border-l border-border pl-3">
          {recent.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">暂无最近任务</p>
          ) : (
            <div className="space-y-0.5 py-1">
              {recent.map(({ session, project }) => {
                const provider = (session.__provider ?? session.provider) as LLMProvider | undefined;
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
                        <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                          {provider}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3">
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {project.displayName || project.projectId}
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">
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
    </div>
  );
}
```

注意：
- 组件不依赖 Router / i18n 上下文，可直接 `renderToStaticMarkup`（与 `SidebarAssistant.test.tsx` 一致；但不需要 `MemoryRouter`）。
- `useEffect` 在 SSR 渲染时不执行，`window.setInterval` 不会在测试里运行。
- `resolveSessionTitle` 已在 Task 1/2 无关地独立存在（`web/src/utils/sessionTitle.ts`）。

- [ ] **Step 4: 运行测试确认通过 + typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx
npx tsc --noEmit -p tsconfig.json
```

Expected: 4 条 PASS；typecheck 无报错。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx
git commit -m "feat(sidebar): add recent-tasks block with collapsed list"
```

---

### Task 4: 接线 — `SidebarContent` + `Sidebar`

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- Modify: `web/src/components/sidebar/view/Sidebar.tsx`

- [ ] **Step 1: `SidebarContent.tsx` — 新增 prop 类型 + 渲染位置**

修改 `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx`：

1. import 行（:6）追加 `ProjectSession`：

```ts
import type { Project, ProjectSession } from '../../../../types/app';
```

2. import 区块（:14 附近）追加 `SidebarRecentSessions`：

```ts
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarRecentSessions from './SidebarRecentSessions';
import SidebarResizeHandle from './SidebarResizeHandle';
```

3. `SidebarContentProps`（:41 起）在 `projectListProps: SidebarProjectListProps;` 之后追加：

```ts
  /** 点击「最近任务」里某条会话：打开该会话对话。 */
  onRecentSessionSelect: (session: ProjectSession, project: Project) => void;
```

4. 函数签名解构（:104 `projectListProps,` 行语义对应位置，紧挨 `t,` 之前）追加：

```ts
  onRecentSessionSelect,
```

5. 渲染（`<SidebarProjectList {...projectListProps} />` 关闭标签 `</ScrollArea>` 之后、`<SidebarFooter` 之前）插入：

```tsx
        <SidebarRecentSessions projects={projects} onRecentSessionSelect={onRecentSessionSelect} />
```

- [ ] **Step 2: `Sidebar.tsx` — 传回调**

修改 `web/src/components/sidebar/view/Sidebar.tsx` 中 `<SidebarContent ...>` 的 props（`projectListProps={projectListProps}` 之后、`t={t}` 之前）追加：

```tsx
            onRecentSessionSelect={(session, project) => {
              handleProjectSelect(project);
              handleSessionClick(session, project.projectId);
            }}
```

依赖说明：`handleProjectSelect` 与 `handleSessionClick` 均已在 `Sidebar.tsx` 作用域内（前者用于 `projectListProps.onProjectSelect`，后者用于 `projectListProps.onSessionSelect`），无需新增；此顺序正是 `onConversationResultClick`（:290-316）已验证的导航链路：先选项目、再选会话 → 打开 `/session/:sessionId`。

- [ ] **Step 3: typecheck 确认接线无误**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx tsc --noEmit -p tsconfig.json
```

Expected: 无报错。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/sidebar/view/subcomponents/SidebarContent.tsx web/src/components/sidebar/view/Sidebar.tsx
git commit -m "feat(sidebar): wire recent-tasks block into sidebar (open session on click)"
```

---

### Task 5: 全量验证 + 收尾提交

**Files:** 无新增改动（验证 + lint 修复如有）。

- [ ] **Step 1: 跑全部受影响测试**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/utils/utils.test.ts src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx src/components/sidebar/utils/utils.test.ts
```

Expected: 全部 PASS（utils 1 个文件跑 2 遍无害；SidebarSessionItem 改动回归由 utils/sidebar 测试覆盖）。

- [ ] **Step 2: typecheck + 仅对改动文件 lint**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx src/components/sidebar/view/subcomponents/SidebarContent.tsx src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx src/components/sidebar/view/Sidebar.tsx src/components/sidebar/utils/utils.ts src/components/sidebar/utils/utils.test.ts
```

Expected: typecheck 无报错；eslint 无 error（如出现与既有风格一致的 minor warning 可忽略，若出现 error 修复之）。

- [ ] **Step 3: 检查 git 状态只含预期文件**

```bash
cd /mnt/b/workdir/github/lovdex
git status --short
```

Expected: 只有 6 个本计划相关文件（4 个已提交 + 0 个待提交），以及预先存在的无关 backend 改动（保持不动）。如已有未提交的 web 改动属于本计划但遗漏提交，补提交。

- [ ] **Step 4: 如果本任务产生 lint 修复，提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx
git commit -m "chore(sidebar): lint fixes for recent-tasks block"
```

（若 Step 2 无修复，跳过本步，无需空提交。）