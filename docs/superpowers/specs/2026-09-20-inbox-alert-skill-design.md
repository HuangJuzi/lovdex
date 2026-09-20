# 收件箱上报 Skill（带版本管理）· 设计文档

日期：2026-09-20
状态：待评审

## 1. 背景与目标

`lovdex-alert` 上报约定目前靠**手动粘贴提示词**分发：用户要在每个巡检任务的描述里抄一遍格式约定，抄错或漏抄就静默无通知。

本次把这份约定打包成一个**带版本号的 Claude Code skill**，让用户：

1. 在 UI 里一个开关把它装进系统 skill 目录（`~/.claude/skills`）
2. 之后在**任何对话**里说一句"放到收件箱"就能触发通知，不用再抄格式
3. UI 里能看版本、能更新、能重装、能卸载
4. 内置版本升级时，收件箱收到一条提示

### 非目标（YAGNI）

- **不做确定性关键词兜底**（任务创建时匹配"收件箱"等词自动注入约定）。用户已确认接受 skill 触发的概率性。
- **不做远程主机 skill 同步**。远程主机没有 skill 分发机制（已实证），远程任务继续走提示词约定。
- **不做 codex / opencode 的 skill 安装**。只装 claude 的 `~/.claude/skills`（qoder 不可写，其余两个用户暂时用不到）。
- **不改造 `notification-orchestrator`** 的同会话 in-band 语义。

## 2. 关键约束（已实证）

1. **助手（operator）没有 Skill 工具**：交互式 operator 会话设 `sdkOptions.tools = []`（`claude-sdk.js:703`），禁用全部内建工具，含 `Skill`。SDK 只在显式传 `options.skills` 时才把 `Skill` 加进 allowedTools，而 `claude-sdk.js` 全文无此选项。
2. **助手调用 MCP 工具不会被权限挡**：operator 设 `permissionMode: 'bypassPermissions'`（`claude-sdk.js:706`），SDK 根本不调用 `canUseTool`。对比 headless 任务是 `permissionMode: 'default'`，新工具会落到 `permission_request` 挂起 60s 后 deny。
3. **`chat-run-registry.service.ts:262` 的 complete 分支是三类会话的唯一漏斗**：operator 交互、headless 任务、普通交互会话全部经 `decorateAndRecordEvent`，无例外路径（唯一提前 return 是重复 complete 去重）。
4. **run 对象缓冲了本轮消息**：`ChatRun.events`（`chat-run-registry.service.ts:37`），上限 5000 条。complete 到达时尾部已含本轮 assistant 文本，**无需 `fetchHistory`**。
5. **`onTaskCompleted` 覆盖不了无 task 的会话**：`tasks.service.ts:722` 对 `getTaskBySessionId` 返回 null 的会话**静默 return**。这是当前助手/普通聊天触发不了通知的根因。
6. **`addSkills` 本身就是"创建 + 重装"**：`skills.provider.ts:226-235` 先 `rm -rf` 技能目录再写，不需要新的 update 端点。
7. **全仓库无版本号概念**：`ProviderSkill` 无 `version` 字段；frontmatter 里的 `version` 能存盘但从未被解析。现有解析器 `readProviderSkillMarkdownDefinitionFromContent`（`shared/utils.ts:1042`）只读 `name` / `description`。
8. **可写的 global skill 目录只有 3 个 provider**：claude `~/.claude/skills`、codex `~/.agents/skills`、opencode `~/.config/opencode/skills`；qoder 无 global source，会抛 `PROVIDER_SKILLS_WRITE_UNSUPPORTED`。
9. **前端没有任何 skills 管理 UI**：`useSlashCommands.ts:202` 是唯一的（只读）调用。

## 3. 两个发送机制

按场景分，避免误报：

| 场景 | 机制 | 确定性 | 误报风险 |
|---|---|---|---|
| **Lovdex 助手**（operator 会话） | MCP 工具 `send_notification` → 直接 `emit` | 确定 | 无 |
| **任务会话 / 普通交互会话** | skill 描述触发 → 输出 `lovdex-alert` 文本标记 → 后端扫 `run.events` | 概率 | 已收窄（见下方修正） |

**为什么助手不用文本标记**：助手靠"跟你解释东西"干活，解释格式时输出一个可解析的 `lovdex-alert` 块会被扫成假通知，而假通知会削弱用户对收件箱的信任。工具是确定性的，且助手本就 `bypassPermissions`，工具调用畅通。

**为什么会话不用工具**：headless 任务的 `permissionMode: 'default'` 会让工具调用挂起 60 秒后自动拒绝（无人值守等于废掉）。

> **2026-09-20 修正（误报收窄）**：文本路径上线首日实测到一次误报 —— 任务本身就是开发/解释这个功能，中间消息里写出的**示例**块被扫成真通知。两处修复：
> 1. **解析器只扫最后一条 assistant 文本**（`alert-parser.ts` 的 `lastAssistantText`）。原实现遍历了全部 assistant 文本，与 §4 "复用 `lastAssistantText` 的语义" 不一致，属实现偏离。
> 2. **约定文本新增一条**：说明这个格式本身时不要输出完整的 `lovdex-alert` 代码块（`ALERT_PROMPT_INSTRUCTION`，随 `ALERT_SKILL_VERSION` 1.1.0 下发）。
>
> 代价：模型若不遵守"标记写在最终回复里"的约定（中途发标记、收尾再说一句无关的话），该通知会漏掉。约定文本已明确要求写在最终回复，接受这一取舍。

## 4. 扫描点上移（根因修复）

把 lovdex-alert 的扫描从 `onTaskCompleted` 迁到 **`chat-run-registry.service.ts` 的 complete 分支**（`taskLinkage.onSessionStatus` 调用点旁边）。

- **覆盖范围**：operator 交互会话、headless 任务会话、普通交互会话三类全部覆盖（原钩子只覆盖有 task 的 completed）。
- **数据来源**：逆序扫 `run.events` 找 `kind === 'text' && role === 'assistant'` 的条目，复用 `lastAssistantText` 的语义（`operator.tools.ts:172-181`），**不调用 `fetchHistory`**。
- **operator 排除**：继续跳过 `is_operator` 会话的文本扫描（读 `sessionsDb.getSessionById(appSessionId)?.is_operator`）。助手走工具，文本路径对它没有意义，跳过正好规避解释格式时的误报。
- **保留任务关联**：通知的 `task_id` / `schedule_id` 仍从 `getTaskBySessionId` 取（取不到就留空）。`session_id` 始终填，保证通知可点击跳转。任务查找作为**注入的 dep** 传给 registry（`getTaskMetaBySession`），不让 registry 直接依赖 tasks 仓储 —— 保持 registry 的现有边界（它目前不直接读 tasks 表）。
- **旧的 `scanCompletedTaskForAlerts` 删除**，`onTaskCompleted` 恢复为只做 verdict。

**成本变化**：省掉每次任务完成的一次 `fetchHistory`（远程会话是一次 RPC），改为读内存缓冲。

## 5. Skill 打包与版本

新增 `backend/server/modules/notifications/alert-skill.ts`：

```ts
/** skill 目录名（~/.claude/skills 下）。 */
export const ALERT_SKILL_DIR = 'lovdex-inbox-alert';

/** 约定格式的版本。改动 ALERT_PROMPT_INSTRUCTION 或解析器认可的格式时必须 bump。 */
export const ALERT_SKILL_VERSION = '1.0.0';

/** 生成 SKILL.md 全文（frontmatter + 正文）。 */
export function buildAlertSkillMarkdown(): string;
```

- **正文由 `ALERT_PROMPT_INSTRUCTION` 生成**，不手抄 —— 那个常量的注释里本来就写了"skill 的 SKILL.md 也应由它生成/核对"（`alert-format.ts:2-3`）。
- **frontmatter** 带 `name` / `description` / `version`。

**description 里埋触发词**（这是"自动触发"的实现方式）：

```
把结果或异常发送到 Lovdex 收件箱并在浏览器通知用户。
当用户要求"放到收件箱"、"发到收件箱"、"通知我"、"有异常告警"、"汇报结果到收件箱"时使用。
```

## 6. 后端服务与 API

新增 `backend/server/modules/notifications/alert-skill.service.ts`：

| 方法 | 职责 |
|---|---|
| `getStatus()` | 读已安装的 SKILL.md frontmatter → `{ installed, installedVersion, bundledVersion, hasUpdate, skillPath }`。不落库，每次从磁盘推导（无漂移） |
| `install()` | 调 `addProviderSkills('claude', { entries: [{ content, directoryName }] })`。已是"rm + 重写"，故**安装 / 更新 / 重装是同一个操作** |
| `uninstall()` | 调 `removeProviderSkill('claude', { directoryName })` |
| `checkUpdateOnStartup()` | 比对内置 vs 已安装；不一致则 emit 一条 info 通知（见 §8） |

**版本读取**：直接读 `~/.claude/skills/lovdex-inbox-alert/SKILL.md` 原文，用现有 `parseFrontMatter`（`backend/server/shared/frontmatter.ts:16`）解析 `version`。**不修改 provider 层的共享解析器**，避免波及 skills 列表接口。

**API**（挂在 notifications 模块下，沿用 `authenticateToken`）：

| 方法 | 路径 | 返回 |
|---|---|---|
| `GET` | `/api/notifications/skill` | `{ installed, installedVersion, bundledVersion, hasUpdate, skillPath }` |
| `POST` | `/api/notifications/skill/install` | 安装/更新后返回新状态 |
| `POST` | `/api/notifications/skill/uninstall` | 卸载后返回新状态 |

## 7. 助手工具 `send_notification`

在 `operator.tools.ts` 新增第三个通知工具（与已有的 `list_notifications` / `mark_notification_read` 并列）：

- **入参**：`severity`（critical/warning/info）、`title`、`body?`、`code?`
- **行为**：调 `deps.notifications.emit({...})`，带上当前会话 id
- **跳转**：通知带 `session_id`，点击跳回该助手会话。实现上在 operator 分支构造工具集时注入当前 `options.sessionId`（`buildOperatorSdkTools({ ...operatorDepsRef, contextSessionId })`）
- **去重**：无 task/schedule 时 `emit` 的 dedupe_key 前缀退化为 `anon`，同 `code`（或 title）的通知合并计数 —— 与巡检告警行为一致

同时更新 operator system prompt：告诉助手"用户要求发通知到收件箱时调用 `send_notification`"，并把工具名加进工具清单。

## 8. 版本更新通知

- **时机**：后端启动时（`startServer()` 内，`notificationsService` 实例化之后、`server.listen` 之前）跑一次 `checkUpdateOnStartup()`。
- **条件**：`installed === true` 且 `installedVersion !== bundledVersion`。
- **级别**：`severity = 'info'` —— 进收件箱、**不弹窗、不计角标**（用户已确认）。
- **去重**：`code = 'skill_update'`，dedupe_key 前缀为 `anon`。同一版本重复启动只合并计数，不刷屏。
- **跳转**：通知不带 task/session，前端 `/inbox` 里点击时**按 `code === 'skill_update'` 跳到设置页**（`InboxPage.openTarget` 增加这一分支；现有实现只处理 `task_id` / `session_id`，两者都空时点击无反应，必须补）。
- **失败处理**：读盘/解析失败一律 `console.warn` 后跳过，绝不阻塞启动（与 notifications 服务同样的容错原则）。

## 9. 前端

设置页新增一块「收件箱技能」（不新建 tab）：

- **开关**：装 / 卸（调 install / uninstall）
- **版本显示**：`已安装 v1.0.0 · 内置 v1.1.0`
- **按钮**：有更新时主按钮为「更新到 v1.1.0」，否则为「重装」
- **状态**：未安装时只显示「安装」+ 内置版本
- **有更新**时整块高亮

API 客户端在 `web/src/utils/api.js` 的 `notifications` 命名空间下加 `skillStatus` / `skillInstall` / `skillUninstall`。

## 10. 数据模型

**不新增表。** skill 状态全部从磁盘推导；版本更新通知复用现有 `notifications` 表 + 去重键。

## 11. 测试策略

- **后端单测**（`npx tsx --test`）：
  - `buildAlertSkillMarkdown`：frontmatter 含 name/description/version；正文包含 `ALERT_PROMPT_INSTRUCTION` 的全部关键行（防漂移断言）
  - `alert-skill.service`：已安装/未安装/版本一致/版本不一致 四种 `getStatus` 分支（用临时目录注入路径）
  - `checkUpdateOnStartup`：有更新时 emit info、无更新时不 emit、读盘失败不抛
  - registry 扫描：从 `run.events` 提取标记（含 operator 排除、无标记不 emit、task/schedule 关联）
  - `send_notification` 工具：delegates 到 emit、schema 校验、未接线时报错
- **前端纯逻辑单测**：状态 → 按钮文案/开关状态的映射函数
- **puppeteer 冒烟**：设置页装 → 状态变已安装 → 卸载 → 状态变未安装；以及"内置版本 > 已安装版本"时高亮与「更新」按钮出现

## 12. 已定默认值（可推翻）

1. **只装 claude** 的 `~/.claude/skills`，目录名 `lovdex-inbox-alert`
2. **远程主机不装**（无同步机制），远程任务继续走提示词约定
3. **UI 放设置页新开一块**，不新建 tab
4. **版本更新通知为 info 级**（进收件箱、不弹窗、不计角标）
5. **不做关键词兜底**，接受 skill 触发的概率性
6. **安装/更新/重装是同一个操作**（`addSkills` 天然如此）

## 13. 已知限制

- **skill 触发是概率性的**：模型根据 description 自行判断是否调用 `Skill`。description 写得越准越可靠，但不保证 100%。确定性路径仍有三条：助手建任务时自动嵌入约定、助手直接用工具发通知、手动粘贴约定。
- **远程任务用不到这个 skill**：远程主机无 skill 分发机制。
- **助手工具发出的通知不可点回具体对话轮次**，只跳到该助手会话。
- **文本标记必须落在最后一条 assistant 文本里**：标记若出现在中途消息，会被收窄后的解析器忽略（这是误报修复的代价，见 §3 修正说明）。
