# Operator 技能就地执行（Operator Skill Execution）规格

> 状态：第一期（后端）本次实现；第二期（前端）留档待做。
> 创建：2026-08-18

## 1. 目标

Lovdex 助手（operator）目前只有调度类工具（create_task / start_task_execution / move_task /
list_tasks 等），没有就地执行能力。遇到「用用户级 skill 查询/操作」（如
claw-agent-get-send 查群聊、发 IM 消息）或「拷贝文件」这类操作时，只能下发任务给其他
项目执行器——这会把用户凭证（JWT / agentId / userId）带进其他项目的上下文与
transcript，存在**凭证扩散与身份误用**风险。

本规格给 operator 一块**自己的执行场** + 一个**通用就地执行机制** + **分层白名单策略**。

## 2. 核心设计原则：一个家 + 一个机制 + 分层策略

- **Operator Home 是唯一就地执行场**：所有 skill 执行、一般文件操作都在这里发生
  （`/home/zhijuhuang/.lovdex/operator-workspace`，已注册项目，即 operator workspace），
  永远不散到其他项目目录。
- **凭证只在用户级作用域读取**：env（`CLAW_JWT` / `APP_AGENT_ID` / `CLAW_USER_ID` 等）
  或 `~/.claw/cred.json`（要求 0600）。只在调用瞬间读取、只注入子进程 env，**不拷进
  任何项目目录 / transcript / 任务表 / 日志 / 子代理**；禁止 spawn 后台子代理把凭证
  带出去。
- **项目边界规则**：落在其他项目目录里的读写 → 一律走正常任务下发（create_task +
  start_task_execution）；Operator Home 内 → 就地执行。
- **不开放裸 Bash**：避免绕过白名单。`execute_skill` 只能跑白名单内技能；`workbench`
  写操作只允许在 Operator Home 等白名单前缀内，跨目录写一律拒绝。

## 3. 边界（非目标）

- 不做通用 shell / REPL。
- 不做多用户凭证隔离（Lovdex 当前单用户部署）。
- 第一期不做前端配置界面与审计查看页（第二期）。
- 不改动其他项目执行器（claude/codex/opencode/qoder）的执行链路。

---

## 4. 第一期范围（本次实现，纯后端）

### 4.1 新工具 `execute_skill`

就地执行白名单内的用户级 skill。

**参数**（inputSchema）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `skillName` | string | 是 | 技能名，必须在 `enabled_skills` 白名单内 |
| `args` | string | 否 | 传给技能的命令行参数串（按 shell 词法安全拆分，**不经 shell**），如 `send --text "hi" --rid r123` |
| `timeoutMs` | number | 否 | 超时，默认 60000，上限 300000 |

**行为**：

1. 白名单判定：skillName 命中 `enabled_skills` 且解析出的子命令命中该 skill 声明的
   `allowed_subcommands`，否则拒绝（fail loudly，返回可读错误 + 审计 decision=deny）。
2. cwd 限定在技能根目录 `~/.claude/skills/<skillName>`（技能根必须真实存在；技能名
   禁止含 `..` / 路径分隔符）。
3. 入口脚本由白名单条目 `entry` 指定（如 `scripts/appia_claw.py`），解释器由
   `runner` 指定（首批 `uv run`）。argv 以数组形式传给 `execFile`，**不经过
   shell**，杜绝注入。
4. 凭证：调用瞬间经 `credential-resolver` 解析（env 优先，缺则读
   `~/.claw/cred.json`），以子进程 env 注入；解析失败返回可读错误。凭证值不写入
   任务表 / transcript / 日志 / 审计。
5. 输出：stdout/stderr 经 `output-sanitizer` 脱敏（JWT / token / authorization /
   agentId / userId 打码）后回传，截断到 8000 字符。
6. 同步执行、带 timeout kill；**禁止** `detached`、后台进程、spawn 子代理（如
   claude/codex CLI）。

**返回**（JSON）：`{ ok, skill, subcommand, exitCode, durationMs, stdout, stderr }`；
拒绝/失败时 `ok=false` 且带 `error` 可读信息（错误同样脱敏）。

参考技能：`claw-agent-get-send`
（`~/.claude/skills/claw-agent-get-send/scripts/appia_claw.py`，子命令：
groups / send / send-md / send-file / verify-target）。

### 4.2 新工具 `workbench`

命令式通用执行（不开放裸 Bash）。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string enum | 是 | `list` / `read` / `copy` / `run-script` |
| `path` | string | list/read | 目标路径（list 目录 / read 文件） |
| `src` | string | copy | 源路径（文件或目录） |
| `dst` | string | copy | 目标路径 |
| `scriptPath` | string | run-script | 脚本路径（须在允许根内） |
| `args` | string | 否 | run-script 的参数串（安全拆分，不经 shell） |
| `timeoutMs` | number | 否 | run-script 超时，默认 60000，上限 300000 |

**行为**：

- `list`：列目录（名称 + 类型 + 大小），结果脱敏。读操作可读任意用户可读路径。
- `read`：读 UTF-8 文本文件，结果脱敏，截断到 8000 字符；拒绝读 `~/.claw/cred.json`
  等凭证文件本身（防回显明文）。
- `copy`：拷贝文件/目录（recursive）。**目标 dst 必须位于 `workbench_write_prefixes`
  白名单前缀内**（realpath 判定）。从任意位置拷进 Operator Home 允许；Home 内互拷
  允许；拷出 Home 到其他项目目录 → 拒绝并提示应走任务下发。
- `run-script`：脚本 realpath 必须位于允许根内（默认 = `workbench_write_prefixes`），
  按扩展名选解释器（`.py` → `uv run`，`.js/.mjs` → `node`，`.sh` → `bash`），argv
  数组传递不经 shell，cwd = Operator Home，同步 + timeout kill。脚本放不进允许根就
  不能跑——白名单脚本即「用户显式放进允许根的脚本」。
- 所有路径先做 realpath 解析（防 `..` / symlink 逃逸），写操作越界一律拒绝
  （fail loudly）并落审计。

**返回**（JSON）：`{ ok, command, ...结果, durationMs }`；拒绝时 `ok=false` +
`error` + `hint`（如「跨出 Operator Home 的写操作请改用 create_task 下发」）。

### 4.3 白名单模型

配置文件优先级（2026-08-18 二期落地后修订）：**env > DB 持久化 > 配置文件 > 内建默认**。

- env：`LOVDEX_OPERATOR_ALLOWLIST_JSON`（inline JSON 字符串）或
  `LOVDEX_OPERATOR_ALLOWLIST_PATH`（指向 JSON 文件）。env 生效时设置 API 拒绝写入（409）。
- DB 持久化：`app_config` 表 key `operator_skill_allowlist`，由设置页
  `PUT /api/operator/skill-exec/allowlist` 写入；`DELETE` 清除回退到文件/默认。
- 配置文件：`backend/server/config/operator-skill-allowlist.json`（可选，缺失则用默认）。
- 内建默认（`operator-allowlist.ts`）：

```json
{
  "enabled_skills": [
    {
      "name": "claw-agent-get-send",
      "entry": "scripts/appia_claw.py",
      "runner": "uv",
      "allowed_subcommands": ["groups", "verify-target", "send", "send-md", "send-file"],
      "readonly_subcommands": ["groups", "verify-target"]
    }
  ],
  "workbench_write_prefixes": [
    "/home/zhijuhuang/.lovdex/operator-workspace",
    "/home/zhijuhuang/.claude/skills"
  ]
}
```

- `readonly_subcommands` 为信息性标注（第一期全部子命令默认放行；「需人工确认」档位
  留给后续交互审批机制，见「暂不做事项」）。
- `workbench_write_prefixes` 中的 `~` 在加载时展开；加载时做 realpath 归一。
- 明确拒绝：白名单外 skill、未声明子命令、写操作逃出白名单前缀。

### 4.4 凭证与脱敏

- `modules/operators/credential-resolver.ts`：
  - env 优先：`CLAW_JWT` / `APP_AGENT_ID` / `CLAW_USER_ID`（及别名
    `APPIA_CLAW_JWT` / `AGENT_ID` / `USER_ID` / `APPIA_USER_ID`）。
  - 缺则读 `~/.claw/cred.json`（JSON，键名同 env 别名集合）：校验文件权限，
    宽于 0600 时 `console.warn` 警告（不阻断，与凭证明文无关的元信息才可进日志）。
  - 解析出的敏感值**永不**写入任务表 / transcript / 日志 / 审计；只存在于子进程
    env 生命周期内。
- `modules/operators/output-sanitizer.ts`：
  - JWT：`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*` → `eyJ***REDACTED***`
  - `Bearer <token>` → `Bearer ***REDACTED***`
  - JSON/kv 形态敏感键：`jwt|token|authorization|agent_?id|user_?id|password|secret`
    的值 → `***REDACTED***`
  - 脱敏是纯函数，单测覆盖。

### 4.5 审计

每次 `execute_skill` / `workbench` 调用（含被拒绝的调用）落一条审计记录到新表
`operator_exec_audit`：

| 列 | 说明 |
|---|---|
| `id` | 自增主键 |
| `created_at` | 调用时间 |
| `caller` | 调用方标识（一期固定 `operator`） |
| `tool` | `execute_skill` / `workbench` |
| `action` | skill 名 / 子命令（如 `claw-agent-get-send:send`、`copy`） |
| `target` | 目标路径或 rid 等（脱敏、截断） |
| `decision` | `allow` / `deny` + 原因 |
| `duration_ms` | 耗时 |
| `exit_code` | 子进程退出码（无子进程为 null） |
| `result_summary` | 脱敏后结果摘要（≤500 字符） |

repository：`modules/database/repositories/operator-audit.db.ts`，schema 登记进
`modules/database/schema.ts`（`INIT_SCHEMA_SQL`），与现有表同一初始化路径。
审计写入失败只 warn，不阻断工具调用。

### 4.6 注册

- `operator.tools.ts`：新增 `execute_skill` / `workbench` 两个工具，handler 委托
  `OperatorToolDeps` 新注入的 `skillExec` / `workbench` 服务（保持纯逻辑可单测）。
- `claude-sdk.js`：`buildOperatorSdkTools(deps, { exclude })` 增加可选排除参数——
  headless verdict run（`runOperatorHeadless`）排除 execute_skill / workbench
  （评审 agent 不需要就地执行，最小授权）；交互助手全量注册。
- `claude-sdk.js` 交互助手 systemPrompt（isOperator 分支）：补充 execute_skill /
  workbench 的用途与边界说明（Operator Home 内就地执行；跨项目写入走任务下发）。
- `index.js` `initOperatorHeadless({...})`：注入真实 `skillExec` / `workbench`
  服务与审计 repository。

### 4.7 测试与验收清单

- [ ] `npm run typecheck`（= `tsc --noEmit -p server/tsconfig.json`）零新增错误。
- [ ] 单测（`npx tsx --tsconfig server/tsconfig.json --test <files>`）真实跑通，覆盖：
  - [ ] 白名单命中（enabled skill + 声明子命令 → 放行）
  - [ ] 白名单未命中（未知 skill / 未声明子命令 → 拒绝 + 审计 deny）
  - [ ] workbench 写逃出 Home 被拒（copy dst 越界、run-script 脚本越界）
  - [ ] 凭证不落库：返回与日志/审计无明文（cred 解析正确注入子进程 env）
  - [ ] 脱敏生效（JWT/Bearer/agentId/userId 被打码）
  - [ ] 子代理/后台 spawn 被禁（execFile 无 shell、无 detached、同步 timeout kill）
  - [ ] 审计落库（allow/deny 均有记录）

---

## 5. 第二期范围（本轮不实现，仅留档）

前端 `web/`：

1. **设置页「技能白名单」配置区**：enabled_skills（增删技能、entry/runner/子命令）、
   workbench 写前缀、每 skill 子命令放行策略，读写到后端配置。配套 API：
   `GET/PUT/DELETE /api/operator/skill-exec/allowlist`，持久化到 `app_config`
   表 key `operator_skill_allowlist`，优先级 env > DB > 配置文件 > 默认
   （§4.3 已按此修订）。
2. **凭证管理入口**：配置/测试 `~/.claw/cred.json` 或 env 凭证（仅写入后端配置，
   不回显明文；提供「测试连通性」按钮，实际调用一次 `groups` 验证）。
3. **审计查看页/区块**：展示 `operator_exec_audit` 记录（时间/工具/动作/目标/
   decision/耗时/脱敏摘要），支持按 tool / decision 过滤（需后端配套只读 API）。
4. **operator 会话内 skill 执行结果友好展示**：execute_skill / workbench 的
   结构化输出渲染（折叠 stdout/stderr、exitCode 徽标、deny 原因高亮）。

---

## 6. 暂不做事项

- 裸 Bash / 任意命令执行（永久非目标）。
- 子命令级「需人工确认」审批流（一期全部默认放行；等交互审批机制落地后再启用
  `readonly_subcommands` 之外的确认档位）。
- 多用户 / 多凭证体系。
- skill 市场 / 自动发现（一期 skill 靠白名单显式登记）。
- Operator Home 外的就地写（任何跨项目写都走任务下发，不开口子）。
