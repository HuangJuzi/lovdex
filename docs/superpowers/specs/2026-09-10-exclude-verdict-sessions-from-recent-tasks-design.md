# Lovdex 最近任务 — 排除 auto-verdict（状态判断）会话 设计

- 日期：2026-09-10
- 状态：待评审
- 范围：后端（DB 迁移 + 标记 + API 字段）+ 前端（过滤 + 测试）

## 1. 背景与目标

侧边栏「最近任务」区块（`SidebarRecentSessions` → `getRecentSessions(projects, 10)`）当前打平**所有**项目
的会话，包括 operator 工作区里的 auto-verdict（状态判断）会话。

用户要求：**最近任务里不要出现「状态判断」会话**，即 auto-verdict 跑出的 headless 会话；但保留 Lovdex助手
交互聊天（`is_operator=1`）在列表里（它们顶部已有独立入口，属另一问题，不在本设计范围）。

### 1.1 auto-verdict 会话是怎么来的

1. 任务会话完成后，session-status hook 触发 `scheduleAutoVerdict(sessionId, taskId, title, isOperator)`。
2. `runOperatorHeadless`（`backend/server/claude-sdk.js:1265`）跑一个**全新**的 headless Claude SDK `query`
   （`cwd = operator workspace`，不 `resume`，`tools: []`），SDK 生成新 sessionId，把 JSONL 写到
   `~/.claude/projects/<workspace>/` 下。
3. session 同步器（`ClaudeSessionSynchronizer`）从磁盘索引该文件，`sessionsDb.createSession` 建行：
   `is_operator=0`、`project_path=workspace`、`summary` 为 verdict prompt（"你是 Lovdex Operator。判断任务 …"）。

### 1.2 难点：会话层无法区分「助手聊天」vs「verdict 会话」

两者都落在 operator workspace 项目（`isOperatorWorkspace: true`），而前端拿到的 `SessionSummary`
（`projects-with-sessions-fetch.service.ts` 的 `mapSessionRowToSummary`）目前只有
`id / provider / custom_name / summary / messageCount / lastActivity`，**不带 `is_operator`**，
无法在会话层区分。因此不能靠"排除整个 operator 工作区项目"（那会连 Lovdex助手 聊天一起干掉）。

## 2. 关键设计决策

| 决策点 | 结论 |
|---|---|
| 识别方式 | 给 verdict 会话打专用标记 `is_verdict`，而非内容启发式或归档 |
| 标记落点 | `sessions` 表新增列 `is_verdict INTEGER DEFAULT 0` |
| 打标记时机 | `runOperatorHeadless` drain 流时捕获 SDK `message.session_id`，结束后 `sessionsDb.markSessionAsVerdict` |
| 重索引保留 | `sessionsDb.createSession` 的 UPDATE / ON CONFLICT 分支不触碰 `is_verdict`（同 `isArchived`） |
| 过滤位置 | 前端 `getRecentSessions` 过滤 `is_verdict === 1` 的会话 |
| 保留 Lovdex助手 聊天 | 是（`is_operator=1` 不受影响） |
| 复用归档（isArchived） | 否——语义错、污染归档视图 |

## 3. 方案详述

### 3.1 DB 迁移（后端）

- `SESSIONS_TABLE_SCHEMA_SQL`（`schema.ts:126`）加 `is_verdict INTEGER DEFAULT 0`。
- `migrations.ts` 在 `is_operator` 那行后加：
  `addColumnToTableIfNotExists(db, 'sessions', sessionColumnNamesForSummary, 'is_verdict', 'INTEGER DEFAULT 0')`。
- `sessions.db.ts`：`SessionRow` 类型 + `SESSION_ROW_COLUMNS` 加 `is_verdict`。

### 3.2 后端打标记

- 新增 `sessionsDb.markSessionAsVerdict(sessionId, projectPath, provider = 'claude')`：
  upsert 一行（`session_id = provider_session_id = sessionId`，与 `createSession` 磁盘同步约定一致），
  `is_verdict = 1`；`ON CONFLICT(session_id) DO UPDATE SET is_verdict = 1`。不触碰 `isArchived / is_operator`。
  - 时序鲁棒：无论 `runOperatorHeadless` 先打标记、还是同步器先 `createSession` 建行，两种顺序下标记都保留
    （`createSession` 的 re-index 分支只刷新 provider/时间/path/jsonl/custom_name/summary）。
- `runOperatorHeadless`（`claude-sdk.js`）：
  - drain 循环 `for await (const _message of queryInstance)` 改为捕获 `_message.session_id`（首条 `system` 消息自带）。
  - 循环结束后若捕获到 sessionId，调 `sessionsDb.markSessionAsVerdict(sessionId, cfg.workspace)`。
  - 捕获不到（测试 seam / 异常）→ 静默跳过，行为回退到现状，不抛错。
- `claude-sdk.js` 顶部补 `import { sessionsDb } from './modules/database/index.js'`。

### 3.3 API 字段（后端）

- `projects-with-sessions-fetch.service.ts`：
  - `SessionRepositoryRow` 加 `is_verdict?: number`。
  - `SessionSummary` 加 `is_verdict: number`。
  - `mapSessionRowToSummary` 输出 `is_verdict: row.is_verdict ?? 0`。
- 说明：operator 工作区项目用 `getSessionsByProjectPath`（含 verdict 会话），因此 verdict 会话仍会随 payload 下发，
  由前端过滤——不破坏 `/session/:id` 直开的解析链路。

### 3.4 前端过滤

- `web/src/types/app.ts`：`ProjectSession` 加 `is_verdict?: number`。
- `web/src/components/sidebar/utils/utils.ts` 的 `getRecentSessions`：flatMap 前先 `filter` 掉
  `session.is_verdict === 1`（或 flatMap 后过滤），更新注释（原注释"含助手会话"仍成立，补充"排除 verdict 会话"）。

## 4. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 打标记时会话行尚不存在 | `markSessionAsVerdict` 用 INSERT 建行（is_verdict=1）；后续同步器 re-index 保留标记 |
| 同步器先建行、标记后到 | `ON CONFLICT(session_id) DO UPDATE SET is_verdict=1` 命中更新 |
| 捕获不到 sessionId | 静默跳过，verdict 会话以 is_verdict=0 出现（回退现状，无更坏影响） |
| verdict 会话仍出现在 operator 工作区项目 payload | 前端 `getRecentSessions` 过滤，不影响 `/session/:id` 解析 |
| 归档/恢复 verdict 会话 | `markSessionAsVerdict` 不触碰 `isArchived`；归档视图行为不变 |
| 存量 verdict 会话（本次上线前已产生的） | 无标记，仍显示在最近任务；不回溯补标（YAGNI） |

## 5. 测试

### 后端

1. `migrations`：sessions 表含 `is_verdict` 列（仿 `operator-columns.test.ts`）。
2. `sessionsDb.markSessionAsVerdict`：新建行带 is_verdict=1；已有行更新为 1；不覆盖 isArchived/is_operator。
3. `createSession` re-index 后保留 is_verdict（仿 `isArchived` 保留测试）。
4. `runOperatorHeadless`：注入 `queryFn` seam 返回带 `session_id` 的 message，断言结束后该 session 被标记。

### 前端

5. `getRecentSessions`：混入 `is_verdict=1` 与普通/助手会话，断言 verdict 会话被过滤、其余保留。
6. 现有测试 `getRecentSessions keeps operator workspace sessions` 保持通过（助手聊天仍保留）。

## 6. 范围外（不做）

- 排除整个 operator 工作区项目（用户明确只去 verdict 会话，保留助手聊天）。
- 回溯补标历史 verdict 会话。
- 内容启发式（标题前缀「判断任务」）识别。
- 复用 `isArchived` 归档。
- 让 verdict 会话在其他视图（归档、上下文来源下拉）里也隐藏。
