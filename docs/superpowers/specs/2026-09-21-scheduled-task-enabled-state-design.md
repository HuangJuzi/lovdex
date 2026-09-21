# 定时任务启用/停用状态可视化 设计

日期：2026-09-21
状态：已批准（视觉方案经浏览器 mockup 确认）

## 背景与问题

定时任务列表（`ScheduledTasksView.tsx`）中「启用/停用」状态几乎不可辨：

- **桌面表格（≥1024px）**：完全没有启停状态信息。「自动执行」列只表达 `auto_run`（自动执行/仅提醒）维度；停用任务与启用任务渲染完全一致，只能靠悬停 ⏻ 按钮的 title 区分。
- **手机卡片（<1024px）**：停用卡片有「⏸ 已停用」徽标 + 整体 `opacity-60`，但徽标是灰底灰字、无边框，扫视对比弱。
- **附带混淆**：后端停用时不清空 `next_run_at`（`scheduler.service.ts` 只改 `enabled=0`），停用任务仍显示一个永远不会触发的「下次」时间。

用户要求：激活 vs 关闭状态一眼可辨，且要有可见的启用/停用开关（视觉方案 A+B 组合，已确认）。

## 设计

### 1. 新增通用 Switch 组件

新文件 `web/src/shared/view/ui/Switch.tsx`，从 `web/src/shared/view/ui/index.ts` 导出。

- 受控组件，props：`checked: boolean`、`onToggle: () => void`、`ariaLabel: string`。
- `<button role="switch" aria-checked={checked}>`，内部轨道 span：
  - 尺寸 36×20px（`h-5 w-9`）圆角胶囊；滑块 16×16px 白色圆点带阴影。
  - 开：`bg-success`（绿），滑块右移；关：`bg-muted`，滑块左移。过渡 `transition-colors`。
  - 键盘焦点环与 DarkModeToggle 同款（`focus-visible:ring-2 focus-visible:ring-ring`）。
- 外层 button 沿用 `mobile-touch-target` 保证手机触控面积。
- **不迁移 DarkModeToggle**：主题开关保持原样避免回归；两处样式相似但尺寸/语义不同，将来有需要再统一（非目标）。

### 2. 桌面表格（`ScheduledTasksView.tsx`，lg+ 分支）

表头由「标题 / 调度 / 项目 / 自动执行 / 下次触发 / 上次触发 / 操作」改为：

> **启用** / 标题 / 调度 / 项目 / **模式** / 下次触发 / 上次触发 / 操作

- 第 1 列「启用」：`Switch checked={task.enabled === 1}`，`onToggle` 复用现有 `onToggle(task)`（调 enable/disable API 后 refresh），`ariaLabel` 含任务标题。
- 「自动执行」列改名「模式」，内容改用新的 `modeBadge(task)`：仅表达 `auto_run` 两态（✅ 自动执行 绿 / 🔔 仅提醒 橙），**停用行也照常显示模式徽标**——停用语义由开关列 + 整行变淡表达，徽标不重复。
- 停用行（`enabled === 0`）：
  - `<tr>` 追加 `opacity-60`；
  - 标题单元格追加 `text-muted-foreground`；
  - 「下次触发」显示 `—`（替代 `formatAbsoluteTime(task.next_run_at)`）。
- 操作列删除 ⏻ Power 按钮（启停由开关承担），保留 ▶ 立即触发 / ✎ 编辑 / 🗑 删除。
- `min-w-[900px]` 与 7px 行间距保持不变（新增列宽约 60px，仍在横向滚动预算内）。

### 3. 手机卡片（<1024px 分支）

- 标题行改为 `flex justify-between items-center`：左侧标题，右侧 `Switch`（同桌面）。
- 徽标维持三态 `statusBadge(task)`：启用时 ✅ 自动执行 / 🔔 仅提醒；停用时「⏸ 已停用」并**增加虚线边框**（`border border-dashed`）增强对比。
- 停用卡片：保留现有 `opacity-60`，标题变灰（`text-muted-foreground`）。
- 「下次」FieldRow：停用显示 `—`。
- 操作行删除 Power `ActionButton`。

### 4. 状态语义一览

| 维度 | 载体 | 取值 |
|---|---|---|
| 启用/停用 | Switch（表格第 1 列 / 卡片标题右侧） | 绿=启用，灰=停用 |
| 执行模式 | 徽标（表格「模式」列 / 卡片徽标位） | ✅ 自动执行 / 🔔 仅提醒 |
| 停用强化 | 行变淡 + 标题灰 + 下次「—」+ 卡片虚线徽标 | 仅 `enabled=0` |

卡片停用时徽标显示「⏸ 已停用」而非模式（与现状一致）；桌面因有开关列，模式徽标常显。两端徽标函数共享样式常量，避免漂移。

## 数据流与错误处理

- 无后端改动。切换仍走 `api.scheduledTasks.enable/disable` → 成功后 `refresh()`。
- Switch 为纯受控组件，UI 完全由 refresh 后的数据驱动：API 失败（res 非 ok）不 refresh，开关视觉自动停留在真实状态，不会出现假状态。与现状一致，不新增 toast。

## 测试

沿用 `ScheduledTasksView.test.tsx` 现有模式（`node:test` + `renderToStaticMarkup` 标记断言）：

- `enabled=1`：桌面含「启用」表头与 `role="switch"` + `aria-checked="true"`；卡片含「自动执行/仅提醒」徽标。
- `enabled=0`：`aria-checked="false"`；行含 `opacity-60`；桌面「下次触发」与卡片「下次」渲染 `—`；卡片含「已停用」徽标；桌面「模式」列仍显示模式徽标。
- 操作列不再出现原 ⏻ 按钮（按 aria-label/title 断言缺失）。
- 点击切换行为不在 SSR 断言环境覆盖（onToggle 接线为一行委托），由既有 E2E 途径（puppeteer 连 live dev server）按需验证。

跑法与仓库现有前端测试一致。

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `web/src/shared/view/ui/Switch.tsx` | 新增通用受控开关 |
| `web/src/shared/view/ui/index.ts` | 导出 Switch |
| `web/src/components/tasks/ScheduledTasksView.tsx` | 表格加启用列/模式列、开关、停用行弱化、下次「—」、删 Power；卡片同款 |
| `web/src/components/tasks/ScheduledTasksView.test.tsx` | 上述断言 |

后端、`ScheduledTasksPanel.tsx`（toggle/refresh 逻辑）均不动。

## 非目标

- 不迁移/重构 DarkModeToggle。
- 后端停用时不物理清空 `next_run_at`（仅前端停用时显示「—」，数据保留，重新启用后仍按原相位续跑）。
- 不为启停增加确认弹窗（维持现状直切）。
- 不新增停用任务的筛选/排序。
