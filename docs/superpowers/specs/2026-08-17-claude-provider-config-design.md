# Claude Provider 全量配置化 + 保存实时生效

Date: 2026-08-17  Status: Approved

## 背景与目标

当前 Claude Code provider 的关键运行参数来自宿主环境变量（由 `~/.bashrc` export、supervisor 启动时抓取注入）：

- `ANTHROPIC_BASE_URL=https://www.sophnet.com/api/open-apis/anthropic`
- `ANTHROPIC_AUTH_TOKEN=…`（sophnet token）
- `ANTHROPIC_MODEL=DeepSeek-V4-Flash-0731`
- `ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET}_MODEL[_NAME]`（`cc()` 函数内 export）

问题是：改模型必须改 `.bashrc` 再 `systemctl --user restart lovdex`，且模型列表（UI 下拉框）在模块加载时从 env 快照，重启才能反映变更。

目标：以上变量全部收进 `~/.lovdex/data/app.config.json`，通过 Web 设置页修改，保存后**新会话实时生效**，无需重启、无需再依赖 `.bashrc`。配置为**唯一来源**（用户已选择"配置完全接管"）。

## 设计

### 1. 配置模型（config schema）

`backend/server/modules/config/config.ts` 的 `DEFAULT_APP_CONFIG.providers.claude` 新增 5 个字段（现有 `cliPath`/`apiKey`/`authToken`/`oneMillionModels`/`streamCloseTimeoutMs`/`toolApprovalTimeoutMs` 保持不变）：

| config 字段 | 说明 | 映射 env（非空→写 / 空→删除） |
|---|---|---|
| `baseUrl` | 代理地址 | `ANTHROPIC_BASE_URL` |
| `defaultModel` | 默认模型 | `ANTHROPIC_MODEL` |
| `haikuModel` | haiku 别名 | `ANTHROPIC_DEFAULT_HAIKU_MODEL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME` |
| `opusModel` | opus 别名 | `ANTHROPIC_DEFAULT_OPUS_MODEL` + `ANTHROPIC_DEFAULT_OPUS_MODEL_NAME` |
| `sonnetModel` | sonnet 别名 | `ANTHROPIC_DEFAULT_SONNET_MODEL` + `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` |
| `cliPath` | 已有（无 UI） | `CLAUDE_CLI_PATH`（非 "claude" 时） |
| `apiKey` | 已有（UI 唯一认证字段） | `ANTHROPIC_API_KEY` **和** `ANTHROPIC_AUTH_TOKEN`（写同一值） |
| `authToken` | 已有（无 UI） | `ANTHROPIC_AUTH_TOKEN`（非空时覆盖 apiKey 写入的 AUTH_TOKEN） |

- 新增 5 字段带**非空默认值**：`baseUrl`/`defaultModel`/`haikuModel`/`opusModel`/`sonnetModel` 分别预填 sophnet 值与模型别名（`DeepSeek-V4-Flash-0731` 等），新 config 生成即含这些值。
- 别名模型的 `_NAME` 镜像**自动同步**写入（同一字段写两个 env），对应 `.bashrc` 里成对 export 的效果。
- `baseUrl` 与模型名非敏感字段，GET /api/config 明文返回；`apiKey` 用 `first6****last6` 掩码，其余敏感 key（`authToken`/`personalAccessToken` 等）沿用 `••••last4`。

### 2. 权威 env 同步（env-sync.ts）

`syncProviderEnv(cfg)` 升级为**权威语义**：

- 非空 → `process.env[key] = value.trim()`
- 空 → `delete process.env[key]`（真能清掉宿主 env / .bashrc 注入的值）
- `apiKey` 权威语义：非空同时写 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN`（同一值），空删除两者；`authToken` 非空时覆盖 `ANTHROPIC_AUTH_TOKEN`（后端兼容字段，无 UI）
- `cliPath` 权威语义：`'claude'`/空 → 删除 `CLAUDE_CLI_PATH`（CLI 走 PATH 解析）；其他值 → 写入
- 导出 `OWNED_ANTHROPIC_ENV` 常量表（`providers.claude` 字段 → env key 列表，含 `CLAUDE_CLI_PATH`，共 11 个 key），供 supervisor 过滤复用
- 调用点不变：`index.js` 启动时 + `config.routes.ts` PUT 保存后（已有链路，保存即实时）

### 3. supervisor 环境过滤

`supervisor/supervisor.mjs` 抓取 shell env 后，过滤掉 `OWNED_ANTHROPIC_ENV` 对应的 11 个键（`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`/`CLAUDE_CLI_PATH` + 三个别名的 `MODEL` 与 `MODEL_NAME` 镜像），**只过滤这些键**，其余 shell env（PATH、OPENAI_*、DISABLE_AUTOUPDATER 等）原样保留。

效果：后端启动时环境干净，config 是唯一来源；改 `.bashrc` 不再影响 lovdex 服务。

实现取舍：常量表在 env-sync.ts 与 supervisor.mjs 各存一份并互相注释引用（保持简单；两文件分属不同部署目录，跨 import 脆弱）。替代方案（supervisor 从 backend 模块 import）备选。

### 4. 模型列表动态化（claude-models.provider.ts）

- 模块加载时读 env 的顶层 const → 改为 `getClaudeFallbackModels()` 每次**从 app.config 读取并重建** `ProviderModelsDefinition`（纯字符串读取，代价可忽略）
- `CLAUDE_FALLBACK_MODELS`（静态 const）替换为函数导出；`findClaudeModelOption` 内部改用动态构建结果
- `claude-sdk.js` 5 处引用更新：
  - `resolveClaudeEffort` 默认参数改为调用 `getClaudeFallbackModels()`
  - `sdkOptions.model = options.model || …` 处用动态默认
  - `providerModelsService.resolveResumeModel` 上游不变（已有动态获取逻辑）
  - `runOperatorHeadless` 的 `CLAUDE_FALLBACK_MODELS.DEFAULT` 用动态构建
- `getSupportedModels()` 返回动态构建结果 → UI 下拉框（`/api/providers/claude/models`）保存后即时看到新模型

### 5. Web 设置页（ProviderSettingsPage.tsx）

**表单字段**：Claude 区块最终字段（沿用 `TextField`/`SecretField` 模式）：

- API Key (apiKey) — 不可显示完整值：只显示 `first6****last6`（无显示/隐藏切换，`SecretField revealable={false}`）
- Base URL (baseUrl) — 文本框，默认值已预填 sophnet 地址
- 默认模型 (defaultModel) / Opus 模型 (opusModel) / Sonnet 模型 (sonnetModel) / Haiku 模型 (haikuModel) — 文本框，默认值已预填
- **移除**：Auth Token (authToken)、CLI 路径 (cliPath) 两个输入框（后端 config 字段与 env-sync 映射保留）
- 页头提示文案：API Key 掩码说明 + 保存实时生效

Type 定义同步扩展。PUT 整份 draft 的既有模式不变（后端 `stripMaskedPlaceholders` 处理 `••••`/`****` 打码占位）。

**模态弹出**（用户确认：页内浮层）：

- 从 `ProviderSettingsPage` 抽取表单主体为 `ProviderSettingsForm`（draft 加载/保存、各区块、保存栏），不含页面外框
- `/settings/providers` 路由页保留（`ProviderSettingsPage` = 页头 + 返回按钮 + 表单），支持深链/返回
- 侧边栏底部"Provider 设置"按钮（`SidebarFooter.tsx:121` 现 `navigate('/settings/providers')`）改为打开模态：
  - `SettingsDialog` 组件复用现有 `Dialog` 原语（`shared/view/ui/Dialog.tsx`，含 Escape/遮罩点击关闭、focus trap、body 滚动锁定），`DialogContent` 加 `max-w-3xl` + 内部滚动
  - 模态头部用关闭（✕ / 完成）按钮替代返回按钮
  - open 状态放一个小 zustand store（沿用 `useSessionStore` 模式）或上提至 `AppContent` 持有，侧边栏触发

## 行为语义

- **实时性**：保存 → `syncProviderEnv` 立刻执行 → 新会话（`sdkOptions.env = {…process.env}` 每次快照）立即用新值；模型下拉框即时刷新。**正在运行的 session 不受影响**（其 env/模型已快照）。
- **清空 = 取消**：设置页清空某字段并保存 → 对应 env 被删除 → 新会话回退到 claude CLI 自身认证链（`~/.claude/settings.json` env → `.credentials.json` OAuth）。
- **迁移**：部署后 supervisor 不再注入这些变量；重启后 config 为空 → env 清空 → 用户需在设置页填写一次（一次性迁移成本，同时是验证入口）。
- **不涉及**：`DISABLE_AUTOUPDATER`、`OPENAI_*`（codex/opencode 相关）仍走宿主 env，不在本方案范围。

## 测试

- `env-sync`：权威映射——非空写、空删除、`_NAME` 镜像成对写、apiKey 写双 env、trim
- `config`：新字段默认值（sophnet 预填）、`apiKey` 掩码 `first6****last6`、深层合并不受影响
- `config.routes`：PUT 把 `••••` 前缀或含 `****` 的掩码值视为"未改动"并丢弃
- `claude-models`：模型列表随 config 变化重建；`findClaudeModelOption` 基于新值
- supervisor 过滤：`OWNED_ANTHROPIC_ENV` 键被过滤、其余保留

## 涉及文件

- `backend/server/modules/config/config.ts`（schema + 默认值 + `maskApiKey`）
- `backend/server/modules/config/config.routes.ts`（`stripMaskedPlaceholders` 识别 `****`）
- `backend/server/modules/config/env-sync.ts`（权威同步 + OWNED_ANTHROPIC_ENV）
- `supervisor/supervisor.mjs`（环境过滤）
- `backend/server/modules/providers/list/claude/claude-models.provider.ts`（动态模型）
- `backend/server/claude-sdk.js`（引用更新）
- `web/src/components/settings/ProviderSettingsPage.tsx`（表单字段 + 抽表单组件 + 模态）
- `web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`（齿轮按钮改为开模态）
- 对应 tests