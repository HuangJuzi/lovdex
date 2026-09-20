# 异常通知收件箱 · 设计文档

日期：2026-09-20
状态：待评审

## 1. 背景与目标

有一批定时巡检任务（可能每 10 分钟触发一次），巡检到异常时希望：

1. **实时通知**：浏览器开着时，异常立即以轻量弹窗（toast）提示。
2. **打开即补推**：再次打开页面时，若有未读通知，弹一次汇总弹窗。
3. **收件箱回看**：一个专门页面查看历史通知、已读/未读，防止漏掉。

**核心原则：完全由提示词驱动。** 报不报、报什么、多严重，用户在巡检 prompt 里写。后端只做一件事——**扫到标记就投递**，不判断什么算异常、不做看门狗、不检测未上报。

### 非目标（YAGNI）

- **不做看门狗 / 心跳 / 未上报检测 / 停摆检测**。后端不推断"应该报却没报"，只处理"报了"的。
- **不做 Web Push / 系统级通知**。当前部署是纯 HTTP（`http://<lan-ip>:5188`，无证书），浏览器规定 Service Worker / Notification API 只在 secure context 下可用。`web/public/sw.js` 的 push handler 保持死代码。
- **不做通用外部通知**（IM / 邮件 / webhook）。只做浏览器内通知 + 收件箱。
- **不改造现有 `notification-orchestrator`** 的同会话 in-band 语义；本设计新增一条跨会话广播通道，两者并存。

## 2. 关键约束（已实证）

1. **转录扫描不依赖工具，不受权限限制**。上报走"约定输出格式 + 后端扫转录"，模型只是输出文本，不调用任何需要许可的工具。实测 headless 任务里文本输出零风险（Bash 才有 ~2% 权限超时）。
2. **任务完成钩子远程本地同链路**。`chat-run-registry.decorateAndRecordEvent` → `taskLinkage.onSessionStatus` → `onTaskCompleted`（`backend/server/index.js:498`）对本地 run 和远程 run 无差别。
3. **远程主机无 skill 同步机制**，因此约定必须能随 prompt 走，不能只依赖装 skill。
4. **远程转录可拉回，但仅 claude / qoder**（lite 的 `session/messages` RPC）。codex / opencode 的 `fetchHistory` 不走远程分支、返回空 → 那两种远程任务扫不到标记，等价于"没报"，静默即可（符合"只处理报了的"原则）。
5. **`onTaskCompleted` 只在 `state==='completed'` 触发**（`tasks.service.ts:791`）。失败/中断任务不扫描。
6. **前端有现成实时通道** `WebSocketContext.subscribe`（单例 WS），无需新建 SSE。前端目前**没有 toast 库**，约定是 `alert()` + 内联 `Alert` + 自研 `Dialog`。
7. **`scheduled_tasks` 表当前为空**，无存量兼容负担。

## 3. 上报机制：约定输出格式

### 3.1 格式约定

任务在最终回复中输出一个 `lovdex-alert` 代码块：

````
```lovdex-alert
{"severity":"warning","title":"/var 剩余 3%","body":"根分区使用率 97%，建议清理日志","code":"disk_full"}
```
````

| 字段 | 必填 | 说明 |
|---|---|---|
| `severity` | 是 | `critical` / `warning` / `info`，决定弹窗与角标行为（见 §5） |
| `title` | 是 | 一句话摘要，收件箱列表标题 |
| `body` | 否 | 详细描述，收件箱详情展示 |
| `code` | 否 | 稳定的类别标识，用于合并去重（见 §6）；不填则按 title 合并 |

**不要求"每次必报"**。不报就没通知——这正是提示词驱动：正常巡检时用户可以让模型什么都不输出，收件箱自然为空。

### 3.2 分发：skill + prompt 注入双载体

- **skill 作为权威定义与本地载体**：新增 Claude Code 原生 skill（`~/.claude/skills/lovdex-inbox-alert/SKILL.md`），描述格式约定。本地交互式会话可通过 `Skill` 工具调用（实测 `Skill` 工具在任务会话中可用）。通过前端"技能管理"（`POST /api/providers/:provider/skills`）安装。
- **prompt 注入作为远程通道**：用户在巡检 prompt 里直接写明格式约定即可（或引用 skill）。约定随 prompt 走，远程主机无需装 skill。
- **单一事实来源**：skill 正文与后端解析器认可的格式抽取为同一份常量（后端 `alert-format.ts` 导出），skill 的 `SKILL.md` 由该常量生成或与之核对，避免漂移。

**用户完全掌控**：进什么、多严重，都在 prompt 里。后端不做业务分类。

## 4. 通知来源

只有一个来源：**任务完成时扫转录提取 `lovdex-alert` 标记**。

- 扫描挂在 `onTaskCompleted`（`index.js:498`，与 verdict LLM 同一钩子，追加一个消费者，不改 `tasks.service`）。只在 `state==='completed'` 触发。
- 对**所有**完成的任务扫描（不限定时任务）——因为是否输出标记完全由 prompt 决定，没输出就没通知，无需开关。

### 4.1 解析容错

- 扫描**全部 assistant 文本消息**（不是只取最后一条），避免长报告把标记挤出截断窗口。复用 `sessionsService.fetchHistory` + 遍历 messages。
- 正则提取 ` ```lovdex-alert ... ``` ` 代码块 → `JSON.parse`。
- 非法 JSON / 缺必填字段（`severity`/`title`）/ 非法 severity：**丢弃并 `console.warn`**，绝不 coerce。
- 一次转录允许多个标记（多项异常），逐个处理。

### 4.2 读取成本

每个完成的任务都要读一次转录（远程为一次 `session/messages` RPC）。此成本显式记录；频率下可忽略。

## 5. severity 语义

| severity | 进收件箱 | 弹窗（toast） | 侧边栏角标 | 打开页面补推汇总弹窗 |
|---|---|---|---|---|
| `critical` | 是 | 是，立即 | 计入 | 计入 |
| `warning` | 是 | 是 | 计入 | 计入 |
| `info` | 是（静默区） | 否 | 不计入 | 否 |

## 6. 唯一的降噪：同类合并

高频巡检下必要，否则每 10 分钟弹一次会淹掉重要信息。

- **去重键 `dedupe_key = task 来源标识 + ':' + (code || title)`**。定时任务用 `schedule_id`，普通任务用 `task_id`。
- 命中已存在且**未读**的同键通知：不新建，`occurrence_count++`、刷新 `last_seen_at`、更新 `title`/`body` 为最新。**不重复弹窗、不重复加未读数。**
- 命中已存在但**已读**的同键通知：视为复发，复活原条（`read_at=null` + `occurrence_count++` + 刷新时间），重新计入未读并弹窗。
- 展示："持续 2 小时 · 12 次"（由 `first_seen_at` / `last_seen_at` / `occurrence_count` 渲染）。
- 效果：磁盘满持续 2 小时 = **1 条**通知，不是 12 条。

## 7. 数据模型

### 新表 `notifications`

```sql
CREATE TABLE IF NOT EXISTS notifications (
  notification_id   TEXT PRIMARY KEY,
  severity          TEXT NOT NULL,      -- critical / warning / info
  code              TEXT,               -- 类别标识，合并用（可空）
  title             TEXT NOT NULL,
  body              TEXT,
  schedule_id       TEXT,               -- 关联定时任务模板（可空）
  task_id           TEXT,               -- 关联任务（可空）
  session_id        TEXT,               -- 关联会话，用于跳转（可空）
  project_path      TEXT,
  dedupe_key        TEXT NOT NULL,
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  first_seen_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at           DATETIME,           -- NULL = 未读
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key, read_at);
```

迁移：在 `schema.ts` 新增 `NOTIFICATIONS_TABLE_SCHEMA_SQL` 拼进 `INIT_SCHEMA_SQL`，并在 `migrations.ts` 的 `runMigrations` 里 `db.exec(...)`。**不改 `scheduled_tasks` 表**（无需 `alert_reporting` 开关，因为不做看门狗）。

## 8. 后端组件

新模块 `backend/server/modules/notifications/`，遵循仓库现代模块化约定（DI 工厂 + service + routes + db + tests）：

| 文件 | 职责 |
|---|---|
| `notifications.service.ts` | `emit(payload)`：合并去重 + 落库 + 广播；`list` / `markRead` / `markAllRead` / `unreadCount` |
| `notifications.db.ts` | 白名单式 CRUD，按 `dedupe_key` 合并 upsert |
| `notifications.routes.ts` | `buildNotificationsRouter`：`GET /`（分页+过滤）/ `GET /unread-count` / `POST /:id/read` / `POST /read-all` |
| `alert-parser.ts` | 从 messages 提取 `lovdex-alert` 块（纯函数，易测） |
| `alert-format.ts` | 格式约定常量（skill 与 prompt 共享的 single source of truth） |
| `tests/` | 单测 |

装配：`index.js` 里 `app.use('/api/notifications', authenticateToken, buildNotificationsRouter(...))`；扫描消费者接进 `onTaskCompleted`；`emit` 内部调用现有 `broadcast`（`index.js:465` 全客户端 fan-out）发 `notification_created` / `notification_updated`。

## 9. 广播事件

复用 `broadcastTask` 同款全客户端 fan-out（`index.js:465`），新增 kind：

- `notification_created`：新通知（携带完整 payload）
- `notification_updated`：合并计数更新 / 标记已读（携带 `notification_id` + 变更字段）

## 10. 前端组件

| 部件 | 位置 / 做法 |
|---|---|
| `inboxStore` | 模块级单例，仿 `web/src/stores/branchStore.ts`（`subscribe` + `useSyncExternalStore`），管未读数与列表，跨路由存活 |
| WS 消费 | 仿 `useTasks.ts`：订阅 `notification_created` / `notification_updated` / `websocket_reconnected`（重连全量 refetch） |
| 侧边栏入口 + 角标 | 仿 `SidebarScheduledEntry.tsx` 加一行，未读数用数字角标 |
| `/inbox` 页 | 新增路由（仿 `TaskBoardPage`），新建 `web/src/components/inbox/`。severity 分组、已读/未读筛选、一键全部已读、点击跳回 `/task/:id` 或 `/session/:id` |
| 实时 toast | **新增轻量 toast 组件**（仓库现在只有 `alert()`）。critical/warning 到达时右上角弹出，几秒自动消失。放 `web/src/shared/view/ui/` |
| 打开页面补推 | `AppContent` 挂载时查未读 critical/warning，>0 则弹一次汇总 `Dialog`（复用现有 `Dialog`） |
| API 客户端 | `web/src/utils/api.js` 加 `notifications` 命名空间（仿 `tasks:`） |

**2026-09-21 修正（断线补推）**：上面两条弹窗路径都是**事件驱动**的 —— toast 只在收到 `notification_created` 时弹，补推汇总只在**挂载**时算一次。于是客户端断线期间产生的通知两头落空：收不到 `notification_created`，而重连后的 `websocket_reconnected` 只做全量 refetch（更新列表与角标，不弹任何东西）—— 表现是**「收件箱有、角标有、就是不弹窗」**。桌面 WS 基本常连所以少见，手机浏览器切后台/锁屏必断，是移动端的主路径。

修法：把汇总弹窗的触发从"挂载时算一次"改成**挂在 store 订阅上**（`claimUnannouncedImportant`，见 `inboxStore.ts`），于是首挂拉取、重连 refetch、实时新告警三条路径都会经过它；store 用模块级 `announced` 集合记账，同一条本次会话只打扰一次（实时那条在 `applyInboxEvent` 里就记了账，不会重复汇总）。页面刷新会重置账本 —— 刷新后重新补推未读项是期望行为。

顺带修掉一个相关缺陷：`AppContent` 原先渲染时直接读 `getInboxSnapshot()` 但**没订阅 store**，所以"弹窗已经开着"时补进来的条目不会出现在列表里（`setSummaryOpen(true)` 在已开时是 no-op，不触发重渲染）。现改为 `useSyncExternalStore` 订阅。

## 11. 保留与清理

- 保留 **90 天** 或 **最多 500 条**，超出裁剪最旧的**已读**通知。
- 时机：`emit` 落库后顺带检查（低频，不单独起定时器）。

## 12. 测试策略

- **后端单测**（`npx tsx --test`，DB 测试用临时库）：
  - `alert-parser`：合法/非法/多块/截断/缺字段/非法 severity 的容错。
  - `notifications.service`：合并去重（未读命中计数、已读命中复活）、裁剪。
  - 路由：list 分页过滤、markRead、markAllRead、unreadCount。
- **前端纯逻辑单测**：`inboxStore` 未读计数、severity 分级映射。
- **puppeteer 冒烟**：注入一条通知 → 侧边栏角标 +1 → 打开 `/inbox` 看到条目 → 标已读角标归零。用 computed display + 紧裁切像素剖面判定，不用整页截图。

## 13. 已定默认值（可推翻）

1. 收件箱走**独立路由 `/inbox`**。
2. 保留：**90 天 / 最多 500 条**，裁剪已读。
3. **不做 Web Push / 系统级通知**（纯 HTTP 硬限制）。
4. **不做看门狗 / 未上报检测**——完全提示词驱动，没报就没通知。
5. 对所有完成任务扫描（不限定时任务），因为是否报由 prompt 决定，无需开关。
