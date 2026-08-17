# Tasks 按钮迁至 Lovdex 行 — 设计

日期：2026-08-17

## 背景

Tasks 页面是任务管理器，目前入口是主内容区顶部的分段控件
（Chat / Files / Source Control / Tasks）里的一个 Tab 项。用户希望把它
挪到侧边栏顶部的 Lovdex 行，与「刷新 / 创建 / 隐藏」三个按钮放在同一行，
因为 chat 是主页，Tasks 应是次要入口。

## 目标

- 把 Tasks 入口从 `MainContentTabs` 移除，避免重复。
- 在 Lovdex 行（`SidebarHeader`）新增 Tasks 图标按钮，点击 `navigate('/tasks')`。
- 桌面端与移动端都提供该入口（移动端侧边栏头部目前只有刷新+创建）。

## 改动

### 1. `web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx`

- 引入 `ClipboardList`（lucide-react）与 `useNavigate`（react-router-dom）。
  直接 `navigate('/tasks')`，沿用 `MainContentTabs` 已用的直接导航模式，
  避免在 Sidebar → SidebarContent → SidebarHeader 三层穿参。
- 桌面端按钮组（`hidden md:block`）新增 Tasks 按钮，放在最左，
  顺序变为 **[Tasks][刷新][创建][隐藏]**。样式与其它三个一致
  （ghost、`h-7 w-7 rounded-lg p-0`、`title` tooltip），图标沿用
  tabs 里的 `text-emerald-500`。
- 移动端头部（`md:hidden`）新增 Tasks 按钮，顺序 **[Tasks][刷新][创建]**，
  样式与移动端刷新按钮一致（`h-8 w-8` muted）。

### 2. `web/src/components/main-content/view/subcomponents/MainContentTabs.tsx`

- 删除 Tasks 按钮项。
- 删除不再使用的 `ClipboardList` 与 `useNavigate` import（`navigate` 仅被
  Tasks 项使用）。
- 更新组件顶部注释。

### 3. `web/src/i18n/locales/en/sidebar.json`

- `tooltips` 下新增 `"tasks": "Tasks"`，按钮 `title` 用 `t('tooltips.tasks')`。

## 范围外 / 保持不变

- `/tasks`、`/task/:taskId` 全屏路由与 `TaskBackNav` 返回导航不变。
- 隐藏按钮仍仅桌面端。
- Tasks 页面本身（TaskBoard / TaskDetail）不做改动。

## 验证

- `web` 目录跑 lint、测试、build，确认无类型 / 构建错误。
- 手动确认：桌面端 Lovdex 行出现 Tasks 按钮并可跳转 /tasks；
  移动端头部出现 Tasks 按钮；顶部 tabs 只剩 Chat / Files / Source Control。
