# 定时任务：最近触发跳会话 + 内联详情编辑 设计

日期：2026-09-22
状态：已设计（无人值守，决策采用推荐项，待实现）

## 背景与问题

三个诉求，都指向「把定时任务从『纯列表 + 弹窗编辑』升级成『可点开、可跳会话、内联改』」：

1. **「上次触发」要跳会话**：现在桌面表格的「上次触发」列和卡片「上次」行都只给一个「查看」链接，跳到 `/task/:task_id`（任务详情页）。用户要的是直接跳到那一次运行对应的会话 `/session/:sessionId`。
2. **点击任务进入详情**：现在点击行/卡片没有任何反应，只有「编辑」铅笔打开模态 `Dialog`。用户要点击任务本体就进入「定时任务详细」，且不跳新页面、不弹模态，直接在当前页面呈现。
3. **在详情里修改**：编辑动作并入详情，不再走模态弹窗。

## 设计

布局沿用仓库里现成的主从先例 —— 收件箱 `InboxPage`（`web/src/components/inbox/InboxPage.tsx`）：桌面右栏详情 + 移动端底部 sheet。

### 1. 「上次触发」跳会话（纯前端）

新增纯函数 `lastRunTarget(schedule, taskById)`，解析「上次触发」单元格的跳转目标：

- `schedule.last_task_id` 有值，且 `taskById` 里那条任务 `session_id` 非空且 `!session_deleted`（复用 `taskActions.hasOpenableSession`）→ `{ kind: 'session', path: '/session/:id' }`；
- `last_task_id` 有值但无可用会话 → `{ kind: 'task', path: '/task/:id' }`（回退成现状，避免死链接）；
- 无 `last_task_id` → `{ kind: 'none' }`。

`ScheduledTask` 上只有 `last_task_id`，没有 `session_id`，所以 `ScheduledTasksView` 需要拿到任务列表做 `task_id → session_id` 映射。`ScheduledTasksPanel` 已经有全量 `Task[]`，在那里 `useMemo` 出 `taskById: Map<string, Task>` 传进来（命名避免与 `ScheduledTask[]` 的 `tasks` 撞车）。

桌面表格「上次触发」列：`session` → 「打开会话」链接，`task` → 「查看任务」链接，`none` → `—`。卡片「上次」FieldRow 同款。

### 2. 点击任务 → 内联详情（主从布局）

`ScheduledTasksView` 从「纯列表」变成「可选中列表」：

- 新增 props：`selectedId: string | null`、`onSelect: (task: ScheduledTask) => void`、`taskById: Map<string, Task>`。
- 桌面行、移动卡片整体 `onClick={() => onSelect(task)}`，选中态高亮（行加背景/描边，卡片加 ring），并 `cursor-pointer`。
- 行内的交互元素阻止冒泡（`stopPropagation`），避免点开关/立即触发/删除/会话链接时误触发行选中：`Switch`、立即触发、删除按钮、上次触发链接。
- **删除行内「编辑」铅笔**：点击行本身即进入可编辑详情，铅笔冗余。

选中状态与详情渲染都收敛到 `ScheduledTasksPanel`：

- 桌面（`useDeviceSettings({ mobileBreakpoint: 1024 })` 判 `!isMobile`）：列表在左（`flex-1 min-w-0`），右侧 `ScheduledTaskDetail` 面板（`w-[420px] shrink-0`）。
- 移动（`isMobile`）：列表单列，选中后打开底部 sheet（`Dialog variant="sheet"`，同 `InboxPage`）。

### 3. 详情内联编辑

把 `ScheduledTaskForm` 里 `Dialog` 之外的表单字段抽成可复用组件 `ScheduledTaskFormBody`（自管 `draft` state，逻辑整体从 `ScheduledTaskForm` 迁过去）：

- props：`initial`、`active`（模型拉取闸门，见下）、`projectOptions`、`submitting`、`error`、`onCancel`、`onSubmit`。
- `useProviderModels(engine, active)` 的 `active` 参数由调用方传：新建弹窗传 `open`，详情面板恒 `true`。

之后：

- `ScheduledTaskForm`（弹窗）保留，只服务「新建」（`initial=null`）：`Dialog` 壳 + `ScheduledTaskFormBody`。
- 新增 `ScheduledTaskDetail`：只读摘要头（标题 + 启停 `Switch` + 徽标 + 调度/项目/下次/上次→会话链接）+ `ScheduledTaskFormBody`（`initial=选中任务`）+ 立即触发/删除快捷按钮。
- `ScheduledTasksPanel.submit` 拆两条：
  - `openNew()` → 新建弹窗 → `submitCreate(draft)`（POST）；
  - 详情 → `submitUpdate(scheduleId, draft)`（PATCH）。
  两者复用 `toApiBody`。

## 数据流与错误处理

- **无后端改动**。编辑/启停/立即触发/删除仍走现有 `api.scheduledTasks.*`，成功后 `refresh()`。
- 详情里选中任务被删或 refresh 后从列表消失时，`selectedId` 兜底回 `null`（关闭详情），不渲染幽灵面板。
- 详情面板的启停/立即触发/删除逻辑复用 `ScheduledTasksPanel` 现有的 `toggle`/`runNow`/`remove`（同一套错误条 `actionError`）。

## 测试

- 新增 `lastRunTarget` 纯函数测试（无 DOM，直接断言三种返回）。
- `ScheduledTasksView.test.tsx` 更新：`onSelect` 接线、上次触发三种渲染（会话链接/任务链接/—）、不再出现编辑铅笔按钮。
- 新增 `ScheduledTaskDetail` 静态渲染测试（`renderToStaticMarkup` 标记断言，同仓库现有模式）。
- 跑法同现有前端测试：`cd web && env -u TSX_TSCONFIG_PATH npx tsx --test <file>`。

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `web/src/components/tasks/lastRunTarget.ts`（新） | 纯函数：`last_task_id` → 会话/任务/无 跳转目标 |
| `web/src/components/tasks/ScheduledTasksView.tsx` | 可选中列表、上次触发跳会话、删编辑铅笔、新增 props |
| `web/src/components/tasks/ScheduledTaskForm.tsx` | 抽 `ScheduledTaskFormBody`；`ScheduledTaskForm` 收窄为新建弹窗壳 |
| `web/src/components/tasks/ScheduledTaskDetail.tsx`（新） | 详情面板/摘要头 + 内联表单 |
| `web/src/components/tasks/ScheduledTasksPanel.tsx` | `selectedId` 状态、主从布局、移动 sheet、submit 拆 create/update |
| 对应 `*.test.tsx` / `*.test.ts` | 更新与新增断言 |

## 非目标

- 不改后端、不加接口。
- 「新建」仍走弹窗（创建不是「点击任务进入详情」的场景）。
- 详情里不放运行记录（已有「运行记录」子标签）。
- 不照搬 `InboxPage` 的可拖列表宽度（详情栏固定 420px）。
