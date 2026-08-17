# ViewSwitcher 三页统一位置 — 设计文档

> 状态：设计定稿 · 2026-08-10
> 定位：把「聊天 / 任务」切换器从侧边栏搬到一个三页共用的内容区顶栏，消除 chat 页与 task 页之间切换器「跳位闪动」的问题。

---

## 1. 背景与问题

聊天页（`/`、`/session/:id`）的 ViewSwitcher（聊天｜任务）位于**左侧边栏顶部**（logo 下方，离顶约 45px）；任务看板页（`/tasks`）**无侧边栏**，切换器直接在主内容区顶部（离顶约 12px）；任务详情页（`/task/:id`）则**完全没有**切换器。

因此在 chat ↔ task 切换时，切换器从「侧边栏内」跳到「主内容区顶」，垂直位置还不同 —— 视觉上像闪了一下。另外侧边栏**折叠后切换器完全消失**（只剩 48px 图标栏），入口不稳定。

**目标**：三个页面共用同一个 header 结构，ViewSwitcher 固定在**内容区左上**，位置、尺寸、间距完全一致；侧边栏不再承载切换器（折叠也不影响入口）。

**不做的**（刻意排除）：
- 不改切换器导航逻辑（聊天 → `/`，任务 → `/tasks`）。
- 不改任务看板/详情页的内容本身，只调整外层 header。
- 不做 i18n：切换器文案沿用现有 i18n，其余文案硬编码中文与现状一致。

---

## 2. 统一 header 规格

三页共用一个 header 视觉规格（组件各自实现，结构一致）：

```tsx
<header className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
  <ViewSwitcher active={active} className="w-40 flex-shrink-0 sm:w-44" />
  {/* 页面中间内容（chat 标题 / 看板标题 / 详情面包屑） */}
  <div className="ml-auto flex flex-shrink-0 items-center gap-2">
    {/* 页面右侧操作按钮（查看任务 / 新建任务 / 返回） */}
  </div>
</header>
```

- 切换器固定 `w-40 sm:w-44 flex-shrink-0`，三页同一组件。
- header 高度统一 `px-3 py-1.5 sm:px-4 sm:py-2` + `border-b border-border/60 bg-background`。
- chat 页保留 `pwa-header-safe`（PWA 安全区），其余两页同样加上无害。

### 右侧按钮尺寸统一

- 查看任务（chat 页）：样式保留 `border border-border/60 bg-card` + 状态点 + 文案；尺寸从 `px-2.5 py-1 text-xs` 改为 **`h-8 px-3 text-sm`**。
- 新建任务（看板页）：样式保留主色按钮；尺寸从 `Button size="sm"`（h-9）改为 **`h-8 px-3 text-sm`**。
- 两者同为 `h-8 px-3 text-sm rounded-md`，仅视觉强调不同（描边 vs 主色）。

---

## 3. 各页改动

### 3.1 侧边栏 `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarHeader.tsx`

- 删除桌面端（`md:block` 块内 `mt-2.5` 处的 `<ViewSwitcher active="chat" />`）与移动端（`md:hidden` 块内的对应处）。
- 删除 `ViewSwitcher` 的 import。
- 侧边栏头部只保留 logo、操作按钮（刷新/新建项目/折叠）、筛选、搜索。

### 3.2 Chat 页 `lovdex-cli/src/components/main-content/view/MainContent.tsx`

- 在 header 左侧 flex 容器内、`MobileMenuButton` 之后、`MainContentTitle` 之前，插入 `<ViewSwitcher active="chat" className="w-40 flex-shrink-0 sm:w-44" />`。
- 引入 `ViewSwitcher`。
- 右侧「查看任务」按钮尺寸改为 `h-8 px-3 text-sm`（其余样式不变）。

### 3.3 看板页 `lovdex-cli/src/components/tasks/TaskBoard.tsx`

- header 类名改为统一规格：`flex items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2`（原来是 `px-3 py-3 sm:px-6 sm:py-4`、无 border）。
- 切换器宽度改为 `w-40 flex-shrink-0 sm:w-44`。
- 「＋新建任务」按钮尺寸改为 `h-8 px-3 text-sm`。

### 3.4 详情页 `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- 页面最外层从 `h-dvh overflow-y-auto` 改为 `h-dvh flex flex-col`（header 固定 + 内容区滚动）。
- 新增 header（统一规格），左上 `<ViewSwitcher active="tasks" className="w-40 flex-shrink-0 sm:w-44" />`，右侧放「← 返回任务面板」（沿用现有导航）。
- 内容区改为 `flex-1 overflow-y-auto`，内部保留 `mx-auto max-w-3xl px-4 py-6 sm:p-8` 布局；删除原内容区顶部的面包屑行（已上移 header）。

---

## 4. 行为

- 切换器 active 状态：chat 页 `chat`；看板/详情页 `tasks`。
- 点击逻辑不变：非 active tab 时 `navigate(to)`（聊天 → `/`，任务 → `/tasks`）。

---

## 5. 验证

- 现有测试无引用 `ViewSwitcher` / `SidebarHeader`，移动不影响现有测试。
- 手动验证（走运行的 app）：
  1. chat 页、看板页、详情页切换器都在内容区左上同一位置、同尺寸。
  2. 右侧「查看任务」「新建任务」尺寸一致。
  3. 切换 chat ↔ task 正常；详情页 active 为 tasks。
  4. 侧边栏折叠后，切换器仍可见（在内容区 header）。
  5. 移动端布局不破（切换器 + 标题 + 操作按钮同行可放）。

---

## 6. 不涉及

- 后端零改动。
- 路由零改动。
- 无新依赖。
