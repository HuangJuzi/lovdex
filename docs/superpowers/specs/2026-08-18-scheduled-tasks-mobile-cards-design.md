# 定时任务卡片视图（手机 Web 支持）设计

日期：2026-08-18
状态：已确认

## 背景与目标

定时任务视图目前渲染为 `min-w-[900px]` 的表格，手机访问必须横向滚动、文字过小，体验差。目标：把定时任务列表改为 **卡片视图**，适配手机 Web（单列），同时在桌面以网格呈现。**卡片成为唯一视图，删除表格。**

## 现状

- `ScheduledTasksView.tsx`：当前渲染 900px 宽表格，7 列（标题/调度/项目/自动执行/下次触发/上次触发/操作），横向滚动。
- `ScheduledTasksPanel.tsx`：持有 `useScheduledTasks` 数据 + 四个回执回调，把 data + 回调传给 `ScheduledTasksView`。
- `useScheduledTasks.ts`：API 拉取 + WS `scheduled_task_upserted/deleted` 实时更新。
- `ScheduledTaskForm.tsx`：新建/编辑弹窗，已是响应式 Dialog（`max-w-lg` + `max-h-[85vh] overflow-y-auto`），无需改动。
- 断点约定：Task 页 `isMobile` 断点为 640px（`useDeviceSettings({ mobileBreakpoint: 640 })`）。

## 方案（已与用户确认）

### 1. 卡片代替表格

`ScheduledTasksView` 从 `<table>`（含空态外）改为卡片网格，所有屏幕宽度统一卡片。数据流零改动：

- 仍从 `ScheduledTasksPanel` 经 props 接收 `tasks` / `projectOptions` 和 `onEdit`/`onDelete`/`onToggle`/`onRunNow` 四个回调。
- 不新增取数、不新增 API。

### 2. 响应式布局

同一组件，CSS 断点切换列数：

| 断点 | 列数 |
|---|---|
| <640px（手机） | 1 列 |
| 640–1024px（sm/md） | 2 列 |
| ≥1024px（lg+） | 3 列 |

### 3. 卡片内容（方案 B · 信息全卡）

每张卡片：

- **标题行**：标题（省略号截断）+ 状态徽标
  - `✅ 自动执行`（`auto_run=1`）
  - `🔔 仅提醒`（`auto_run=0`）
  - `⏸ 已停用`（`enabled=0`，此时整卡 `opacity` 降为约 55%）
- **字段行**（label 左对齐，值右对齐）：
  - 调度：`scheduleLabel(task)`（cron/interval 人类可读中文；once 显示「一次性」）
  - 项目：`projectLabel(task, projectOptions)`（复用现有逻辑；is_operator=1 或无 project_path 显示 `🤖 Lovdex助手`）
  - 下次：`formatAbsoluteTime(task.next_run_at)`
  - 上次：有 `last_task_id` 时渲染"查看任务"链接 → 路由 `/task/<last_task_id>`（Goto）；否则显示 `—`
- **操作行**（底部细分隔线）：▶ 立即触发（sky 色）· ⏻ 启停 · ✎ 编辑 · ⌫ 删除（红色）。沿用现有 icon button，颜色/aria-label/title 不变。

### 4. 组件结构

- `ScheduledTasksView` 负责网格（含空态 `暂无定时任务`）。
- 同文件内抽 `ScheduledTaskCard` 子组件渲染单卡，props 仅传它需要的字段 + 回调，不重复取数。

### 5. 移动端细节

- 操作按钮用 `.mobile-touch-target`（min 44×44px）保证触控区域；桌面保持紧凑尺寸。
- 移除表格的 `min-w-[900px]` 横向滚动。
- 触屏 hover 由全局 `@media (hover: none)` 规则处理，无需新增。

## 测试

沿用现有 `renderToStaticMarkup` + `StaticRouter` 模式更新 `ScheduledTasksView.test.tsx`：

1. **字段渲染**：标题、调度 label（`每天 09:00`）、项目、下次时间出现在卡片内。
2. **状态徽标**：`auto_run=1` → `自动执行`；`auto_run=0` → `仅提醒`。
3. **停用态**：`enabled=0` → `已停用`（断言降透明度的 class/样式存在）。
4. **last_task_id**：有值 → 渲染"查看任务"，链接指向 `/task/<id>`；无值 → `—`。
5. **空态**：`暂无定时任务`（保留现有断言）。

## 范围外

- 定时任务的新建/编辑表单弹窗（已响应式）。
- 任务看板/表格视图的移动端适配（本次只做定时列表）。
- 卡片排序、筛选、下拉等增强。

## 关键文件

- `web/src/components/tasks/ScheduledTasksView.tsx`（改）
- `web/src/components/tasks/ScheduledTasksView.test.tsx`（改）