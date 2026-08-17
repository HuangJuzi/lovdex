# 任务板增强设计 — 新建任务表单 + 数据模型

日期：2026-08-11
状态：已批准（用户确认）

## 概述

对 Lovdex 任务板（`/tasks`）做 5 项增强：

1. 新建任务的项目下拉排除「主Agent的工作目录」（应用自身根目录），并新增「🤖 Lovdex 助手」选项。
2. 新建任务防呆：表单打开时禁用「＋ 新建任务」按钮，防止误点击清空已填内容。
3. 任务新增 **优先级（P0~P3）** 与 **Deadline（日期 YYYY-MM-DD）**，在新建表单可设、卡片展示、详情页可编辑。
4. 项目下拉**收藏项目优先**（`isStarred` 在前，再按 displayName 排序）。
5. 任务新增 **Label（六档：bug/feature/optimization/refactor/docs/other）** 与 **备注（remark，需求来源等自由文本，方便追溯）**，新建表单可设、卡片展示、详情页可编辑。

## 术语

- **主Agent的工作目录**：Lovdex 应用运行根目录（supervisor 工作目录，如 `/mnt/b/workdir/github/lovdex`）。后端 `findAppRoot()` 算出的 `APP_ROOT` 是**后端仓库根**（如 `/mnt/b/workdir/github/lovdex/lovdex-backend`），主Agent工作目录是其**父目录**：`getMainAgentWorkspace() = process.env.LOVDEX_MAIN_WORKSPACE ?? path.dirname(getAppRoot())`。DB 中 `/home/zhijuhuang/workdir/github/lovdex` 是它的 symlink 路径，用 `fs.realpath` 归一化后比较命中。
- **Lovdex 助手**：已上线的 operator assistant（封闭工具集 + operator workspace）。`is_operator` 任务执行时创建 `is_operator=1` 的 session，chat runtime 自动走 operator 分支。

## 数据模型改动

`tasks` 表新增五列（`schema.ts` 的 `TASKS_TABLE_SCHEMA_SQL` + `migrations.ts` 的 `migrateTasksTable` 用 `addColumnToTableIfNotExists` 补齐）：

```sql
priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
deadline TEXT,                    -- YYYY-MM-DD，可为 NULL
is_operator INTEGER DEFAULT 0,    -- 1 = Lovdex 助手任务
label TEXT NOT NULL DEFAULT 'other' CHECK (label IN ('bug','feature','optimization','refactor','docs','other')),
remark TEXT                       -- 备注（需求来源等自由文本），可为 NULL
```

- `priority`/`label` 常量/校验器放 `server/shared/task-status.ts`：`TASK_PRIORITIES`/`isTaskPriority()`、`TASK_LABELS`/`isTaskLabel()`。CHECK 由数组生成（与 STATUS_CHECK 同风格）。
- `deadline` 存字符串 `YYYY-MM-DD`（与 SQLite 无时区问题）。校验：`/^\d{4}-\d{2}-\d{2}$/` 且为合法日期，否则 400。
- `label` 六档英文 key（`bug`/`feature`/`optimization`/`refactor`/`docs`/`other`），默认 `other`；前端 `LABEL_META` 映射中文标签 + 颜色。
- `remark` 自由文本，可为 NULL，仅校验类型（string 或 null）。
- 既有行：`priority` 默认 `P2`，`deadline`/`remark` NULL，`is_operator` 0，`label` 默认 `other`。

## 后端改动

### 1. 项目列表标记主Agent工作目录
文件：`server/modules/projects/services/projects-with-sessions-fetch.service.ts`

- `ProjectListItem` 增加 `isMainAgentWorkspace: boolean`。
- `getProjectsWithSessions`：启动/首次计算 `mainAgentRoot = realpath(APP_ROOT)`；对每个项目 `realpath(project_path)` 与之比较，标记 `isMainAgentWorkspace`。
- 来源：`server/utils/runtime-paths.js` 已有 `findAppRoot`（得后端仓库根 `getAppRoot()`）；新增导出 `getMainAgentWorkspace()` = `LOVDEX_MAIN_WORKSPACE` env 或 `path.dirname(getAppRoot())`（Lovdex 运行根目录）。service 用 `getMainAgentWorkspace()`，realpath 可缓存（模块级一次）。
- `/api/projects/archived` 不涉及任务表单，不改。

### 2. 任务 create/update 支持 priority / deadline / isOperator / label / remark
文件：`server/shared/types.ts`（TaskRow 加 `priority`、`deadline`、`is_operator`、`label`、`remark`）、`server/shared/task-status.ts`（常量/校验）、`server/modules/database/repositories/tasks.db.ts`（createTask 输入 + INSERT 列；updateTask 白名单加 priority/deadline/label/remark）、`server/modules/tasks/services/tasks.service.ts`（CreateTaskInput + 透传）、`server/modules/tasks/tasks.routes.ts`（校验 + 解析）。

- `createTask(input)`：
  - `priority` 缺省 `'P2'`，非法抛 `INVALID_PRIORITY` 400。
  - `deadline` 缺省 null，非法抛 `INVALID_DEADLINE` 400。
  - `label` 缺省 `'other'`，非法抛 `INVALID_LABEL` 400。
  - `remark` 缺省 null，仅接受 string/null。
  - `isOperator` 真时：executor 必须是 claude（否则 400）；从 `getOperatorConfig().workspace` 解析工作区（展开 `~`），`projectsDb.createProjectPath(workspace)` 确保注册，`project_path` = 该 workspace，跳过原 project 校验路径（已注册）。`is_operator` 写 1。
- `updateTask`：`updates` 白名单加 `priority`/`deadline`/`label`/`remark`，透传给 `tasksDb.updateTask`。operator 任务不允许改 project（`is_operator=1` 时 project 变更 400）。
- `startExecution`：`createSession(row.executor_provider, row.project_path)` 改为 `createSession(row.executor_provider, row.project_path, Boolean(row.is_operator))`；`tasks.routes` 的 `createSession` 透传第三个参数给 `sessionsDb.createAppSession(sessionId, provider, projectPath, isOperator)`。index.js 的 wiring 同步改。

### 3. 自动 verdict 递归守卫（不改代码，仅确认行为）
operator 任务的 session 是 `is_operator=1`，`scheduleAutoVerdict` 的 recursion guard 已跳过，所以助手任务完成后停在评审列由人 gate，无 AI 判定。符合设计决定。

## 前端改动（lovdex-cli）

### 类型
`src/types/app.ts`：
- `TaskPriority = 'P0' | 'P1' | 'P2' | 'P3'`
- `TaskLabel = 'bug' | 'feature' | 'optimization' | 'refactor' | 'docs' | 'other'`
- `Task` 加 `priority: TaskPriority`、`deadline: string | null`、`is_operator: number`（0/1）、`label: TaskLabel`、`remark: string | null`。

### 新建表单（`src/components/tasks/TaskBoard.tsx`）
- **防呆**：`creating === true` 时「＋ 新建任务」按钮 `disabled`。
- **项目下拉**：
  - 过滤 `isMainAgentWorkspace` 的项目。
  - 排序：`isStarred` 在前，再 displayName（localeCompare）。
  - 顶部固定「🤖 Lovdex 助手」选项（value 特殊占位如 `__lovdex_assistant__`）。
- **优先级 select**（P0~P3，默认 P2）+ **deadline `<input type="date">`**。
- **Label select**（六档，默认 other）+ **备注 `<Input>`**（自由文本）。
- `createTask()`：选助手时发 `isOperator: true`（projectPath 占位，后端解析）；否则发 `projectPath/priority/deadline/label/remark`。

### 卡片（`src/components/tasks/TaskCard.tsx`）
- Label 徽章（`taskStatus.ts` 加 `LABEL_META`：bug 红/feature 绿/optimization 蓝/refactor 紫/docs 青/other 灰）。
- 优先级色点/标签（`taskStatus.ts` 加 `PRIORITY_META`：P0 红/P1 橙/P2 蓝/P3 灰）。
- deadline 徽标「截止 N 天后」/「已逾期 N 天」（红）。
- `is_operator` 任务显示「🤖 助手」徽章。

### 详情页（`src/components/tasks/TaskDetail.tsx`）
- 属性区：优先级 select + deadline date input + Label select + 备注 input，可编辑（走 `api.tasks.update`）。
- 项目下拉同样收藏优先 + 排除主Agent工作目录 + 助手选项；operator 任务的「所属项目」只读显示 workspace 路径（禁改项目）。
- 顶部标题旁对 operator 任务显示「🤖 助手」徽章。

### 排序/展示工具
- `src/components/tasks/taskStatus.ts`：`PRIORITY_META`、`PRIORITY_ORDER`、`LABEL_META`、`LABEL_ORDER`。
- `src/components/tasks/taskTimestamp.ts`（或新文件）：`deadlineLabel(task, now)` → `{ label, overdue }`。
- 项目排序函数抽到 `src/components/tasks/projectOptions.ts`（新建纯函数：过滤 + 收藏优先 + 助手选项列表），TaskBoard/TaskDetail 共用。

## 测试

后端（`npx tsx --test`）：
- `tasks.db.integration.test.ts`：priority/deadline/is_operator/label/remark 通过 create/update 持久化、默认值、校验。
- `tasks.service.test.ts`：create 校验（非法 priority/deadline/label、isOperator 非 claude 400、operator workspace 注册）；update 校验；startExecution 传 isOperator。
- `projects-with-sessions-fetch` 相关测试：`isMainAgentWorkspace` 标记（mock realpath）。

前端：
- `taskStatus.test.ts`：PRIORITY_META / LABEL_META 完整性。
- `projectOptions.test.ts`：过滤 + 收藏优先 + 助手选项（纯函数）。
- deadline 计算单测。

## 错误处理

- 非法 priority/deadline/label → 400 + 明确 message。
- operator 任务用非 claude executor → 400。
- operator workspace 无法创建/注册 → 抛 AppError（500），前端提示创建失败。
- 前端 create 失败沿用现有 console.error + 保持表单（不清空）。

## 范围外

- 看板列内按优先级排序（用户选了「表单+卡片+详情」，不做列排序）。
- 侧边栏项目排序（不动）。
- operator 任务自动 verdict（跳过）。
