# Lovdex 定时任务 — 侧边栏入口 + 后端接线 + 前端视图 设计

- 日期：2026-08-17
- 状态：设计已评审
- 相关：`docs/superpowers/specs/2026-08-13-scheduled-tasks-design.md`（总体设计）、`docs/superpowers/plans/2026-08-13-scheduled-tasks-backend.md`（后端计划）、`docs/superpowers/plans/2026-08-13-scheduled-tasks-frontend.md`（前端计划）、`docs/superpowers/specs/2026-08-17-tasks-button-relocation-design.md`

## 1. 背景与目标

定时任务（scheduled tasks）的总体设计已于 2026-08-13 完成，且后端大部分已落地：
`scheduled_tasks` 表、迁移（含 `tasks.source_schedule_id`）、repository（`scheduled-tasks.db.ts`）、
调度器服务 `scheduler.service.ts`（15s 轮询 + once/interval/cron + 停机错过聚合提醒）、
`tasks` 的 `source_schedule_id` 透传均已在代码库中。

但功能尚未「通电」：

- **后端**：没有 `scheduler.routes.ts`，没有 `/api/scheduled-tasks` 路由；`index.js` 未构造/启动调度器、未挂路由、未接 WS 广播。
- **前端**：定时任务视图、类型、api 层、工具函数、hook 全部未做；侧边栏无入口。

本次目标：**补齐缺口，让用户从侧边栏一键进入「定时任务」并真正可用**。

- 侧边栏「项目列表上方」新增一个整行入口「定时任务」，点击跳转到任务页的「⏰ 定时」视图。
- 后端补上 CRUD API 与调度器启动接线。
- 前端任务页新增第三视图「⏰ 定时」（定时任务列表 + 创建/编辑表单）。

## 2. 关键设计决策

| 决策点 | 结论 |
|---|---|
| 入口形态 | 侧边栏整行入口（ghost 按钮，样式对齐 Lovdex助手 行），置于 Lovdex助手 行之后、项目列表之前 |
| 跳转目标 | 复用 `/tasks` 任务页，新增第三个 `viewMode='scheduled'`，即「⏰ 定时」视图 |
| 视图选中传递 | URL query 参数 `/tasks?view=scheduled`；TaskBoard 启动时读一次，不新建独立路由 |
| 调度执行 | 复用已写好的 `scheduler.service.ts`（不改逻辑），本次只补路由与接线 |
| 文案语言 | 任务区沿用现有惯例：硬编码中文，不走 i18n `t()` |
| Lovdex助手 定时工具 | **本次范围外**（见 §9），后续单独做 |

跳转用 query 参数而非新建 `/tasks/scheduled` 路由：不改动 `App.tsx` 路由表，TaskBoard 只需在挂载时读一次 `searchParams`。

## 3. 后端改动（`backend/server/`）

### 3.1 新增 `modules/scheduler/scheduler.routes.ts`

`buildSchedulerRouter(svc)`：薄路由，校验由 service 的 `validateScheduleInput` 承担（已存在）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/scheduled-tasks` | 列表，过滤 `projectPath` / `enabled` |
| POST | `/api/scheduled-tasks` | 创建（`201`） |
| GET | `/api/scheduled-tasks/:scheduleId` | 单条（`404` 若不存在） |
| PATCH | `/api/scheduled-tasks/:scheduleId` | 更新；改调度字段时 service 重算 `next_run_at` |
| DELETE | `/api/scheduled-tasks/:scheduleId` | 删模板（不动已生成任务） |
| POST | `/api/scheduled-tasks/:scheduleId/run-now` | 手动立即触发一次 |
| POST | `/api/scheduled-tasks/:scheduleId/enable` | 启用 |
| POST | `/api/scheduled-tasks/:scheduleId/disable` | 停用 |

- `SchedulerServiceLike` 类型对齐 service 门面的 `list/get/create/update/remove/runNow/setEnabled`。
- 复用 `AppError` + `asyncHandler`（`@/shared/utils.js`），仿 `tasks.routes.ts` 与 `operator.routes.ts` 的写法。

### 3.2 `modules/scheduler/index.ts` barrel

追加 `export { buildSchedulerRouter } from './scheduler.routes.js';`（现有 barrel 已导出 service 相关符号）。

### 3.3 `index.js` 接线

- import `scheduledTasksDb`、`createSchedulerService`、`buildSchedulerRouter`、`getOperatorConfig`。
- 构造调度器（放在 `startTaskRun` 定义之后）：用**原始 `tasksService`**（不用 operator adapter），注入：
  - `scheduledTasksDb: { ...scheduledTasksDb, operatorWorkspacePath: getOperatorConfig().workspace }`
  - `tasksService`、`createSession: createAppSession`、`startTaskRun`
  - `broadcast`：遍历 `connectedClients` 且 `readyState === WS_OPEN_STATE` 时 `send(JSON.stringify(event))`。
- `startServer()` 内 `schedulerService.start()`（`try/catch`，失败仅记日志不阻塞启动）。
- 挂 `app.use('/api/scheduled-tasks', authenticateToken, buildSchedulerRouter(schedulerService))`。

## 4. 前端数据层（`web/src/`）

### 4.1 类型 `types/app.ts`

- `Task` 接口补一列 `source_schedule_id: string | null;`（当前前端 `Task` 尚未含此字段，后端已返回）。
- 新增定时任务类型：

```ts
export type ScheduledTaskScheduleType = 'once' | 'interval' | 'cron';

export interface ScheduledTask {
  schedule_id: string;
  title: string;
  description: string | null;
  project_path: string | null;
  executor_provider: string;
  executor_model: string | null;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  label: string;
  is_operator: number;
  auto_run: number;
  schedule_type: ScheduledTaskScheduleType;
  cron_expr: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  last_task_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}
```

### 4.2 API 层 `utils/api.js`

`api` 对象追加 `scheduledTasks`（仿 `tasks` 的 `authenticatedFetch` 写法）：

```js
scheduledTasks: {
  list: (params) => authenticatedFetch('/api/scheduled-tasks' + query(params)),
  create: (body) => authenticatedFetch('/api/scheduled-tasks', { method: 'POST', body: JSON.stringify(body) }),
  get: (id) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`),
  update: (id, body) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runNow: (id) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(id)}/run-now`, { method: 'POST' }),
  enable: (id) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(id)}/enable`, { method: 'POST' }),
  disable: (id) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(id)}/disable`, { method: 'POST' }),
}
```

### 4.3 调度 humanize `utils/scheduleLabel.ts`

- `scheduleLabel(s)`：once → 格式化 `run_at`；interval → `每 N 小时/分钟`（`interval_seconds` 转可读）；cron → 有可读表达则 humanize，否则原样显示 cron 表达式。
- `nextRunLabel(s)`：格式化 `next_run_at`。

### 4.4 Hook `hooks/useScheduledTasks.ts`

- 挂载时 `GET /api/scheduled-tasks` 拉列表。
- 订阅 WS `scheduled_task_upserted` / `scheduled_task_deleted`，收到后增量更新（仿 `useTasks.ts` 的事件处理）。
- 返回 `{ tasks, loading, error, refresh }`。

## 5. 前端视图：任务页第三视图（`web/src/components/tasks/`）

### 5.1 `TaskBoard.tsx`

- `viewMode` 由 `useLocalStorage<'board' | 'table'>` 扩为 `'board' | 'table' | 'scheduled'`。
- 挂载时读 `useSearchParams()` 的 `view`：若为 `'scheduled'` 则 `setViewMode('scheduled')`（读一次，不随参数变化反复跳）。
- 顶部 board/table 分段控件加第三个「⏰ 定时」项。
- `effectiveView === 'scheduled'` 时渲染 `<ScheduledTasksView />` 替代 board/table。

### 5.2 `ScheduledTasksView.tsx`（新增）

- 纯展示组件（props 驱动，可测）+ 容器用 `useScheduledTasks`。
- 表格列：标题 / 调度（humanized）/ 项目 / 自动跑开关 / 下次触发 / 上次触发（`last_task_id` → 跳 `/task/:taskId`）/ 操作（立即触发、启停、删除、编辑）。
- 空态：无定时任务时提示「暂无定时任务」+「新建」按钮。
- 顶部「新建定时任务」按钮打开 `ScheduledTaskForm`。

### 5.3 `ScheduledTaskForm.tsx`（新增）

- 创建/编辑弹窗字段：标题（必填）、描述、项目（复用 `projectOptions.ts`）、执行器、优先级、label、`auto_run` 开关。
- 调度类型预设：一次性（`run_at`）/ 间隔（`interval_seconds`）/ cron（`cron_expr`），按类型显示对应字段。
- 实时预览 `next_run_at`（前端按类型粗算，最终以后端返回为准）。
- 提交走 `api.scheduledTasks.create/update`；失败在弹窗内提示，不抛到全局。

### 5.4 定时徽标（`TaskCard.tsx` / `TaskDetail.tsx`）

`Task.source_schedule_id`（§4.1 补的字段）非空时显示 `⏰ 定时` 徽标；点击跳转到 `/tasks?view=scheduled`。

## 6. 侧边栏入口（`web/src/components/sidebar/`）

- 新增 `view/subcomponents/SidebarScheduledEntry.tsx`：整行 ghost 按钮，⏰ 图标（`Clock` 或 `CalendarClock`，lucide-react），文案「定时任务」，`navigate('/tasks?view=scheduled')`。
- `SidebarContent.tsx`：在 `<SidebarAssistant />` 之后、`<SidebarProjectList />` 之前渲染 `SidebarScheduledEntry`。
- 桌面端与移动端各一版，样式对齐 Lovdex助手 行（`bg-primary/5` 整行 + 左图标 + 文本）；不展开列表（纯导航入口，不内嵌定时任务列表）。
- 文案硬编码中文（对齐任务区惯例）。

## 7. 错误处理

- 后端：路由层 404/400 由 `AppError` 统一处理；调度器 `start()` 失败仅记日志，不阻塞服务启动；tick 单条 dispatch 失败 try/catch 继续（service 已实现）。
- 前端：列表拉取失败显示错误态 + 重试；表单提交失败弹窗内提示；WS 断线不阻塞手动刷新。

## 8. 测试

- **后端**：新增 `modules/scheduler/tests/scheduler.routes.test.ts`（进程内 Express + 内置 fetch，仿 `operator.routes.test.ts`）覆盖 CRUD / run-now / enable / disable / 校验 400。复用已存在的 `scheduler.service.test.ts` 与 `scheduled-tasks.db.test.ts`。
- **前端**：`scheduleLabel` humanize 单测；`ScheduledTasksView` 渲染（含空态、行操作）；`ScheduledTaskForm` 校验；`TaskBoard` 三态 viewMode 切换 + `?view=scheduled` 启动选中。
- **手动验证**：创建 interval 定时 → 到点自动建任务（`source_schedule_id` 非空）→ 侧边栏按钮进入「⏰ 定时」视图并看到该模板。

## 9. 范围外（本次不做）

- **Lovdex助手 的 5 个定时任务工具**（`create_scheduled_task` / `list_scheduled_tasks` / `get_scheduled_task` / `update_scheduled_task` / `delete_scheduled_task`）与两处 system prompt 更新——见 `2026-08-13-scheduled-tasks-design.md` §6，建议下一轮单独做。
- 定时任务推送通知（push/vapid）——总体设计中已明确不引入。

## 10. 验收标准

1. 后端启动后 `GET /api/scheduled-tasks` 返回 `[]`（空列表，无报错）；调度器 `setInterval` 每 15s 运行。
2. `POST /api/scheduled-tasks` 可创建 once/interval/cron 三种模板；`run-now` 立即生成一条 `source_schedule_id` 非空的任务；`enable/disable` 生效。
3. 侧边栏 Lovdex助手 行下方出现「定时任务」整行入口，点击跳转到 `/tasks?view=scheduled` 且任务页选中「⏰ 定时」视图。
4. 「⏰ 定时」视图可创建/编辑/删除/启停/立即触发定时任务，列表实时（WS）刷新。
5. 到点触发自动建任务并（`auto_run=1` 时）自动执行；停机错过的触发聚合成一条 `label=reminder` 提醒任务。
6. 后端/前端新增测试全部通过，既有测试无回归。
