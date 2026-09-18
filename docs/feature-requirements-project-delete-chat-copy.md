# 功能需求描述：Project 删除 与 Chat 对话拷贝

> 目的：为复刻本项目（Lovdex）的对应功能提供需求规格。内容基于当前代码实现整理（2026-08-19），每条需求标注了实现位置，便于对照。
> 技术背景：monorepo（`backend/` Node/Express + better-sqlite3，`web/` React/Vite）；对话内容不入库，存于 session 转录文件（jsonl），由 provider CLI（Claude Code 等）维护。

---

## 一、Project 的删除

### 1. 功能概述

侧边栏项目列表中，每个项目提供删除入口。删除分为**两档**，由用户在确认弹窗中自主选择：

| 档位 | 语义 | 数据影响范围 |
|---|---|---|
| **归档（Archive project）** | 软删除，仅从列表隐藏 | 仅将 projects 行置 `isArchived=1`，不动会话、任务、磁盘文件 |
| **永久删除（Delete all data permanently）** | 硬删除，清除本项目产生的应用数据 | 删除 projects 行 + sessions 行 + tasks 行（FK 级联）+ 会话转录 jsonl 文件 + 项目上传临时目录 |

**红线**：两种模式都**不删除用户的项目源码目录**；remote 项目**不删除远端主机上的任何文件**。

### 2. 用户故事与交互流程

1. 用户在侧边栏项目条目上点击删除按钮（垃圾桶图标，`title` 提示 "Remove project from sidebar (Delete)"）。
   - 实现：`web/src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx:284-292`（移动端）、`:463-472`（桌面端）；点击需 `stopPropagation` 避免触发项目选中。
2. 弹出自定义确认弹窗（非 `window.confirm`）：
   - 标题 "Remove Project"，正文确认文案 + 项目名；
   - 若项目下含会话，显示会话数量提示（"This project contains N conversations"）；
   - 三个操作：**Archive project** / **Delete all data permanently** / **Cancel**。
   - 实现：`web/src/components/sidebar/view/subcomponents/SidebarModals.tsx:61-113`；入口状态管理 `useSidebarController.ts:628-672`。
3. 删除进行中：该项目整行置灰且禁止交互（`opacity-50 pointer-events-none`），防止重复点击。
4. 删除成功后：
   - 前端**本地移除**列表项，不重新拉取全量列表；
   - 若被删项目是当前选中项目，则清空选中态并导航回首页 `/`。
   - 实现：`web/src/hooks/useProjectsState.ts:1115-1126`。
5. 删除失败：解析后端错误体 `error.message` 并 `alert` 提示；网络异常提示通用错误文案。

### 3. 接口规格

```
DELETE /api/projects/:projectId[?force=true]
```

- 鉴权：需登录 token（路由挂在 `authenticateToken` 之后）。
- `force` 缺省或任何非字面量 `true` 的值 → 归档；`force=true` → 永久删除。
- 前端封装：`web/src/utils/api.js:171-178` `deleteProject(projectId, hardDelete=false)`。
- 路由：`backend/server/modules/projects/projects.routes.ts:325-336`。
- 核心服务：`backend/server/modules/projects/services/project-delete.service.ts` `deleteOrArchiveProject(projectId, force)`。

### 4. 永久删除的执行顺序与数据范围

硬删除按以下顺序执行（`project-delete.service.ts:59-77`）：

1. **删除会话转录文件**：按 `jsonl_path` 逐个 unlink 该项目全部会话的 jsonl 文件（路径去重；文件不存在吞 ENOENT，其他错误仅 warn 继续）。
2. **删除上传临时目录**：`<project>/.lovdex-tmp`（尽力而为，异常仅 warn）。
3. **删除 sessions 表记录**：`DELETE FROM sessions WHERE project_path = ?`（显式先删，避免 FK `ON DELETE SET NULL` 留下挂空行）。
4. **删除 projects 行**；**tasks 表通过外键 `ON DELETE CASCADE` 级联物理删除**（schema 定义 `backend/server/modules/database/schema.ts:161-191`）。
5. **刷新 remote 项目内存索引**（path→host 映射），避免后续请求路由到已删除的绑定（`projects.routes.ts:333`）。

明确**不做**的事：

- 不删 provider 侧的存储（如 `~/.claude/projects/<enc>` 目录、`store.db`）；
- 不删用户源码目录；
- 不清理 `scheduled_tasks` 表中该项目的定时任务（无外键，删除后成为孤儿记录——**已知遗留问题，复刻时应补充级联清理**）。

### 5. 业务约束与边界

| 场景 | 当前行为 | 复刻建议 |
|---|---|---|
| 项目下有运行中的任务/会话 | **无保护**，可直接删除；任务行随 FK 级联物理删除 | 建议增加运行中检查或至少弹窗警示 |
| projectId 不存在 | 返回 404 `{code: 'PROJECT_NOT_FOUND'}` | 保持 |
| 重复归档 | 幂等（再置一次 `isArchived=1`） | 保持 |
| 重复硬删 | 第二次返回 404 | 保持 |
| 硬删后磁盘仍有其他 jsonl 残留 | 同步器下次扫描会把该路径重建为 `is_explicit=0` 的隐藏行，**不会回到侧边栏列表**（列表只取 `is_explicit=1` 且未归档） | 保持该"自动发现行不进列表"语义 |
| 归档的项目路径产生新会话 | 同步器自动 reactivate（`isArchived` 复位为 0） | 保持，见 `projects.db.ts` `createProjectPath` 的 `reactivated_archived` outcome |
| remote 项目 | 删除/归档只作用于本机 DB 与本机转录文件，并刷新 remote 索引 | 保持 |
| 并发删除 | 前端用 `deletingProjects` Set 防同项目双击；后端 better-sqlite3 单连接串行，无乐观锁 | 保持前端防重即可 |

### 6. 错误处理

- 统一错误格式：`{success: false, error: {code, message}}`，由全局错误中间件输出（`backend/server/index.js:1612-1627`）。
- 磁盘清理失败不阻断删除流程（转录文件/临时目录均为尽力而为）。
- 前端失败反馈为 `alert`（复刻时可升级为 toast）。

### 7. 测试现状（复刻时的测试清单参考）

已有：
- 归档/恢复与列表过滤：`projects-with-sessions-explicit.test.ts`、`projects.db.integration.test.ts`、`projects-db.remote-bindings.test.ts`。
- **缺口**：`deleteOrArchiveProject`、jsonl 清理路径、前端删除流程均无测试。

复刻建议补充：归档幂等、硬删级联 tasks、sessions 行与 jsonl 文件清理、404、force 参数容错、scheduled_tasks 孤儿清理（若采纳建议）。

---

## 二、Chat 对话的拷贝

「拷贝」在本项目中包含两类能力：**(A) 单条消息复制到剪贴板**（纯前端）与 **(B) 会话级克隆**（fork/branch/rewind，需后端 + provider SDK）。复刻时可按需要取舍。

### A. 消息复制到剪贴板

#### A.1 功能概述

聊天气泡上提供复制按钮，将消息文本写入系统剪贴板：

- **用户消息**：复制纯文本（Markdown 语法被剥离）。
- **Assistant 消息**：默认复制 **Markdown 原文**，可通过按钮旁的下拉切换为**纯文本**。
- **思考（thinking）内容**：折叠的思考段有独立复制按钮；assistant 主消息的复制**不包含** thinking。
- **代码块**：渲染后的代码块右上角 hover 出现独立 "Copy" 按钮，复制原始代码文本。

#### A.2 交互细节

| 需求点 | 规格 | 实现位置 |
|---|---|---|
| 按钮形态 | 复制图标 + 格式标签（assistant 显示 "MD"/"TXT"，10px 大写） | `web/src/components/chat/view/subcomponents/MessageCopyControl.tsx` |
| 挂载位置 | 消息气泡底部、时间戳左侧 | `MessageComponent.tsx:107-108`（user）、`:399-400`（assistant）、`:331-332`（thinking） |
| 显示条件 | 内容非空；assistant 的工具响应消息中，Bash/Edit/Write/ApplyPatch 四类**不显示**复制按钮 | `MessageComponent.tsx:50,71-75`（`COPY_HIDDEN_TOOL_NAMES`） |
| 成功反馈 | 图标变对勾、提示变 "Message copied"，**2 秒后自动复原** | `MessageCopyControl.tsx:144-156`（`COPY_SUCCESS_TIMEOUT_MS=2000`） |
| 失败反馈 | **静默**（无 toast）——复刻时建议补失败提示 | 同上 `:147` |
| 格式切换下拉 | 仅 assistant 消息有；用 `createPortal` 渲染到 `document.body` 逃逸气泡 `contain: paint` 裁剪；靠近视口底部时菜单自动向上翻转 | `MessageCopyControl.tsx:63-78,205-251` |
| 代码块复制 | hover 显示 "Copy"/"Copied"，2 秒复原 | `web/src/components/chat/view/subcomponents/Markdown.tsx:180-222` |

#### A.3 内容格式规则

- **Markdown→纯文本转换**（`MessageCopyControl.tsx:17-39`）：代码块先占位后还原（保留代码内容）、去行内代码反引号、图片/链接转为文字、去引用/标题/列表符号、去粗斜体/删除线/HTML 标签、压缩多余空行。
- **默认值**：assistant → markdown（原样）；user → text（经转换）。
- **不参与复制的内容**：图片与附件（只复制文本）、thinking（不进 assistant 主消息复制）、usage-limit 提示经格式化后复制。
- 工具消息复制其 `displayText`；上述四类写操作工具的响应不提供给复制按钮。

#### A.4 剪贴板技术方案

工具函数 `web/src/utils/clipboard.ts` `copyTextToClipboard(text): Promise<boolean>`：

1. 主路径：`navigator.clipboard.writeText(text)`（需安全上下文/HTTPS）。
2. 降级：`navigator.clipboard` 不可用（如 HTTP 局域网访问）或调用失败时，创建隐藏 textarea + `document.execCommand('copy')`。
3. 返回 boolean 表示成败；上层可据此给反馈。

同一工具函数被多处复用：代码块复制、Bash 命令展示复制、单行命令复制。

### B. 会话克隆（Fork / Branch / Rewind）

#### B.1 功能概述

通过聊天输入框的 slash 命令触发会话级复制（侧边栏会话列表**没有**"复制会话"按钮，只有重命名/删除）：

| 命令 | 语义 |
|---|---|
| `/fork` | 克隆整个会话，生成新会话 |
| `/branch` | 选择某个历史 turn，从该点克隆出新分支会话 |
| `/rewind` | 从某个历史 turn 克隆，并将项目文件回退到该 turn 时间点的 git 提交（git rewind） |

**限制：仅支持 claude provider**（底层依赖 `@anthropic-ai/claude-agent-sdk` 的 `forkSession`）。

#### B.2 交互流程

1. 输入框输入 `/`，选择 `/fork`、`/branch` 或 `/rewind`（命令元数据 `handler: 'ui-overlay'` 由后端下发，`backend/server/routes/commands.js:228-251`）。
2. 前端拦截并打开对应 overlay 弹层（`useChatComposerState.ts:794-826`；挂载 `ChatInterface.tsx:603-629`）：
   - **Fork**：打开即自动执行，无需二次确认，busy 态显示 "Forking…"（`ForkOverlay.tsx:14-52`）。
   - **Branch/Rewind**：展示当前会话的 turn 列表（过滤工具调用与压缩摘要，取消息前 80 字符作摘要），用户选择一个 turn 后执行。
3. 成功后新会话立即乐观插入侧边栏（`registerOptimisticSession`），并跳转到新会话。
4. 失败在 overlay 内红字展示。

#### B.3 接口规格

```
POST /api/sessions/:appId/fork     body: { upToMessageId? }
POST /api/sessions/:appId/rewind   body: { upToMessageId, turnTimestamp }
```

- 实现：`backend/server/routes/sessions.js:21-72`。
- 前置校验（失败均返回 409/404）：
  - 会话不存在 → 404；
  - `provider_session_id` 为空（会话尚未真正开始）→ 409 `SESSION_NOT_STARTED`；
  - 非 claude provider → 409 `UNSUPPORTED_PROVIDER`；
  - 会话有未结束的 run → 409 `RUN_IN_PROGRESS`。
- 执行：SDK `forkSession(provider_session_id, {upToMessageId?})` 得到新 provider 会话 → 创建本地 app 会话行 → 建立 provider 映射 → 返回 `{newSessionId, providerSessionId}`。
- rewind 额外步骤：fork 后按 `turnTimestamp` 定位 `projectPath` 下"该时间点或之前"的 git 提交并回退文件；**回退失败不使整体失败**，仅以 `warnings` 返回（`backend/server/services/git-rewind.js`）。

#### B.4 克隆范围与命名规则

- **复制**：provider、project_path、is_operator 属性；provider 侧完整转录（指定 `upToMessageId` 时截断到该消息）。
- **不复制**：任务关联（tasks 表不动）、custom_name/summary 不原样保留。
- **命名**：`"<原 custom_name || summary || 'Session'> (fork)"`；rewind 后缀为 `(rewind)`；branch 复用 fork 后缀。

### C. 测试现状（复刻时的测试清单参考）

已有（后端单测）：
- `sessions.fork.test.js`：成功路径、命名含 "fork"、三类 409、is_operator 透传；
- `sessions.rewind.test.js`：非 git 项目告警、有覆盖提交时回退文件、无覆盖提交告警；
- `git-rewind.test.js`、`sessions-provider-mapping.test.ts`。

**缺口**：`MessageCopyControl`、`clipboard.ts` 无单元测试；fork 无浏览器端集成测试。

复刻建议补充：剪贴板降级路径（mock 无 `navigator.clipboard`）、MD/TXT 格式转换快照、复制按钮显示条件（四类工具隐藏）、fork overlay 的乐观插入与跳转。

---

## 附：需求优先级建议（复刻排期参考）

| 优先级 | 功能 |
|---|---|
| P0 | 项目删除两档弹窗 + `DELETE /api/projects/:id?force=` + FK 级联 + 不碰源码目录红线 |
| P0 | 消息复制按钮（clipboard 主路径 + execCommand 降级 + 2 秒对勾反馈） |
| P1 | assistant MD/TXT 格式切换、代码块独立复制 |
| P1 | 项目硬删时补充 scheduled_tasks 级联清理（修当前遗留） |
| P2 | `/fork` 会话克隆（含 409 校验族） |
| P3 | `/branch`、`/rewind`（依赖 git 回退服务） |
