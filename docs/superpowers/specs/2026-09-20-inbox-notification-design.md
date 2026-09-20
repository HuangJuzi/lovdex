# 异常通知收件箱 · 设计文档

日期：2026-09-20
状态：待评审

## 1. 背景与目标

有一批定时巡检任务（可能每 10 分钟触发一次），巡检到异常时希望：

1. **实时通知**：浏览器开着时，异常立即以轻量弹窗（toast）提示。
2. **打开即补推**：再次打开页面时，若有未读的重要通知，弹一次汇总弹窗。
3. **收件箱回看**：一个专门页面可以查看历史通知、已读/未读状态，防止漏掉。

核心诉求是**防止漏掉重要信息**，但同时——由于巡检高频（10 分钟一次 = 一天 144 次）——**降噪是第一设计目标**：正常运行时收件箱应当是空的，只有真正需要你看一眼的事才出声。

### 非目标（YAGNI）

- **不做 Web Push / 系统级通知**。当前部署是纯 HTTP（`http://<lan-ip>:5188`，无证书），浏览器规定 Service Worker / Notification API 只在 secure context 下可用。`web/public/sw.js` 里的 push handler 保持死代码，本设计不激活它。
- **不做通用外部通知**（IM / 邮件 / webhook）。只做浏览器内通知 + 收件箱。
- **不改造现有 `notification-orchestrator`** 的同会话 in-band 语义；本设计新增一条**跨会话**广播通道，两者并存。

## 2. 关键约束（已实证）

设计前对代码库做了探索，以下事实经实证确认，是设计的地基：

1. **转录扫描不依赖工具，不受权限限制**。上报走"约定输出格式 + 后端扫转录"，模型只是输出文本，不调用任何需要许可的工具。实测转录中 headless 任务 Bash 跑 80 次仅 2 次撞上 `Permission request timed out`（~2%），而文本输出零风险。
2. **任务完成钩子远程本地同链路**。`chat-run-registry.decorateAndRecordEvent` → `taskLinkage.onSessionStatus` → `onTaskCompleted`（`backend/server/index.js:498`）对本地 run 和远程 run 无差别（远程 run 在 run registry 层面与本地一致，见 `remote-spawn.ts`）。
3. **远程主机无 skill 同步机制**。主端 `~/.claude/skills` 不会推送到远程；bootstrap 只装 node + claude CLI + systemd。因此"把 skill 装进系统，远程任务就能用"这条路在远程场景**断了**。约定必须能随 prompt 走。
4. **远程转录可拉回，但仅 claude / qoder**。lite 的 `session/messages` RPC 只实现了 claude 和 qoder 的转录目录解析；codex / opencode 的 `fetchHistory` 不走远程分支，返回空。
5. **`onTaskCompleted` 只在 `state==='completed'` 触发**，`failed` / `aborted` 分支不走它（`tasks.service.ts:791`）。
6. **前端有现成实时通道**：`WebSocketContext.subscribe`（单例 WS），无需新建 SSE。前端目前**没有 toast 库**，约定是 `alert()` + 内联 `Alert` + 自研 `Dialog`。
7. **`scheduled_tasks` 表当前为空**，巡检任务形态完全由本设计定义，无存量兼容负担。

## 3. 上报机制：约定输出格式（single source of truth）

### 3.1 格式约定

巡检任务在最终回复中输出一个 `lovdex-alert` 代码块，内含 JSON：

````
```lovdex-alert
{"severity":"warning","code":"disk_full","title":"/var 剩余 3%","body":"根分区使用率 97%，建议清理日志"}
```
````

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `severity` | 是 | `critical` / `warning` / `info`，决定弹窗与角标行为（见 §5） |
| `code` | 是 | 稳定的异常类别标识，用于合并去重（见 §6）。正常巡检约定用 `ok` |
| `title` | 是 | 一句话摘要，收件箱列表标题 |
| `body` | 否 | 详细描述，收件箱详情展示 |

**约定要求每次巡检结束都输出一次**（无异常也输出 `severity=info, code=ok`）。这是"防止漏掉"的核心：约定"必报"之后，"模型忘了报"与"本次无异常"在后端不再等价——没扫到标记 = 一条 `patrol_unreported` 通知。

### 3.2 分发：skill + prompt 注入双载体

- **skill 作为权威定义与本地载体**：新增一个 Claude Code 原生 skill（`~/.claude/skills/lovdex-inbox-alert/SKILL.md`），描述格式约定与 severity 语义。本地交互式会话可通过 `Skill` 工具调用它（实测 `Skill` 工具在任务会话中可用）。skill 通过前端"技能管理"（`POST /api/providers/:provider/skills`）安装。
- **prompt 注入作为远程通道**：scheduler 生成巡检任务时，把这份约定的**精简版正文**直接拼进任务描述。约定随 prompt 走，远程主机无需安装 skill。
- **单一事实来源**：skill 正文与 scheduler 注入的约定文本抽取为**同一份常量**（后端一个模块导出），避免两处漂移。skill 的 `SKILL.md` 在构建/安装时由该常量生成或与之核对。

**用户自定义**：进什么、报多严重，完全由用户在巡检 prompt 里控制（"磁盘满报 critical，服务重启报 warning，一切正常报 info"）。后端不做业务分类，只做分级投递。

## 4. 通知来源

所有来源收敛到一个**通知中心服务**（`backend/server/modules/notifications/`），统一解析 → 分级 → 合并 → 落库 → 广播。

| 类型 | 触发点 | 默认 severity | 备注 |
|---|---|---|---|
| `patrol_alert` | 任务完成扫转录提取 `lovdex-alert` 标记 | 由 prompt 指定 | `code=ok` 的 info 只刷新心跳，不进收件箱（见 §6） |
| `patrol_unreported` | 巡检任务完成但没扫到任何标记 | warning | 看门狗之一；远程 codex/opencode 会落到这里 |
| `patrol_stalled` | 超过容忍窗口无成功巡检（心跳） | warning | 看门狗之二，在 scheduler tick 里扫（见 §7） |
| `task_failed` | `onSessionStatus('failed')`（`tasks.service.ts:796`） | warning | 带 session 链接，可点进去看转录 |
| `action_required` | 等待工具批准（`claude-sdk.js:816` 已有 `notification` 帧） | warning | 桥接现有同会话通知到跨会话收件箱 |

**范围说明**：默认只有巡检任务（`alert_reporting` 开关打开的定时任务）参与 `patrol_*`。`task_failed` / `action_required` 对所有任务生效，但受 §6 合并约束。普通开发任务的"完成"**不进收件箱**（避免噪声）。

### 4.1 扫描位置与失败任务处理

- **扫描挂在 `onTaskCompleted`**（`index.js:498`，与 verdict LLM 同一钩子，追加一个消费者，不改 `tasks.service`）。只在 `state==='completed'` 触发。
- **失败/中断任务不解析 alert**（钩子不触发是既有约束，不为此改造）。补偿：`task_failed` 通知本身会产生，并携带 `session_id`，用户点进去仍能看到转录里的任何 alert 块。这是刻意的取舍——不追求崩溃任务也解析 alert。

### 4.2 解析容错

- 扫描**全部 assistant 文本消息**（不是只取最后一条 `lastAssistantText`），避免长报告把 alert 块挤出截断窗口。复用 `sessionsService.fetchHistory` + 遍历 messages。
- 正则提取 ` ```lovdex-alert ... ``` ` 代码块 → `JSON.parse`。
- 非法 JSON / 缺必填字段 / 非法 severity：**丢弃并 `console.warn`**，绝不 coerce。丢弃后该次视为"未扫到有效标记"，触发 `patrol_unreported`。
- 一次转录允许多个 alert 块（多项异常），逐个处理。

### 4.3 读取成本

正常巡检（含 `code=ok`）每次完成都要读一次转录（远程为一次 `session/messages` RPC）。10 分钟一次频率下成本可忽略，此处显式记录该成本存在。

## 5. severity 语义

| severity | 进收件箱 | 弹窗（toast） | 侧边栏角标 | 打开页面补推 |
|---|---|---|---|---|
| `critical` | 是 | 是，立即 | 计入 | 计入汇总弹窗 |
| `warning` | 是 | 是 | 计入 | 计入汇总弹窗 |
| `info`（`code≠ok`） | 是（静默区） | 否 | 不计入 | 否 |
| `info`（`code=ok`） | 否（见下） | 否 | 不计入 | 否 |

`code=ok` 的 info 是特例：**不落 `notifications` 表**，只更新该 schedule 的心跳记录（见 §6 第一层）。这是"正常巡检时收件箱为空"的直接来源。其他 info（用户主动报的非 ok info）落表进静默区，可回看但不打扰。

## 6. 降噪：三层机制

高频巡检下这是设计的核心，不是补丁。

### 第一层 · 源头静默

`code=ok` 的正常巡检不产生任何通知，只刷新心跳。上报仍要求发生（用于确认模型没忘、任务没停摆）。

### 第二层 · 同类合并（去重）

- **去重键 `dedupe_key = schedule_id + ':' + code`**（无 schedule 的来源如 `task_failed` 用 `task_id + code`）。
- 命中已存在且**未读**的同键通知：不新建，而是 `occurrence_count++`、刷新 `last_seen_at`、更新 `title`/`body` 为最新。**不重复弹窗、不重复增加未读数。**
- 命中已存在但**已读**的同键通知：视为复发，新建一条（或复活原条并标未读，二选一——实现取复活原条 + 重置 `read_at=null` + `occurrence_count++`，语义更清晰）。
- 展示："持续 2 小时 · 告警 12 次"（由 `first_seen_at` / `last_seen_at` / `occurrence_count` 渲染）。
- 效果：磁盘满持续 2 小时 = **1 条**通知，不是 12 条。

### 第三层 · 心跳看门狗（不是"每次都报"）

- 每次巡检任务完成（无论 alert 内容）都刷新该 schedule 的**最后成功巡检时间**（`patrol_heartbeat` 表或 `scheduled_tasks` 上的列）。
- 只有**超过预期间隔 × 容忍倍数**（默认周期 × 3，最小 30 分钟）没有心跳，才发一条 `patrol_stalled`。该通知同样受第二层合并约束（`code=stalled`）。
- 效果：正常运行一天 **0 条**看门狗通知；任务卡死 / 机器挂了才出声。

## 7. 看门狗的宿主：scheduler tick

心跳扫描**复用 scheduler 现有的 `setInterval(tick, 15_000)`**（`scheduler.service.ts:361`），不新开定时器。

- 在 `tick()` 中，除现有"到点建任务"逻辑外，增加一段：遍历开启了 `alert_reporting` 的 schedule，检查其最后心跳时间是否超过容忍窗口，超了则通过通知中心发 `patrol_stalled`（受合并去重，不会每 15s 刷屏）。
- 该扫描是幂等的：`patrol_stalled` 的 `dedupe_key` 保证停摆期间只有一条活跃通知，心跳恢复后标记该通知可自动已读或由用户手动清理（实现取：心跳恢复时若存在未读 `stalled` 通知，自动补一条 `severity=info` 的"已恢复"并将 stalled 标已读）。

## 8. 数据模型

### 8.1 新表 `notifications`

```sql
CREATE TABLE IF NOT EXISTS notifications (
  notification_id   TEXT PRIMARY KEY,
  type              TEXT NOT NULL,      -- patrol_alert / patrol_unreported / patrol_stalled / task_failed / action_required
  severity          TEXT NOT NULL,      -- critical / warning / info
  code              TEXT,               -- 异常类别，合并用
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

迁移：按仓库约定，在 `schema.ts` 新增 `NOTIFICATIONS_TABLE_SCHEMA_SQL` 常量拼进 `INIT_SCHEMA_SQL`，并在 `migrations.ts` 的 `runMigrations` 里 `db.exec(NOTIFICATIONS_TABLE_SCHEMA_SQL)`。

### 8.2 心跳记录

轻量，优先在 `scheduled_tasks` 上加列，避免新表：

```sql
ALTER TABLE scheduled_tasks ADD COLUMN alert_reporting INTEGER NOT NULL DEFAULT 0;  -- 巡检模式开关
ALTER TABLE scheduled_tasks ADD COLUMN last_patrol_at DATETIME;                      -- 最后成功巡检心跳
```

`alert_reporting=1` 时：生成任务注入上报约定 + 参与心跳看门狗。用 `migrations.ts` 的 `addColumnToTableIfNotExists` 幂等加列。

## 9. 后端组件

新模块 `backend/server/modules/notifications/`，遵循仓库现代模块化约定（DI 工厂 + service + routes + db + tests）：

| 文件 | 职责 |
|---|---|
| `notifications.service.ts` | `emit(payload)`：分级 + 合并去重 + 落库 + 广播；`list` / `markRead` / `markAllRead` / `unreadCount` |
| `notifications.db.ts` | 白名单式 CRUD，合并 upsert（按 `dedupe_key`） |
| `notifications.routes.ts` | `buildNotificationsRouter`：`GET /`（分页+过滤）/ `GET /unread-count` / `POST /:id/read` / `POST /read-all` |
| `alert-parser.ts` | 从 messages 提取 `lovdex-alert` 块（纯函数，易测） |
| `patrol-report.ts` | 约定文本常量（skill 与 prompt 注入共享的 single source of truth） |
| `tests/` | 单测 |

装配：`index.js` 里 `app.use('/api/notifications', authenticateToken, buildNotificationsRouter(...))`；扫描消费者接进 `onTaskCompleted`；心跳扫描接进 scheduler tick；`emit` 内部调用现有 `broadcast`（`index.js:465` 的全客户端 fan-out）发 `notification_created` / `notification_updated` 事件。

## 10. 广播事件

复用 `broadcastTask` 同款全客户端 fan-out（`index.js:465`），新增 kind：

- `notification_created`：新通知（携带完整 payload）
- `notification_updated`：合并计数更新 / 标记已读（携带 `notification_id` + 变更字段）

## 11. 前端组件

| 部件 | 位置 / 做法 |
|---|---|
| `inboxStore` | 模块级单例，仿 `web/src/stores/branchStore.ts`（`subscribe` + `useSyncExternalStore`），管未读数与通知列表，跨路由存活（`/inbox`、`/tasks` 会卸载 `AppContent`，必须全局 store） |
| WS 消费 | 仿 `useTasks.ts`：订阅 `notification_created` / `notification_updated` / `websocket_reconnected`（重连全量 refetch） |
| 侧边栏入口 + 角标 | 仿 `SidebarScheduledEntry.tsx` 加一行，未读数用数字角标（复用 `Badge` 或 attention 圆点模式） |
| `/inbox` 页 | 新增路由（仿 `TaskBoardPage`），新建 `web/src/components/inbox/`。按 severity 分组、已读/未读筛选、一键全部已读、点击跳回 `/task/:id` 或 `/session/:id` |
| 实时 toast | **新增轻量 toast 组件**（仓库现在只有 `alert()`）。critical/warning 到达时右上角弹出，几秒自动消失。放 `web/src/shared/view/ui/` |
| 打开页面补推 | `AppContent` 挂载时查未读 critical/warning，>0 则弹一次汇总 `Dialog`（复用现有 `Dialog`）。这是"打开之后弹窗"诉求 |
| API 客户端 | `web/src/utils/api.js` 加 `notifications` 命名空间（仿 `tasks:`） |

## 12. 保留与清理策略

- 保留 **90 天** 或 **最多 500 条**，超出裁剪最旧的**已读**通知。
- 裁剪时机：`notifications.service.emit` 落库后顺带检查（低频，不单独起定时器）。

## 13. 测试策略

- **后端单测**：
  - `alert-parser`：合法/非法/多块/截断/缺字段/非法 severity 的容错。
  - `notifications.service`：分级、合并去重（未读命中计数、已读命中复活）、`code=ok` 走心跳不落表、裁剪。
  - 心跳看门狗：超窗口发 stalled、合并不刷屏、恢复补 info。
  - 路由：list 分页过滤、markRead、markAllRead、unreadCount。
  - 按仓库约定用 `npx tsx --test`，DB 测试用临时库。
- **前端纯逻辑单测**：`inboxStore` 未读计数、severity 分级映射。
- **puppeteer 冒烟**：注入一条通知 → 侧边栏角标 +1 → 打开 `/inbox` 看到条目 → 标已读角标归零。遵循"用 computed display + 紧裁切像素剖面"而非整页截图判定。

## 14. 已定默认值（可推翻）

1. 收件箱走**独立路由 `/inbox`**（非塞进任务页）。
2. 保留：**90 天 / 最多 500 条**，裁剪已读。
3. 心跳容忍窗口：**周期 × 3，最小 30 分钟**。
4. **不做 Web Push / 系统级通知**（纯 HTTP 硬限制）。
5. 普通开发任务的"完成"**不进收件箱**，只有巡检 `alert_reporting` 任务和 `task_failed` / `action_required` 进。

## 15. 分期建议

- **一期（闭环 MVP）**：`notifications` 表 + service + 扫描接进 `onTaskCompleted` + `patrol_alert` / `patrol_unreported` + 合并去重 + `/inbox` 页 + 侧边栏角标 + 打开补推弹窗。跑通"巡检报异常 → 收件箱看到 → 打开弹窗"主链路。
- **二期**：心跳看门狗（`patrol_stalled` + scheduler tick 扫描 + `alert_reporting` 开关 UI）、实时 toast、`task_failed` / `action_required` 桥接、skill 安装。
