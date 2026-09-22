# 侧栏新建任务入口 + 区块行风格统一 设计

日期：2026-09-22
状态：已确认，待写实现计划

## 0. 背景与目标

侧栏顶部那个 `+` 按钮（桌面 `Plus` / 移动 `FolderPlus`，tooltip `Create new project`）现在打开的是「新建项目」向导。用户要的是：**这个位置改成「新建任务」**，建完自动跳到任务面板。

新建项目的能力不能丢，改挂到「项目」区块行上 —— **鼠标移上去才出现的 `+` 号**。

顺带统一侧栏区块行的视觉：现在「项目」「最近会话」的折叠箭头在**左边**，而「Lovdex助手」「定时任务」「收件箱」在**右边**（且带 `bg-primary/5` 淡紫底）。用户要求后两者向前者看齐。

## 1. 目标状态

侧栏五类区块行统一为「Lovdex助手风格」：

```
┌─────────────────────────────────────────┐
│  🗨  Lovdex助手              [+] [⚙]  ⌄  │   ← 动作 hover 才显形
│  📅  定时任务                         ⌄  │
│  📥  收件箱                           ⌄  │
│  📁  项目               [📁+] [⇕]     ⌄  │   ← 本次改造
│  🕘  最近会话                         ⌄  │   ← 本次改造
└─────────────────────────────────────────┘
```

统一的四条：图标+标题在左（`text-primary` + `font-semibold`）、动作区在右且 `opacity-0 group-hover:opacity-100`、**箭头永远在最右**、行底色 `bg-primary/5`。

## 2. 改动点

### 2.1 新增 `SidebarSectionRow.tsx`（共用行组件）

「项目」和「最近会话」改造后结构完全一致，抽组件而不是抄两遍。

```tsx
// web/src/components/sidebar/view/subcomponents/SidebarSectionRow.tsx
type SidebarSectionRowProps = {
  icon: ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /** hover 才显形的右侧动作区。每个动作自带 `opacity-0 group-hover:opacity-100 touch:opacity-100`。 */
  actions?: ReactNode;
  /** 挂在最外层 wrapper 上，用于加分隔线等（tailwind-merge 会正确覆盖）。 */
  className?: string;
};
```

结构照抄 `SidebarAssistant.tsx:426-484` 的桌面行：

```tsx
<div className={cn('group flex-shrink-0 px-2 pt-1.5 md:px-1.5', className)}>
  <Button
    variant="ghost"
    className="flex h-auto w-full justify-between bg-primary/5 p-2 font-normal hover:bg-muted"
    onClick={onToggle}
    title={`${collapsed ? '展开' : '收起'} ${label}`}
  >
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <Icon className="h-4 w-4 flex-shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">{label}</span>
    </div>
    <div className="flex flex-shrink-0 items-center gap-1">
      {actions}
      {collapsed ? <ChevronRight className="…" /> : <ChevronDown className="…" />}
    </div>
  </Button>
</div>
```

`touch:opacity-100` 是仓库现成的变体（`src/index.css:722`，`@media (hover:none) and (pointer:coarse)` 下强制 `opacity:1`）。靠它**一份 markup 同时管桌面和触屏**，不必像 Lovdex助手 那样拆 `md:` 两套。

> **范围外**：不把 `SidebarAssistant` 重写到这个组件上。它是本风格的参照物，且有移动/桌面分叉和会话列表逻辑，改动风险大于收益。

### 2.2 「项目」行（`SidebarContent.tsx:159-198`）

```tsx
<SidebarSectionRow
  icon={Folder}
  label="项目"
  collapsed={projectsCollapsed}
  onToggle={toggleProjectsCollapsed}
  actions={<>
    {/* 结构照抄 SidebarAssistant.tsx:442-461 的「新建会话 +」 */}
    <div
      role="button" tabIndex={0}
      className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-primary/20 hover:text-primary hover:ring-1 hover:ring-primary/40 group-focus-within:opacity-100 group-hover:opacity-100"
      onClick={(e) => { e.stopPropagation(); onCreateProject(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onCreateProject(); } }}
      title="新建项目" aria-label="新建项目"
    >
      <FolderPlus className="!h-3.5 !w-3.5" />
    </div>
    {hasExpandedProjects && !projectsCollapsed && (
      /* 同款结构，图标 ChevronsDownUp，title/aria-label「收起全部项目」，onClick → onCollapseAllProjects */
    )}
  </>}
/>
```

关于那两个 class：

- **`!h-3.5 !w-3.5` 的 `!` 不能省。** 动作按钮渲染在行组件的 `<Button>` 内部，而 `Button` 基础类含 `[&_svg]:size-4`（后代选择器，特异度 (0,1,1)），会盖掉 svg 上的普通 `.h-3\.5` (0,1,0)。已实测确认：侧栏顶部在 `Button` 内的 `ClipboardList h-3.5 w-3.5` 计算宽度是 **16px**，而在 `Input` 内的 `Search h-3.5 w-3.5` 是 14px。仓库既有先例：`SidebarAssistant.tsx:460` 的 `!h-5 !w-5`。
  **尺寸取 14px（不是 `SidebarAssistant` 那个 `+` 的 20px）**，为的是保住「收起全部项目」原来的 14px 观感；同一行里两个动作图标尺寸一致。代价是与 Lovdex助手 行的 `+`（20px）不同尺寸。
- **`group-focus-within:opacity-100` 也不能省。** 键盘 Tab 进动作区时 `group-hover:` 不触发，焦点会落在 `opacity: 0` 的元素上，用户既看不见按钮也看不见焦点。`touch:` 只覆盖粗指针，不覆盖键盘。

（上面是内联 markup，不抽新的按钮组件 —— 全仓库这种行内动作按钮都是就地写的，抽出来反而多一层跳转。）

- `+` 用 **`FolderPlus`**（用户指定），与「新建任务」的 `Plus` 区分开。
- 「收起全部项目」的**显示条件不变**（`hasExpandedProjects && !projectsCollapsed`），但**由常显改为 hover 显形** —— 这是"统一风格"的直接后果，属于有意为之。
- 折叠开关从行内 `<button>` 换成 `onToggle` 回调（含 localStorage 持久化，逻辑不变）。
- 外层 wrapper 从 `flex items-center gap-1 px-2 pt-1.5 md:px-1.5` 收敛成组件内统一的 `flex-shrink-0 px-2 pt-1.5 md:px-1.5` —— 动作按钮搬进行内部了。
- `onCreateProject` 不再往 `SidebarHeader` 转发，改由本组件消费。

动作按钮用 `div role="button" tabIndex={0}` + `onKeyDown`，**照抄 `SidebarAssistant.tsx:442-481`**：外层已经是 `<button>`，内层再嵌真 `<button>` 是非法 HTML；且内层点击必须 `stopPropagation`，否则会连带触发整行折叠。

### 2.3 「最近会话」行（`SidebarRecentSessions.tsx:45-68`）

同一个组件，`icon={History}`、`label="最近会话"`、**无 `actions`**：

```tsx
<SidebarSectionRow
  icon={History}
  label="最近会话"
  collapsed={collapsed}
  onToggle={toggleCollapsed}
  className="border-t border-border/60 pb-2"
/>
```

现有的 `border-t border-border/60 pb-2`（滚动区与「最近会话」之间的分隔）通过 `className` 保留 —— 那是区块间距，不属于行样式。

### 2.4 侧栏顶部按钮 → 「新建任务」

`SidebarHeader.tsx`：

| | 现在 | 改后 |
|---|---|---|
| 桌面 (116-124) | `Plus`，ghost 弱化，`onCreateProject` | `Plus`，**样式不变**，`onCreateTask`，`title={t('tooltips.createTask')}` |
| 移动 (215-220) | `FolderPlus`，`bg-primary/90` 高亮，`onCreateProject` | **`Plus`**，高亮样式保留，`onCreateTask` |

移动端图标换成 `Plus`：`FolderPlus` 语义是"新建文件夹/项目"，留给 2.2 那个按钮。

i18n 新增 `sidebar.tooltips.createTask` = `"Create new task"`（`web/src/i18n/locales/en/sidebar.json`），与相邻的 `tasks` / `stats` 一致走 i18n。`tooltips.createProject` 保留 key 不删（改完后它不再有消费者，但删 key 属于无关 diff）。

> 「项目」行内的两个按钮**硬编码中文**（`新建项目` / `收起全部项目`），与紧邻的 `项目` / `展开 项目` 一致 —— 该区块本来就是硬编码中文（仓库只 bundle 了 en locale）。

### 2.5 就地弹窗 → 建完跳转

- `useSidebarController.ts` 加一份 `showNewTask` state（第 109 行 `showNewProject` 旁），并在 return 里导出。
- `CreateTaskDialog` 挂在 `SidebarModals.tsx`，与 `ProjectCreationWizard` 同处一个弹窗 hub：

```tsx
{showNewTask && (
  <CreateTaskDialog
    open
    onClose={onCloseNewTask}
    onCreated={onTaskCreated}
  />
)}
```

**条件渲染而非 `open={showNewTask}` 常挂**：`CreateTaskDialog` 挂载时会 `api.projects()` 拉一次项目列表（`CreateTaskDialog.tsx:101-117`）。侧栏在所有 `AppContent` 路由下常驻，常挂等于每次切路由都多打一次 `/api/projects`。

- `Sidebar.tsx` 的 `onCreated` 回调：

```tsx
onTaskCreated={(task) => {
  setShowNewTask(false);
  navigate('/tasks', { state: { createdTaskId: task.task_id } });
}}
```

任务创建时后端广播 `task_upserted`，`TaskBoard` 的 `useTasks` 订阅了它（`useTasks.ts:79-83`），落地即见。

### 2.6 跳转后的「任务被筛选藏住」兜底

从侧栏跳 `/tasks` 时 `TaskBoard` 是**全新挂载**的，不知道刚建了哪个任务。用户若存过收窄的筛选（如只看 P0），新建的默认 P2 任务会被筛掉 —— **跳过去却看不见自己刚建的东西**。

`TaskBoard` 已有现成的 `hiddenCreated` 提示条 + 「清除筛选」按钮（`TaskBoard.tsx:183, 275-281, 385-403`），只是那条路径此前只在面板内建任务时触发。补上侧栏这条入口（`TaskBoard.tsx` 需新增 `useLocation` / `useEffect` 引用）：

```tsx
// 侧栏「新建任务」跳进来时带过来的 task_id。等任务列表到齐后认领一次，
// 然后清掉 URL state，避免浏览器前进/后退把它重放成又一次提示。
const [pendingCreatedId, setPendingCreatedId] = useState<string | null>(
  () => (location.state as { createdTaskId?: string } | null)?.createdTaskId ?? null,
);

useEffect(() => {
  if (!pendingCreatedId || loading) return;
  const task = tasks.find((t) => t.task_id === pendingCreatedId);
  setPendingCreatedId(null);
  // 无条件记下：显不显示提示条交给既有的 `filterStillHidesNewTask` 判断
  // （`hiddenCreated` 本身只是「刚建的任务」标记，不是「被藏住的任务」标记）。
  if (task) setHiddenCreated(task);
  navigate(location.pathname, { replace: true, state: null });
}, [pendingCreatedId, loading, tasks, navigate, location.pathname]);
```

关键点：**不在 effect 里调 `isHiddenByFilters`**。那是个每次渲染重建的闭包（`TaskBoard.tsx:275`），塞进依赖会死循环、不塞又触发 exhaustive-deps。改成"无条件 `setHiddenCreated`"，让既有的 `filterStillHidesNewTask = hiddenCreated ? isHiddenByFilters(hiddenCreated) : false` 在渲染期决定提示条显不显示 —— 零新增 lint，逻辑不重复。

## 3. 数据流

```
SidebarHeader [+]  ──onCreateTask──▶  useSidebarController.showNewTask
                                            │
                                            ▼
                              SidebarModals → CreateTaskDialog
                                            │ onCreated(task)
                                            ▼
                    navigate('/tasks', { state: { createdTaskId } })
                                            │
                                            ▼
                    TaskBoard 挂载 → pendingCreatedId → setHiddenCreated
                                            │
                            filterStillHidesNewTask ? 提示条 : 无
```

新建项目那条路径**完全不变**，只是触发点从 header 搬到「项目」行：

```
「项目」行 [+] ──onCreateProject──▶ setShowNewProject(true) ──▶ ProjectCreationWizard
```

## 4. 测试

web 无 DOM 环境，走 `renderToStaticMarkup`（同 `SidebarInboxEntry.test.tsx`），用 `npx tsx --test <file>` 跑：

- **`SidebarSectionRow.test.tsx`**（新）
  - **箭头在标题之后**：断言 `lucide-chevron-down` 在 `>项目<` 之后出现 —— 把「箭头都在右边」这条需求钉成断言。
  - `actions` 渲染进 DOM。
  - `collapsed` 切换 chevron 图标（`chevron-right` ↔ `chevron-down`）与 `title`（`展开 X` ↔ `收起 X`）。
- **`SidebarHeader.test.tsx`**（新）：桌面/移动两个顶部按钮 `title` 指向「新建任务」（`Create new task`），且整个 markup 不含 `Create new project`。
- **`SidebarContent.test.tsx`**（新）：渲染出 `title="新建项目"` 的按钮。
- **`SidebarRecentSessions.test.tsx`**（已有）：补一条箭头在标题之后的断言。

点击行为（`+` → `onCreateProject`、整行 → `onToggle`）在 SSR 下测不了，靠 E2E 覆盖。

## 5. 验收

1. `npx tsc --noEmit -p tsconfig.json` 与 `npx eslint src/` **零新增**（基线不干净，以改动前的实测数字为准）。
2. 新增的 3 个测试文件全绿。
3. 浏览器 E2E（`puppeteer-core` 连 `:5188` live dev server）：
   - 侧栏「项目」行 hover → `+` 出现，点击 → 新建项目向导打开。
   - 侧栏顶部 `+` → 新建任务弹窗打开，填需求提交 → 落到 `/tasks` 且新任务可见。
   - 「项目」「最近会话」的 chevron 在标题右侧。
   - 用**计算样式 + 元素紧裁切**取证，不靠整页截图判读。

## 6. 不做

- 不重构 `SidebarAssistant` 到 `SidebarSectionRow`（见 2.1 范围外）。
- 不动「定时任务」「收件箱」两行（它们已经是目标风格）。
- 不动新建项目向导本身（`ProjectCreationWizard` 及其产物）。
- 不做侧栏折叠态（`SidebarCollapsed`）的新建任务入口 —— 那里现在也没有新建项目入口。
