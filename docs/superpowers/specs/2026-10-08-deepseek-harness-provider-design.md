# Lovdex 后端接入 DeepSeek Harness（dsh）—— 第五个 provider 设计

- 日期：2026-10-08
- 状态：设计已确认，待实现
- 范围：**仅后端**（`backend/server/`）。前端接入列为后续阶段（见 §8），本设计不实现。
- 目标仓库：`https://github.com/deepseek-ai/deepseek-harness`（npm 包 `@deepseek-ai/dsh`）
- 前置：现有 provider 契约见 `backend/server/shared/interfaces.ts`；runner 范式见 `backend/server/qoder-runner.js`

## 1. 背景与目标

### 1.1 需求

用户原话：

> 后端增加对 deepseek-harness 的支持，其源码链接为：https://github.com/deepseek-ai/deepseek-harness

### 1.2 事实核查（实测，非转述 README）

在动手前先核实"这东西是不是真的、是什么形态"：

- **仓库真实存在**：`git ls-remote https://github.com/deepseek-ai/deepseek-harness` 返回 master HEAD `5badb15…` 及一批 `dsh-v0.1.x` / `dsh-v0.2.0-rc.*` tag。
- **npm 包真实**：`@deepseek-ai/dsh` 可 `npm pack`，latest = `0.2.0-rc.2`，MIT，`bin.dsh = lib/bin.js`。
- **形态**：它不是"一个模型 API"，而是**插件式 agent harness**（Cordis 框架，`dsh` 是唯一受支持的应用启动器）。多个入口模式，其中对 Lovdex 相关的是：
  - `dsh --profile sdk` —— JSON-RPC 2.0 over stdio（SDK 客户端用）
  - `dsh --profile acp` —— ACP (Agent Client Protocol) over stdio（自动化客户端用）
  - `dsh --profile headless "<job>"` —— 一次性跑完打印最终答案
  - `dsh web` —— Web 应用

> 说明：曾用网页抓取工具复核仓库页，返回的 star 数（约 24.5 万）与项目处在 rc 预览阶段的实际情况明显不符，故本设计的可行性判断**只依据 `git ls-remote` + `npm pack` 拿到的包内容**，不采信任何抓取到的统计数据。

### 1.3 目标

让 Lovdex 后端把 dsh 当作一个与其他四个（claude / codex / opencode / qoder）平级的 **provider**，复用现有"会话即子进程 + 结构化流 + 归一化消息"骨架接入。

### 1.4 非目标（明确不做）

- **不做前端接入**。Lovdex 前端有一份硬编码 provider 列表（`web/src/components/chat/hooks/useChatProviderState.ts:28` 的 `PROVIDERS`、`providerEffort.ts`），本期不动；因此本期交付后 UI 里**选不到** dsh。这是刻意的范围限定，见 §8。
- **不做远程会话**（remote-agent / lite 通道）。`remoteRouting.wrapSpawn` 对 dsh 先按"本地"处理。
- **不做 dsh 的 web / headless profile 接入**。只接 ACP。
- **不新增/改造任何非 dsh 的 provider 行为**。

## 2. 关键决策与理由

### 2.1 为什么选 ACP（而非 SDK / headless）

用户在三个通道中选定 **ACP**。核心理由是**能力对齐**：

| 能力 | Claude 现在靠谁 | dsh `--profile sdk` | dsh `--profile acp` |
|---|---|---|---|
| 工具审批弹窗（服务端→客户端往返） | `@anthropic-ai/claude-agent-sdk` 的 `canUseTool` + 内建 control_request/response 往返 | ❌ 未实现① | ✅ `session/request_permission` |
| 中途取消（保留会话） | SDK `queryInstance.interrupt()` | ❌ 无 prompt-cancel② | ✅ `session/cancel` |
| 多会话 | `activeSessions` Map 存多个 query 实例 | ⚠️ 需自己起多个 runtime | ✅ 一条连接多 session |
| 跨进程持久化 / 列历史 / resume | 读 `~/.claude/projects/**/*.jsonl` | — | ✅ `session/list` / `session/resume` |

① `@deepseek-ai/dsh-sdk-client` README 原文："Client→server notifications and server→client requests are unimplemented on both wire ends; the transport carries them for future approval flows."
② 同上："No mid-turn cancel — the wire has no prompt-cancel method; abandoning a turn means closing the runtime."

**结论**：Claude 的"审批 + 取消 + 多会话"三件套是官方 SDK 库白送的（Lovdex 只写业务弹窗逻辑）；dsh 的 SDK 通道**恰恰缺这三件的协议帧**。ACP 是标准协议，dsh 已把这三点实现全（`session/request_permission`、`session/cancel`、`session/list|resume|close`），因此要拿到同等能力，只能走 ACP。

### 2.2 为什么"一会话一进程"（A1，而非常驻复用）

ACP 原生支持"一条连接多 session"，理论上可全后端共用一个常驻 dsh 进程（A2）。但选择 **A1：每个 Lovdex 会话起一个 `dsh --profile acp` 子进程**，理由：

- 与 Lovdex 现有模型**完全对齐**：claude/codex/opencode/qoder 全是"一会话一子进程"，会话挂在后端 `tsx` 进程下（见既有调研：会话是后端子进程）。
- **故障隔离干净**：一个 dsh 进程崩溃只影响它自己那个会话，不牵连其他会话。
- **心智与实现成本最低**：`spawnFns` / `abortFns` 三张表照抄 qoder 的形状即可，不引入"常驻连接 + 会话多路复用 + 重连 resume"这一套 Lovdex 从未有过的新概念。
- 代价：dsh 冷启动要加载插件树，比 Claude CLI 重。若日后出现高频多会话的性能诉求，再演进到 A2（届时 `session/resume` 已具备支撑）。

### 2.3 会话历史走 ACP，不强制改用户压缩配置

dsh 的会话日志默认是 **checksummed Zstandard 帧**（`session.vN.jsonl.zstd`），只有配 `compression: 'none'` 才是明文 JSONL。两条路：

- **强制 `compression: none` 读盘**：能像 qoder 那样 `readline` 直读，但**要改用户的 dsh 配置**、占盘更大、且不尊重用户既有设置。
- **走 ACP `session/list` + `session/resume`**（**选定**）：不碰用户配置；与 A1 "能 resume" 的模型自洽。

> **实现后的更正（真机实测）：** 本文档 §2.4 曾写"ACP 不支持 `session/load`，因此无法重放旧会话"。实测 `dsh --profile acp` 的 `initialize` 会返回 `sessionCapabilities: { close, list, resume }` —— 它确实**没有** `session/load`，但**有 `session/resume`**（扩展方法，传 `{ sessionId, cwd }` 即可重挂一个已持久化的会话）。因此 runner 对带 provider-native id 的运行走 `session/resume`，resume 被拒时回退到 `session/new`。§2.4 那一条按此更正。

### 2.4 ACP 明确不支持的能力 → 对 dsh 禁用

> **更正（真机实测）：** 原稿把 `session/load`、`session/resume` 等一并列为不支持。实测 `initialize` 返回 `sessionCapabilities: { close, list, resume }`，即 `session/resume` / `session/list` / `session/close` **都支持**；只有 `session/load`（旧会话**全量重放**）确实没有。runner 已按此实现 resume（§2.3 的更正）。下面是不支持的项里，Lovdex UI 仍需要对 dsh 禁用的部分。

代价（已接受）：列历史需要活着连上 dsh 进程；`fetchHistory` 依赖 ACP 而非纯文件读，离线读历史不受支持。

dsh ACP README 原文列出不支持的表面：`session/load`（旧会话重放）、会话删除、fork、additional directories、modes、commands、plans、terminals、client filesystem operations、elicitation。

**处理**：Lovdex UI 上对应的入口（fork、删除会话、**内嵌终端**、额外目录）对 dsh provider **禁用或降级**，做法与 qoder 处理"无本地 token ledger"一致（返回零值结构、隐藏入口）。内嵌终端尤其重要：Lovdex 有 `terminal: { spawnPty }`（`server/index.js` 的 terminal 配置），而 dsh ACP 不支持 terminals。

## 3. 架构

### 3.1 新增 provider id

```ts
// backend/server/shared/types.ts:77
export type LLMProvider = 'claude' | 'codex' | 'opencode' | 'qoder' | 'dsh';
```

内部 id 用 `dsh`；对外显示名 "DeepSeek Harness"（前端阶段处理）。

### 3.2 注册（复用现有骨架，零特例）

```
backend/server/modules/providers/provider.registry.ts
  providers = { claude, codex, opencode, qoder, dsh: new DshProvider() }

backend/server/index.js
  const spawnFns = {
    ...
    dsh: remoteRouting.wrapSpawn('dsh', queryDsh),        // 照抄 qoder 那行
  };
  abortFns: { ... dsh: abortDshSession }                  // 照抄 qoder 那行
  resolveToolApproval: 把 dsh 的审批解析器接进现有分发（见 §3.5）
  getPendingApprovalsForSession: 加入 dsh 的 pending 集合
```

### 3.3 七个契约面

| 契约面 | dsh 走 ACP 如何实现 | 成色 |
|---|---|---|
| **models** | `getSupportedModels` / `getCurrentActiveModel` / `changeActiveModel` 映射到 ACP `session/set_config_option`（provider / model / reasoning_effort 三档选项，选项来自 dsh 实时 LLM catalog，非硬编码） | ✅ 原生 |
| **auth** | 检测 `dsh` 可执行文件是否可解析 + `DEEPSEEK_API_KEY`（或 dsh account 凭据）；返回 `ProviderAuthStatus{installed, authenticated, ...}` | ✅ 简单 |
| **mcp** | **走 ACP `session/new` 的 `mcpServers` 参数**（stdio / Streamable HTTP），不读写 `cordis.patch.yml` | ✅ 原生 |
| **skills** | 扫 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`，解析 YAML frontmatter。字段名（`name`/`description`/`whenToUse`/`user-invocable`/`disable-model-invocation`）与 Claude 几乎一致，归一化成本极低 | ✅ 高契合 |
| **sessions** | `normalizeMessage` 映射 ACP `session/update`（committed assistant message / thought / generic tool lifecycle / config change / context usage）；`fetchHistory` 走 `session/list` + `session/resume` | ⚠️ 需适配 |
| **sessionSynchronizer** | 走 ACP `session/list`（见 §2.3），**不读盘**；`synchronizeFile` 语义需按 ACP 能力重定义（见 §6） | ⚠️ 语义调整 |
| **runner** | `server/dsh-acp-runner.js`：spawn + ACP 客户端 + 审批弹窗 + 取消 + dispose | ✅ 核心 |

### 3.4 ACP 启动骨架（照抄 dsh 官方参考客户端）

dsh 自带参考 ACP 客户端 `@deepseek-ai/dsh-subagent-acp`，其 spawn 配置即 Lovdex 要照抄的形状：

```yaml
command: dsh
args: ['--profile', 'acp', '--patch', '/absolute/path/to/acp.patch.yml']
env:
  DSH_HOME: /absolute/path/to/isolated-home   # 隔离 home，避免污染用户 profiles/credentials
  DEEPSEEK_API_KEY: ...
```

Lovdex 侧等价 spawn：

```js
// server/dsh-acp-runner.js (示意)
const child = spawn('dsh', ['--profile', 'acp', '--patch', patchPath], {
  cwd: workspacePath,
  env: { ...scrubbedParentEnv, DSH_HOME: dshHome, DEEPSEEK_API_KEY: apiKey },
  stdio: ['pipe', 'pipe', 'pipe'],   // stdout 只跑协议，日志走 stderr
});
```

客户端用官方 `@agentclientprotocol/sdk`（dsh peer 依赖 1.4.0）的客户端侧 `ClientSideConnection`；**不使用** dsh 自家的 `dsh-sdk-client`（那是 SDK 通道，不是 ACP）。

### 3.5 审批往返映射

```
dsh 子进程要工具审批
  → ACP session/request_permission（服务端→客户端请求）
  → Lovdex 生成 requestId，ws.send({kind:'permission_request', ...})
  → 前端弹窗（前端阶段）
  → 用户点 allow/reject
  → 经现有 resolveToolApproval 分发（server/index.js）
  → 回填 ACP 的 allow_once / reject → 子进程继续
```

取消：用户点取消 → ACP `session/cancel`；若 ACP cancel 失败，退化为 dispose ladder（stdin EOF → SIGTERM → SIGKILL）。

### 3.6 数据流

```
Lovdex chat.send(provider='dsh')
  → spawnFns.dsh → queryDsh(command, options, ws)
  → spawn dsh --profile acp
  → ACP initialize（cwd / provider / model / effort）
  → session/new（新）或 session/resume（续）
  → session/prompt
  → for await (update of session/update) → normalizeMessage → WS 推前端
  → 审批/取消按 §3.5
  → 结束 → dispose（stdin EOF → SIGTERM → SIGKILL）
```

## 4. 配置

在 `backend/server/modules/config/config.ts` 的 `providers` 下新增：

```ts
dsh: {
  binPath: 'dsh',                 // 或用户配置的绝对路径
  dshHome: '',                    // 空则用 dsh 默认（$DSH_HOME 或 ~/.dsh）
  apiKey: '',                     // DEEPSEEK_API_KEY；空则依赖 dsh 自身凭据
  patchPath: '',                  // 可选 --patch 叠加文件
  toolApprovalTimeoutMs: 60000,
},
```

默认值与既有 provider 保持一致的风格（深合并，部署可覆盖单键）。

## 5. 测试策略

- **单元**：`normalizeMessage` 对各类 ACP `session/update` 的映射；skills frontmatter 解析（含 `disable-model-invocation`/`user-invocable` 的布尔变体）；auth 状态推断。
- **客户端协议**：用一个**假的 ACP server**（进程内 stdio，模拟 `initialize`/`session/new`/`prompt`/`request_permission`/`cancel`/`update`）跑 runner，覆盖审批往返、取消、异常退出、dispose ladder。参考既有 `server/modules/websocket/tests/qoder-runner.test.js` 的假 CLI 手法。
- **不加真实 dsh 依赖到 CI**：真实 dsh 进程的手测作为验收证据（见 §7），不进自动化测试。

## 6. 已知缺口与边界（写清，避免实现时踩空）

1. **`sessionSynchronizer.synchronizeFile` 语义**：现有接口是"解析并 upsert 单个 provider 产物文件"。dsh 走 ACP 不读盘，此方法要么按 ACP `session/list` 的结果做"单条 upsert"，要么保留文件路径参数但在 dsh 实现里忽略/降级。**实现时需在该方法 JSDoc 显式说明 dsh 的语义差异**，不改接口签名（其余 4 provider 依赖它）。
2. **无法重放旧会话**：ACP 不支持 `session/load`，Lovdex 的"打开历史会话看完整 transcript"对 dsh 只能拿 `session/list` 的摘要 + `session/resume` 后的新事件，**不是**全量历史回放。UI 需降级（前端阶段处理）。
3. **dsh 处于 rc 预览**：README 明确警告会有破坏性变更。**实现需固定一个版本前提**，并把 dsh 版本探测/不兼容时的报错做清楚（避免"静默失能"）。
4. **credential scrubbing**：spawn 时按 dsh 官方建议用隔离 `DSH_HOME`，并遵循 Lovdex 既有的凭据红线（不把密钥写进会被前端读到的地方）。

## 7. 验收标准

- 后端能 `resolveProvider('dsh')` 拿到 `DshProvider`，7 个契约面均不抛未实现。
- 用一个 dsh 会话真跑一次：spawn 成功 → 发 prompt → 收到流式 update → 触发一次工具审批弹窗并能 allow/reject → 能 cancel → 会话结束进程被 reap（无僵尸）。
- `npx tsx --test` 相关文件全绿；typecheck/lint **零新增**（baseline 已知有存量错误，见既有调研）。
- 前端不改，因此**不验收**"UI 里可选 dsh"。

## 8. 后续阶段（本设计不做，仅登记）

- **前端接入**：`useChatProviderState.ts` 的 `PROVIDERS` 数组、`providerEffort.ts` 的 effort 档位、provider 显示名/图标、模型下拉、审批弹窗对 ACP 返回形状的适配、禁用 fork/删会话/终端入口。
- **远程通道**：`remoteRouting` 对 dsh 的 lite 支持。
- **性能演进**：若多会话冷启动成瓶颈，评估 A2（常驻进程 + `session/resume` 多路复用）。

## 9. 附录：核实命令留痕

```sh
git ls-remote https://github.com/deepseek-ai/deepseek-harness        # 仓库存在
npm view @deepseek-ai/dsh version                                     # 0.2.0-rc.2
npm pack @deepseek-ai/dsh@latest                                      # CLI 包
npm pack @deepseek-ai/dsh-acp@0.2.0-rc.2                              # ACP server（能力来源）
npm pack @deepseek-ai/dsh-sdk-client@0.2.0-rc.2                       # SDK 通道（未选，缺审批帧）
npm pack @deepseek-ai/dsh-subagent-acp@0.2.0-rc.2                     # ACP 参考客户端（spawn 骨架来源）
npm pack @deepseek-ai/dsh-skill-filesystem@0.2.0-rc.2                 # skills 落盘格式
npm pack @deepseek-ai/dsh-mcp-client@0.2.0-rc.2                       # MCP 配置（最终走 ACP 参数）
npm pack @deepseek-ai/dsh-session-persistence-jsonl@0.2.0-rc.2        # 会话日志格式（zstd 默认）
```
