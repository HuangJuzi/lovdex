# Lovdex 任务面板 — 设计文档

> 状态：设计定稿 · 2026-08-07
> 定位：给 lovdex 的编码会话加一层"规划层"，复刻 multica 的"状态即真相"，但不搬它的办公骨架。

> **⚠ 2026-08-11 已演进为两层状态模型**：本文的「固定 5 枚举（积压/待办/进行中/评审中/已完成）」已废弃。
> 现行为：
> - **第一层 `status`（4 列）**：`待办(todo) / 进行中(in_progress) / 评审(in_review) / 完成(done)`，`backlog` 并入 `todo`。
> - **第二层 `sub_status`（卡片左下角标签）**：`running/failed/waiting_answer/waiting_plan/waiting_approval/pending_acceptance/done/only_plan/needs_review/blocked`，其中持久化子集为 `failed/done/only_plan/needs_review/blocked`。
> - AI 判定写 `sub_status`：`done` 留评审列（已完成标签），`only_plan/needs_review/blocked` 移回进行中列。
> 详见 `docs/superpowers/specs/2026-08-11-unified-task-status-design.md` 与 `docs/task-state-flow.html`。

---

## 1. 背景与目标

lovdex 是 Claude Code / Codex 编码会话的控制台（执行中心）。会话是第一等公民，但缺少"规划层"——没有跨会话的任务视图，无法回答"我在推进哪些事、卡在哪一步、哪个需要我出手"。

**目标**：加一个**任务面板**，让任务与编码会话一一对应，任务状态自动反映会话的真实进展。让用户像管理一支混合团队一样管理手头的编码工作。

**不做的**（刻意排除，避免过度建制）：
- 不做 squads / stage barrier / inbox / 多 agent 调度的复杂机制（那是 multica 的"办公骨架"）。
- 不做可配置工作流状态机（状态是固定 5 枚举，自由切换，服务端只校验枚举，不锁转换图）。

---

## 2. 产品方案

### 2.1 一句话定位

> 你规划，agent 执行，面板是两者之间的共享契约——状态自动反映会话的真实进展。

### 2.2 核心机制：双向联动 + 实时瓶颈信号

```
状态 → 执行        todo 上点"开始" → 自动建会话、注入任务标题/描述、跳到会话页
执行 → 状态        session running → in_progress
                   session completed → in_review
                   session failed（且无其他活跃会话）→ 回滚 todo
                   session aborted → 不动（用户可续跑）
实时瓶颈           会话 permission.required → 卡片 amber"等你批准"（状态仍 in_progress）
手动兜底           任何状态都可在看板/详情手动改（不锁死）
```

### 2.3 五状态语义

| 状态 | 含义 | 触发方 |
|---|---|---|
| **积压** Backlog | 记下了，还没排队 | 手动 |
| **待做** Todo | 可以开工，点"开始"它就跑 | 手动 |
| **进行中** In Progress | 有一个会话正在真实地干这件事 | 引擎自动 |
| **评审中** In Review | 会话交付了，等你验收 | 引擎自动 |
| **已完成** Done | 你确认过了 | 手动 |

失败回滚沿用 multica 的守卫式逻辑：**只有失败的是该任务最后一个活跃会话时才回滚**，否则留在原地继续跑。

### 2.4 项目归属（决策 A）

- 每个任务**必属且仅属一个 project**（创建时必选，默认取侧边栏当前项目）。
- **全局看板** + 卡片右上角**项目徽标**（彩色圆点 + 项目名）+ 看板顶部**项目筛选器**。
- 详情页显眼位置展示所属项目。

### 2.5 执行引擎归属

- 任务创建时选定 `executor_provider`（claude / codex）与 `executor_model`，**持久化在任务上**（multica assignee 做法），开工时直接用，不临时选。

### 2.6 用户完整流程

1. **建任务**：选项目 + 执行引擎/模型 → 默认落积压。
2. **开工**：待做上点"开始" → 自动建会话、注入任务上下文、跳会话页。
3. **自动推进**：会话 running → 进行中；completed → 评审中；failed（最后活跃会话）→ 回滚待做。
4. **等你出手**：会话卡在权限请求 → 卡片 amber"等你批准" + 去批准按钮。
5. **验收收尾**：评审中上点"标记完成" → 已完成。
6. **回到现场**：随时"打开会话"跳回干活页面。

### 2.7 设计思路

1. **看板是计划的层，会话是执行的层，两层一体**——每个进行中任务背后都指着一个活会话。
2. **机器的进度机器管，人的判断人来做**——唯一不能外包的是最终验收。
3. **状态即真相，不是装饰**——状态从执行现场自动读出。
4. **失败不静默**——会话挂了任务自动回池子，不卡死。
5. **一个任务绑定一个引擎**——引擎在创建时定死，一致可预期。
6. **等你批准是最重要的瓶颈信号**——进行中列里卡住进度的几乎都是"等人类批准"，面板把它顶出来。

---

## 3. 数据模型

新表 `tasks`（better-sqlite3，FK 到 `projects.project_path`）：

```sql
CREATE TABLE IF NOT EXISTS tasks (
    task_id           TEXT PRIMARY KEY,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'backlog'
                      CHECK (status IN ('backlog','todo','in_progress','in_review','done')),
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,          -- 关联执行会话；ON DELETE SET NULL
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
```

说明：
- `session_id` 是单向关联（任务 → 会话），一个任务同一时刻绑定一个活跃会话。
- `executor_model` 记录模型名（如 `Sonnet 4.6`），纯展示，不参与校验。
- 状态列 CHECK 约束兜底；`executor_provider` CHECK 约束兜底。

---

## 4. 后端改动（lovdex-backend/）

### 4.1 数据层

| 文件 | 改动 |
|---|---|
| `server/modules/database/schema.ts` | 新增 `TASKS_TABLE_SCHEMA_SQL`，加入 `INIT_SCHEMA_SQL` |
| `server/modules/database/migrations.ts` | 存量库迁移：`if (!tableExists(db,'tasks')) db.exec(CREATE TABLE ...)` |
| `server/modules/database/repositories/tasks.db.ts` | 新建 `tasksDb`：CRUD + `listTasks({projectPath,status})` + `moveTask`（before/after 锚点算 position）+ `getTaskBySessionId` + `linkSession/clearSession` + `updateTaskStatus` |

### 4.2 业务模块 `server/modules/tasks/`

| 文件 | 内容 |
|---|---|
| `services/tasks.service.ts` | `VALID_TASK_STATUSES` + `STATUS_ORDER`；`applyStatusChange(taskId, status, actor)`（统一写状态 + 广播 WS）；`onSessionStatus(sessionId, state)`（联动核心）；`onSessionApproval(sessionId, pending)`（批准联动）；`startExecution(taskId)` |
| `tasks.routes.ts` | Express Router（`asyncHandler` + `AppError` 模式） |
| `index.ts` | 导出 router + `tasksService` |

REST 路由：

```
GET    /api/tasks?projectPath=&status=
POST   /api/tasks
GET    /api/tasks/:taskId
PATCH  /api/tasks/:taskId              （手动改 status / 手动绑 session）
POST   /api/tasks/:taskId/start-execution   → { sessionId }
POST   /api/tasks/:taskId/move         { status, beforeId?, afterId? }
DELETE /api/tasks/:taskId
```

### 4.3 联动接线（关键）

- `server/modules/websocket/services/chat-run-registry.service.ts`：在既有 `broadcastSessionStatus` 两处调用旁加一行 `tasksService.onSessionStatus(...)`（`:329` running / `:199-200` completed·failed）。
- `server/modules/websocket/services/chat-websocket.service.ts`：在 permission.required 转发处调用 `tasksService.onSessionApproval(sessionId, pending)`。
- 模块边界走 `@/modules/tasks/index.js` 出口（符合 eslint-boundaries 约束）。

### 4.4 服务端接线

- `server/index.js`：`app.use('/api/tasks', authenticateToken, tasksRoutes)`。

### 4.5 WS 事件 broadcast

- `applyStatusChange` / `onSessionApproval` 广播 `task_upserted`（完整 task 对象 + 可选 `approval` 标记），复用 `connectedClients` + `WS_OPEN_STATE`（照抄 `broadcastSessionStatus` 写法）。

---

## 5. 前端改动（lovdex-cli/）

| 文件 | 内容 |
|---|---|
| `src/utils/api.js` | `api.tasks`：`list/create/get/update/updateStatus/startExecution/move/delete` |
| `src/types/app.ts` | `Task`/`TaskStatus` + 状态元数据（label/颜色/图标）+ 项目徽标数据 |
| `src/App.tsx` | 路由 `/tasks`（看板）、`/task/:taskId`（详情），AppContent shell 内 |
| `src/components/tasks/TaskBoard.tsx` | 5 列看板 + 项目筛选器 + 新建表单（项目/引擎/模型选择器） |
| `src/components/tasks/TaskCard.tsx` | 进度环图标 + 标题 + 项目徽标 + 引擎/模型标签 + 会话指示 + 按需按钮（开始 / 打开会话 / 标记完成 / 去批准） |
| `src/components/tasks/TaskDetail.tsx` | 可编辑字段 + 状态选择器 + 打开会话/去批准 + 所属项目 + 删除 |
| `src/components/tasks/index.ts` | 组件出口 |
| `src/hooks/useTasks.ts` | `tasks/refresh/createTask/startExecution` + WS 订阅 patch |
| `src/contexts/WebSocketContext.tsx` | 板面订阅 `task_upserted` |
| `src/components/chat/` | 发送逻辑：按 sessionId 反查关联任务，新会话自动发送任务上下文 |
| 侧边栏 | "任务面板"入口 |

看板卡片按状态渲染的会话动作：

| 会话状态 | 卡片显示 | 按钮 |
|---|---|---|
| 未开始 | — | ▶ 开始执行 |
| running | 蓝呼吸灯 · 运行中 | 打开会话 |
| **approval** | **琥珀呼吸灯 · 等你批准** | **去批准** + 打开会话 |
| review | 紫 · 待你验收 | 标记完成 + 打开会话 |
| done | — | （只读） |

---

## 6. 联动细节（含批准）

权限待批准挂在 **provider 原生会话 id**（`run.providerSessionId`）下，非 app 会话 id。查询链路：

```
task.session_id → sessionsDb.getSessionById() → provider_session_id → getPendingApprovalsForSession()
```

复用 `sessions.db.ts` 已有的 `provider_session_id` 映射，无新坑。

**批准/拒绝后**：`chat.permission-response` 处理处再广播 `task_upserted` + `approval: { pending: false }`，卡片恢复"运行中"。

---

## 7. 测试（node:test）

| 测试 | 位置 |
|---|---|
| tasksDb CRUD + 状态/引擎校验 + move position | `tasks/tests/tasks.db.integration.test.ts` |
| 联动迁移机（running/completed/failed + 守卫 + approval） | `tasks/tests/execution-linkage.test.ts` |
| 路由鉴权 + 非法状态 400 | `routes/tests/tasks.routes.test.ts` |
| 前端看板 + 开始执行 + WS patch + 批准态 | `src/components/tasks/taskBoard.test.ts` |

---

## 8. 里程碑（3 个 PR）

1. **PR-A 后端数据 + API**：schema/迁移/tasksDb/service/routes/接线 → `curl /api/tasks` 可用。
2. **PR-B 后端联动 + WS**：chat-run-registry 钩子 + chat-websocket 批准钩子 + `task_upserted` + `startExecution` + 联动测试 → "会话跑完任务自动进评审、卡权限自动亮等你批准"成立。
3. **PR-C 前端**：类型/api/路由/看板/详情/会话入口/WS 订阅/批准态。

---

## 9. 参考链接

- 效果图：`docs/task-board-mockup.html`
- 产品介绍（用户向）：`docs/task-board-intro.html`
- 上游对照：multica issue 状态体系（`server/migrations/001_init.up.sql` 的 `issue.status` CHECK、`server/internal/handler/issue.go` 的 `validIssueStatuses`、`server/cmd/server/runtime_sweeper.go` 的守卫式失败回滚）