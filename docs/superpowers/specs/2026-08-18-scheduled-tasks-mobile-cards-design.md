# 定时任务卡片视图（手机 Web 支持）设计

日期：2026-08-18
状态：已确认

## 背景与目标

定时任务视图目前渲染为 `min-w-[900px]` 的表格，手机访问必须横向滚动、文字过小，体验差。目标：**为定时任务列表增加手机 Web 适配**——手机/平板宽度显示卡片（方案 B 信息全卡），**桌面（≥1024px）保留原表格不变**。

> 注：早版方案定为「卡片作为唯一视图、删除表格」，实施后用户确认桌面也要保留原表格，最终改为响应式双渲染（CSS 断点切换），桌面行为与改动前完全一致。

## 现状

- `ScheduledTasksView.tsx`：当前渲染 900px 宽表格，7 列（标题/调度/项目/自动执行/下次触发/上次触发/操作），横向滚动。
- `ScheduledTasksPanel.tsx`：持有 `useScheduledTasks` 数据 + 四个回执回调，把 data + 回调传给 `ScheduledTasksView`。
- `useScheduledTasks.ts`：API 拉取 + WS `scheduled_task_upserted/deleted` 实时更新。
- `ScheduledTaskForm.tsx`：新建/编辑弹窗，已是响应式 Dialog（`max-w-lg` + `max-h-[85vh] overflow-y-auto`），无需改动。
- 断点约定：Task 页 `isMobile` 断点为 640px（`useDeviceSettings({ mobileBreakpoint: 640 })`）。

## 方案（已与用户确认）

### 1. 响应式双渲染：桌面表格 + 窄屏卡片

`ScheduledTasksView` 同时渲染原表格与卡片网格，用 Tailwind 断点类控制显示（`hidden lg:block` 表格 / `lg:hidden` 卡片）——与代码库既有响应式风格一致。数据流零改动：

- 仍从 `ScheduledTasksPanel` 经 props 接收 `tasks` / `projectOptions` 和 `onEdit`/`onDelete`/`onToggle`/`onRunNow` 四个回调。
- 不新增取数、不新增 API。

### 2. 响应式布局

| 宽度 | 呈现 |
|---|---|
| <640px（手机） | 卡片，1 列 |
| 640–1023px（sm/md 平板） | 卡片，2 列 |
| ≥1024px（lg+ 桌面） | **原表格**（7 列，无改动） |

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

- `ScheduledTasksView` 负责双渲染布局（含空态 `暂无定时任务`），桌面表格使用 `useNavigate` 的原「查看」按钮，卡片使用 `Link` 的"查看任务"。
- 同文件内抽 `ScheduledTaskCard` 子组件渲染单卡，props 仅传它需要的字段 + 回调，不重复取数。

### 5. 移动端细节

- 卡片操作按钮用 `.mobile-touch-target`（min 44×44px，仅 <768px 生效）保证触控区域；桌面表格操作按钮保持原紧凑尺寸。
- 触屏 hover 由全局 `@media (hover: none)` 规则处理，无需新增。

## 测试

沿用现有 `renderToStaticMarkup` + `StaticRouter` 模式更新 `ScheduledTasksView.test.tsx`（SSR 输出同时包含桌面表格与卡片标记，CSS 类控制显示，故全部用正向断言）：

1. **双渲染**：表格容器 `hidden ... lg:block` + 列头（如 `上次触发`）+ 卡片容器 `lg:hidden` 都出现在标记中；标题、调度 label、项目同样渲染。
2. **状态徽标**：`auto_run=1` → `自动执行`；`auto_run=0` → `仅提醒`。
3. **停用态**：`enabled=0` → `已停用` + 卡片 `opacity-60` 降透明。
4. **last_task_id**：有值 → 卡片渲染"查看任务"，`href="/task/<id>"`；无值 → `—`。
5. **空态**：`暂无定时任务`（保留现有断言）。

> 说明：不做 `自动执行`/`仅提醒` 互斥断言——桌面表格列头固定含「自动执行」，双渲染下负向断言不成立。

## 范围外

- 定时任务的新建/编辑表单弹窗（已响应式）。
- 任务看板/表格视图的移动端适配（本次只做定时列表）。
- 卡片排序、筛选、下拉等增强。

## 关键文件

- `web/src/components/tasks/ScheduledTasksView.tsx`（改）
- `web/src/components/tasks/ScheduledTasksView.test.tsx`（改）