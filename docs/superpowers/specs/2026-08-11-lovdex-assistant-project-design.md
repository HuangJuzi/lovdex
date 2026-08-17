# Lovdex 助手（特殊 Project）设计

- 日期：2026-08-11
- 状态：设计待评审
- 相关：`docs/superpowers/specs/2026-08-10-operator-agent-design.md`、`docs/superpowers/specs/2026-08-08-daemon-design.md`

## 1. 背景与目标

「助手」（operator agent）本质上是一个跑在 operator 工作区（默认 `~/.lovdex/operator-workspace`，env `LOVDEX_OPERATOR_WORKSPACE` 可覆盖）里的特殊 Claude session。它有两个问题：

1. **命名不一致**：侧边栏顶部叫「助手」，任务 UI（`TaskBoard`/`TaskCard`/`TaskDetail`）却叫「Lovdex 助手」/「助手」。
2. **工作区项目重复出现**：operator 工作区同时作为普通项目登记在 `projects` 表里（`createAppSession` 会自动 `createProjectPath`），于是在侧边栏「下面的 Project 列表」里出现一个 `operator-workspace` 项目 + 它的全部会话，与顶部「助手」的会话记录重复。当前环境该工作区有 60 个会话（仅 1 个 `is_operator=1`，其余 59 个是 `is_operator=0` 的历史残留）。

目标：

- 侧边栏入口改名为 **Lovdex助手**，并统一任务 UI 的命名（去空格）。
- 把 Lovdex助手 当作一个**特殊 Project**：其工作目录项目**不出现在侧边栏 Project 列表**，会话不重复出现（只在 Lovdex助手 会话记录里）。
- Lovdex助手 的会话折叠改为**整行折叠**，与普通 Project 的折叠方式一致。
- 提供 operator 工作区里 `is_operator=0` 残留会话的**清理机制**（启动时自动硬删，配合日志）。

## 2. 关键设计决策

### 2.1 命名
统一为 **Lovdex助手**（用户指定，无空格）。替换侧边栏「助手」及任务 UI 里现有的「Lovdex 助手」/「助手」。

### 2.2 隐藏工作区项目：后端打标 + 前端渲染层过滤（推荐方案 A）
- 后端在 `/api/projects` 返回的项目打 `isOperatorWorkspace: true`（复用现有 `isMainAgentWorkspace` 的成熟模式）。
- 前端只在**侧边栏项目列表渲染**时过滤掉该标记；全局 `projects` state 保留其会话数据，保证 `/session/:id` 路由解析（`useProjectsState` 靠遍历 projects 定位 session → selectedProject）不受影响，`AssistantPanel`/会话打开仍正常。
- 不选方案 B（后端彻底排除 + 抑制 websocket upsert），因为会破坏 operator 会话的 `selectedSession` 解析，改动大、风险高。

### 2.3 折叠：整行折叠（像 Project）
- 点击「Lovdex助手」整行切换会话列表展开/收起（右侧 chevron），不再独立跳转（避免整页 reload 丢失折叠状态）。
- 会话列表缩进 + `border-l`，视觉对齐 `SidebarProjectSessions`。
- 会话行点击打开对应 `/session/:id`；`[+]` 新建、`[⚙]` 进设置。
- 折叠状态沿用现有 localStorage 机制（`lovdex:assistant:sessions-collapsed`）。

### 2.4 命名范围确认
用户已确认：清理机制采用**启动时自动硬删**；命名统一为无空格的 **Lovdex助手**。

## 3. 后端改动（lovdex-backend）

### 3.1 打 `isOperatorWorkspace` 标记
`server/modules/projects/services/projects-with-sessions-fetch.service.ts`：
- 引入 `getOperatorConfig`（`@/modules/operators/operator.config.js`，无循环依赖）。
- `ProjectListItem` 增加 `isOperatorWorkspace?: boolean`。
- 增加一个带缓存的 `resolveOperatorWorkspaceRoot()`（仿现有 `mainAgentRootReal` 缓存），返回 operator 工作区 realpath。
- `getProjectsWithSessions`：对每个项目，`isOperatorWorkspace = (realpath(projectPath) === operatorWorkspaceRoot)`。
- `getArchivedProjectsWithSessions`：对每个项目同样计算 `isOperatorWorkspace`（同一判定逻辑）。

### 3.2 清理残留会话
新增 `server/modules/operators/operator-cleanup.service.ts`，导出
`cleanOperatorWorkspaceLegacySessions(): Promise<{ removed: number; sessionIds: string[] }>`：
- 取 `getOperatorConfig().workspace`；为空则直接返回 `{ removed: 0, sessionIds: [] }`。
- 查 `sessionsDb` 得到该路径下 `is_operator = 0` 的会话。
- 逐个经 `sessionsService.deleteOrArchiveSessionById(id, { force: true, deletedFromDisk: true })` 硬删（DB 行 + jsonl 文件）。
- 幂等、仅作用于当前工作区路径，打印 `removed` 数量（含每个被删 id）。

`server/modules/database/repositories/sessions.db.ts`：
- 新增 `getNonOperatorSessionsByProjectPath(projectPath): SessionRow[]`（`is_operator = 0`）。

`server/index.js` `startServer()`：
- 在 `initializeDatabase()` 之后调用清理函数，`try/catch` 包裹，启动日志输出结果。

> ⚠️ 破坏性：硬删不可恢复。用户已确认采用启动自动删。日志会列出被删会话便于排查。

## 4. 前端改动（lovdex-cli）

### 4.1 类型
`src/types/app.ts`：`Project` 增加 `isOperatorWorkspace?: boolean`。

### 4.2 侧边栏过滤工作区项目
`src/components/sidebar/hooks/useSidebarController.ts`：
- 在 `sortedProjects` memo（`runningProjects`/`filteredProjects` 均由它派生）里过滤掉 `p.isOperatorWorkspace` 的项目。
- 全局 `projects` 不变，保证会话路由解析正常。

### 4.3 重做 SidebarAssistant（整行折叠 + 改名）
`src/components/sidebar/view/subcomponents/SidebarAssistant.tsx`：
- 文案：「助手」→「Lovdex助手」；tooltip/aria-label/确认弹窗同步。
- 桌面：`Button variant="ghost"` 行 = Lovdex助手 名 + hover 露出的 `[+]`/`[⚙]` + 常驻 chevron（收起 `ChevronRight` / 展开 `ChevronDown`），与 `SidebarProjectItem` 桌面行一致。点击整行 `toggleCollapsed()`。
- 移动端：卡片式一行 + 下方会话列表，行为一致。
- 会话列表：缩进 `ml-3 border-l border-border pl-3`，对齐 `SidebarProjectSessions`；保留现有 `renderRow`（点击打开、hover 重命名/删除）。
- 移除独立「会话记录」折叠头（改由整行折叠承担）。
- 组件命名的 OPERATOR 常量文案（`新建助手会话`、`Operator 助手` 等）同步改为 Lovdex助手。

### 4.4 任务 UI 命名统一 + 过滤
- `src/components/tasks/TaskBoard.tsx`：`🤖 Lovdex 助手` → `🤖 Lovdex助手`。
- `src/components/tasks/TaskCard.tsx`：`🤖 助手` → `🤖 Lovdex助手`。
- `src/components/tasks/TaskDetail.tsx`：`🤖 Lovdex 助手` → `🤖 Lovdex助手`。
- `src/components/tasks/projectOptions.ts`：`taskFormProjects` 的过滤追加 `!p.isOperatorWorkspace`（任务表单已有显式助手选项，避免工作区项目重复出现）。

### 4.5 其它文案
- `src/components/operators/OperatorSettingsPage.tsx`：描述「关闭后侧边栏不显示「助手」入口。」→ Lovdex助手。
- `src/components/operators/AssistantPanel.tsx`：`正在启动助手…` → `正在启动 Lovdex助手…`。

## 5. 测试

- 后端：`operator-cleanup.service` 单测（内存库：建工作区下 `is_operator=0/1` 会话，断言只清 `is_operator=0` 且删除文件）；`getProjectsWithSessions` 对工作区项目打标 `isOperatorWorkspace=true` 的测试。
- 前端：侧边栏过滤 `isOperatorWorkspace` 的测试（补充/扩展现有 `projectOptions.test.ts` 或新增）；命名改动属文案，人工核对。

## 6. 风险与权衡

- **破坏性清理**：启动自动硬删工作区 `is_operator=0` 残留会话。已获用户确认；日志兜底可排查。
- **会话路由依赖**：保留工作区项目在全局 `projects`（只做渲染层过滤）是刻意为之，避免 `/session/:id` 解析回归；代价是项目计数/会话搜索仍可能带到它（不在本次范围）。
- **命名原子性**：跨多文件（sidebar + 3 个任务组件 + settings + panel）统一，需全局 grep 复核无遗漏。

## 7. 验收标准

1. 侧边栏顶部显示「Lovdex助手」，项目列表不再出现 `operator-workspace` 工作区项目。
2. 点击 Lovdex助手 整行可展开/收起其会话记录，样式与 Project 折叠一致；会话不重复出现在项目列表。
3. 服务启动日志打印清理的 `is_operator=0` 残留会话数量；工作区仅剩 `is_operator=1` 会话。
4. 任务 UI / 设置页 / 助手面板文案统一为「Lovdex助手」。