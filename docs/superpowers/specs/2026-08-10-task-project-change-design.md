# 任务修改所属项目 + 清空会话 — 设计文档

> 状态：待审 · 2026-08-10
> 定位：积压/待做任务支持修改所属项目；修改项目时若已有关联会话，删除该会话（DB 行 + 磁盘 transcript）并解绑任务。

---

## 1. 背景与目标

任务面板里，积压（backlog）和待做（todo）的任务目前**创建后无法改项目**：`TaskDetail` 属性区的「所属项目」是只读文本（`TaskDetail.tsx:323-325`），后端 `updateTask` 也不接受 `projectPath`。

用户可能建错项目，或想换个仓库推进同一件事。任务一旦执行过，`tasks.session_id` 关联了一个会话（内容在磁盘 JSONL，`sessions.jsonl_path` 指向它）；换项目后旧对话的上下文不再适用——项目路径是发给 agent 的 cwd，旧会话是另一个工作目录的历史。

**目标**：积压/待做任务可在详情页修改所属项目；修改时若已关联会话，**硬删除该会话**（DB 行 + 磁盘 transcript 文件）并把 `task.session_id` 置空。下次执行会在新项目里创建全新会话。

**不做**（刻意排除）：
- 不改 `tasks` / `sessions` 表结构。
- 不做跨项目执行（in_progress/in_review/done 不允许改项目）。
- 不做批量改项目、不做 TaskBoard 卡片内快捷改项目。
- 不发新的 WS 事件（见 §4 理由）。

---

## 2. 产品方案

### 2.1 交互

- **入口**：`TaskDetail` 属性区「所属项目」。
- **可编辑条件**：`task.status ∈ {backlog, todo}` → 渲染 `<select>`（项目下拉，选项与 TaskBoard 创建表单一致，重名显示 `名称 — 路径`）；其他状态 → 保持现有只读文本。
- **修改流程**：
  1. 用户选中新项目。
  2. 若 `task.session_id` 非空 → `window.confirm('修改项目将删除当前会话及其全部对话记录，此操作不可恢复。是否继续？')`；取消则回退选择。无会话时不弹窗。
  3. 调 `api.tasks.update(taskId, { projectPath })`（现有 PATCH 端点扩展）。
  4. 成功 → 用响应刷新页面任务；失败 → 回退选择 + console.error。

### 2.2 后端语义

- `PATCH /api/tasks/:taskId` 增加 `projectPath` 字段更新；与 `status` 互斥规则保持一致（不能同请求改状态又改字段）。
- 仅 `backlog` / `todo` 允许改项目（服务端强制校验，UI 只读是软约束）。
- 新项目必须存在（`projects` 表），否则 `404 PROJECT_NOT_FOUND`。
- 目标项目与原项目相同 → no-op：不写库、不发事件，直接返回当前任务行（前端下拉已显示该值，无需刷新）。
- 有关联会话 → 硬删除会话：`sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true })`（删 DB 行 + 磁盘 JSONL），并置 `session_id = null`。
- 会话行若已不存在（理论上不应发生）→ 容错：不中断，照常解绑改项目。

---

## 3. 架构与数据流

### 3.1 改动文件

**后端** `lovdex-backend/`：

| 文件 | 改动 |
|---|---|
| `server/modules/database/repositories/tasks.db.ts` | `updateTask` 的 updates 类型加 `projectPath?: string`，SET 子句加 `project_path = ?` |
| `server/modules/tasks/services/tasks.service.ts` | `updateTask` 改为 `async`；处理 `projectPath`：状态校验 → 项目存在校验 → 删会话（注入依赖）→ 解绑 → 落库 → 广播 `task_upserted` |
| `server/modules/tasks/tasks.routes.ts` | PATCH 的 `hasFieldUpdates` 加 `'projectPath'`；读 `body.projectPath` 进 updates；`await` service |
| `server/index.js` | `createTasksService` opts 注入 `deleteSessionHard` |

**前端** `lovdex-cli/`：

| 文件 | 改动 |
|---|---|
| `src/components/tasks/TaskDetail.tsx` | 挂载时 `api.projects()` 拉项目列表；属性区「所属项目」按状态渲染 select / 只读文本；变更处理（确认弹窗 → PATCH → 刷新/回退） |

### 3.2 依赖注入

`tasks.service.ts` 的 `opts.deps` 增加可选 `deleteSessionHard?: (sessionId: string) => Promise<void>`。默认实现（生产）：

```ts
deleteSessionHard: (sessionId) =>
  sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true })
    .then(() => undefined)
    .catch((err) => {
      // 会话行不存在（SESSION_NOT_FOUND）不阻断改项目；其余错误抛出。
      if (err?.code === 'SESSION_NOT_FOUND') return;
      throw err;
    })
```

默认实现延迟引入 `sessionsService`（函数体内 import 或注入），避免单元测试拉进 sessions 模块；测试用 stub 捕获调用。

### 3.3 数据流

```
用户选新项目 → (有会话则 confirm) → PATCH /api/tasks/:taskId { projectPath }
  → tasks.routes 校验 → tasksService.updateTask (async)
      → getTask 读当前行
      → status ∈ {backlog,todo}? 否 → 400
      → projectsDb.getProjectPath 存在? 否 → 404
      → 与当前 project_path 相同? 是 → 跳过删除，照常更新
      → session_id 非空 → deleteSessionHard(session_id)（DB 行 + 磁盘文件删除）
      → updates 折叠 sessionId: null → tasksDb.updateTask（project_path + session_id = NULL）
      → emit task_upserted → WS 广播
  → 前端 setTask(响应) 刷新
```

### 3.4 错误处理

| 场景 | 行为 |
|---|---|
| 非 backlog/todo 改项目 | 400 `PROJECT_CHANGE_NOT_ALLOWED` |
| 目标项目不存在 | 404 `PROJECT_NOT_FOUND` |
| 目标项目 == 当前项目 | no-op：不写库、不发事件，返回当前行 |
| 会话行缺失 | 容错继续（SESSION_NOT_FOUND 吞掉） |
| 删会话失败（其他错误） | 抛错，前端回退选择 |
| 任务不存在 | 404 `TASK_NOT_FOUND`（沿用现有逻辑） |

---

## 4. 会话删除的同步说明（为何不发新 WS 事件）

硬删除会话后，打开的侧栏理论上还显示该会话。但：

- `/task/:taskId` 路由只渲染 `<TaskDetailPage/>`，**侧栏不在该页面挂载**。
- 侧栏所在的路由（`/`、`/session/:sessionId` → `AppContent`）在挂载时 `fetchProjects()` 全量刷新项目/会话。
- 删除会话后用户若回到主页，`AppContent` 重新挂载即拿到最新列表。

因此 v1 不发 `session_deleted` WS 事件；多标签页残留的过期会话为已知限制，接受。

---

## 5. 测试

**`server/modules/tasks/tests/tasks.service.test.ts`**（扩展现有用例，stub `deleteSessionHard` 注入 deps）：

- backlog 任务改项目成功 → 返回行带新 `project_path`。
- todo 任务改项目成功（会话删除 + 解绑）→ `deleteSessionHard` 被调用、`sessionId: null` 写入。
- 无会话任务改项目 → `deleteSessionHard` 不被调用。
- in_progress / in_review / done 改项目 → 抛 `PROJECT_CHANGE_NOT_ALLOWED`。
- 目标项目不存在 → 抛 `PROJECT_NOT_FOUND`，不删会话。
- 目标项目 == 当前项目 → 不删会话。
- 会话行缺失（stub 抛 SESSION_NOT_FOUND）→ 不中断，成功返回。

前端手测清单：backlog/todo 显示下拉；其他状态只读；有会话时弹确认、取消回退、确认后项目与「打开会话」按钮状态更新；无会话不弹窗直接改。

---

## 6. 边界与后续

- v1 只做 `backlog`/`todo`。若后续要支持 in_progress 换项目（即"跨项目重跑"），需单独设计会话迁移语义，不在本次范围。
