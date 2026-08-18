# Lovdex 最近任务 — 侧边栏最近活跃会话区块 设计

- 日期：2026-08-18
- 状态：设计已评审
- 范围：纯前端（web/），无后端改动

## 1. 背景与目标

用户希望快速恢复最近活跃的会话：在侧边栏新增一个「最近任务」区块，展示最近活跃的 session
（实际即引用会话，用户原话"其实是最近活跃的 session"），最多 10 个，点击直接打开该会话继续对话。

侧边栏现有分区顺序（用户确认的结构）：

```
标题栏（SidebarHeader）→ 搜索（Header 内）
→ Lovdex助手（SidebarAssistant）
→ 定时任务（SidebarScheduledEntry）
→ Project（SidebarProjectList，滚动区）
→ 最近任务（本设计新增）
→ 设置（SidebarFooter）
```

## 2. 关键设计决策

| 决策点 | 结论 |
|---|---|
| 数据来源 | **纯前端派生**：从 Sidebar 已有的 `projects` prop 打平（`projects.flatMap(p => p.sessions)`），按会话最近活跃时间倒序，取前 10。**不加后端端点** |
| 涵盖范围 | 全部会话（含 Lovdex助手 `is_operator` 会话）——不排除 operator 工作区项目 |
| 排序依据 | `getSessionDate(session)`（现有工具，基于 `lastActivity`= `updated_at ?? created_at`）倒序 |
| 放置位置 | `SidebarContent` 的 `ScrollArea`（项目列表）之后、`SidebarFooter` 之前 —— 固定区块，始终可见 |
| 点击行为 | 打开该会话对话（跳转 `/session/:sessionId`），复用搜索点击的同一条导航链路 |
| 折叠态 | icon 模式（`SidebarCollapsed`）不显示；移动端抽屉共用同一组件 |
| 文案语言 | 沿用区域惯例：硬编码中文标题「最近任务」，不走 i18n |
| 实时性 | 不新增订阅：`session_upserted` WS 事件已由 `useProjectsState` 逐条更新 `projects`，派生 `useMemo` 自动跟随 |

## 3. 数据方案详述

### 3.1 为什么纯前端已足够

- `/api/projects` 每项目默认按活跃倒序返回 `sessionsLimit=20` 条会话（`getSessionsByProjectPathPage`
  的 `COALESCE(updated_at,created_at) DESC` 排序）。
- 全局 Top-10 必然落在"各项目已加载的 Top-N（N≥10）"并集内：任意单项目对全局 Top-10 的贡献至多
  是该项目的 Top-10，而每项目已加载 Top-20 ⊇ Top-10。**数据完备，无需后端端点。**

### 3.2 派生逻辑（组件内 `useMemo`）

```ts
const recent = useMemo(
  () =>
    projects
      .flatMap((project) => (project.sessions ?? []).map((session) => ({ session, project })))
      .sort(
        (a, b) =>
          getSessionDate(b.session).getTime() - getSessionDate(a.session).getTime(),
      )
      .slice(0, 10),
  [projects],
);
```

- 不复用 `excludeHiddenProjects`：用户要求包含助手会话，operator 工作区项目需保留。
- 已加载会话均非归档（后端已过滤），无需额外过滤。

## 4. 组件与 UI

### 4.1 新增组件 `SidebarRecentSessions.tsx`

路径：`web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.tsx`

Props：

```ts
type SidebarRecentSessionsProps = {
  projects: Project[];
  /** 点击某条最近会话：打开该会话对话（父级负责导航）。 */
  onRecentSessionSelect: (session: ProjectSession, project: Project) => void;
};
```

### 4.2 UI 结构（样式对齐 `SidebarScheduledEntry` / `SidebarAssistant`）

- **标题行**：图标（`History` 或 `Clock`）+ 文字「最近任务」+ 折叠箭头；点击切换展开/收起，
  默认展开，本地 `useState` 不持久化。
- **列表**（展开时）：
  - 内部 `max-h-[28vh] overflow-y-auto`（对齐 `SidebarAssistant` 会话列表）。
  - 每行（button，`hover:bg-muted` 对齐会话行）：
    - 第一行：会话名（`resolveSessionTitle` 优先级：`custom_name → summary → name → title`，
      无则回退占位）+ 非 claude provider 徽章（复用搜索结果的徽章样式）。
    - 第二行：项目名（`project.displayName || project.projectId`）+ 相对时间
      （compact 格式 `<1m / Xm / Xhr / Xd`，与 `SidebarSessionItem` 的 `formatCompactSessionAge` 一致）。
  - **空态**：无数据时显示「暂无最近任务」。
- 相对时间刷新：组件内 `currentTime` state + 30s `setInterval`（自包含，不依赖父级 timer）。

### 4.3 接线改动

- `SidebarContent.tsx`：在 `SidebarProjectList` 的 `ScrollArea` 之后、`SidebarFooter` 之前渲染
  `<SidebarRecentSessions projects={projects} onRecentSessionSelect={...} />`；props 类型新增
  `onRecentSessionSelect`。
- `Sidebar.tsx`：实现回调，复用搜索点击的导航链路：

```ts
onRecentSessionSelect={(session, project) => {
  handleProjectSelect(project);
  handleSessionClick(session, project.projectId);
}}
```

  其中 `handleProjectSelect` / `handleSessionClick` 来自 `useSidebarController`（现有
  `selectProjectSession` 即此模式）。会话带 `__projectId`/`__provider` 元数据由 controller 处理。

## 5. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 会话无 summary/name（新会话空标题） | 显示占位文案（`t('projects.newSession')` 或「新建会话」），可用时供点击恢复 |
| `lastActivity` 缺失/非法 | `getSessionDate` 回退 `created_at`，再空则 `getSessionTime` 为空 → 相对时间显示空字符串 |
| 会话所属项目已归档/删除 | 项目档从 `/api/projects` 消失，列表自然移除 |
| 折叠态侧边栏 | 不渲染该区块（`isSidebarCollapsed` 分支走 `SidebarCollapsed`，天然不进入） |
| 最新会话超过 10 个 | 只取前 10，标题行可加数量视需要（不必须） |

## 6. 测试

新增 `web/src/components/sidebar/view/subcomponents/SidebarRecentSessions.test.tsx`（参照
`SidebarAssistant.test.tsx` 的测试模式，`vitest` + `RTL`）：

1. **排序取前 10**：构造多项目多会话，mock `projects`，断言只渲染 10 条且按活跃倒序。
2. **含助手会话**：包含 operator 工作区项目及其会话，断言仍出现在列表。
3. **空态**：`projects` 无会话时显示「暂无最近任务」。
4. **点击回调**：点击某行，断言 `onRecentSessionSelect(session, project)` 参数正确。
5. **折叠**：点击标题行收起后列表隐藏，再点展开恢复。

## 7. 范围外（不做）

- 后端新增"最近会话"端点（数据已足够，YAGNI）。
- 区块内会话的删除/重命名操作（所属项目会话列表已有这些能力，此处只做入口）。
- 「最近任务」与 `tasks` 表的正式任务关联展示（用户明确：即最近活跃的 session）。
- 空态主页 `MainContentStateView` 上的改动。