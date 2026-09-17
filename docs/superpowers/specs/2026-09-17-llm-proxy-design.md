# Lovdex 融合 llm-proxy 设计（方案 A）

日期：2026-09-17

## 背景与目标

引入 [zzttzzmyswy/llm-proxy](https://github.com/zzttzzmyswy/llm-proxy)（一个单文件 Go 的 Anthropic 透明代理）到 Lovdex，达成三个目标：

1. **修复 LLM 偶发报错** —— llm-proxy 已实现了一组针对第三方 Anthropic 兼容上游（sophnet / DeepSeek 系）的流式修复，正好覆盖 Lovdex 已知的崩溃（如 `s.thinking.length`）。
2. **远程设备走本地转发** —— 远程 lite 设备不需要自己联网、也不需要直连本机端口，LLM 流量复用已有的 lite WS 反连通道回到本机，由本机代理访问上游。
3. **覆盖 claude + codex/opencode** —— claude 走 Anthropic `/v1/messages`，codex/opencode 走 OpenAI `/v1/chat/completions`，共用同一条转发隧道。

### 关键约束（用户确认）

- 远程设备通过 **lite WS 反连**（远程主动拨回本机 `:3188`，可能走 `ssh -R` 反向隧道）连到本机。
- 除这条 WS 通道外，**远程设备直连不了本机的其他端口**。因此远程 LLM 流量**必须**复用这条 WS，不能把远程的 `baseUrl` 指到本机代理端口。

## 总体架构与数据流

```
本机（local）:
  claude CLI ──HTTP──> llm-proxy (127.0.0.1:8088, Go sidecar) ──HTTP──> sophnet 上游

远程（lite）:
  claude CLI ──HTTP──> lite 转发器 (127.0.0.1:18088, 编进 lite.mjs)
        ──WS llm_req/llm_res──> 本机后端 relay ──HTTP──> llm-proxy (127.0.0.1:8088) ──> sophnet
```

llm-proxy 的完整逻辑（模型路由、报错修复、VLM 图片描述、OpenAI 透传）只在本机跑一份；远程侧只有一个"HTTP↔WS 桥"的薄转发器，不含任何上游/密钥/模型逻辑。

## 组件与职责

| 组件 | 位置 | 职责 |
|---|---|---|
| **llm-proxy** | `backend/llm-proxy/`（vendored Go 源码）| 模型路由、报错修复、VLM 图片描述、`/v1/chat/completions` 透传；监听 `127.0.0.1:8088` |
| **后端 relay** | `backend/server/modules/remote-agents/` | 收到 lite 的 `llm_req` 帧 → 转成对本地 llm-proxy 的 HTTP 请求 → 把响应流式切成 `llm_res` 帧发回 |
| **lite 转发器** | `backend/remote-agent/src/`（编进 lite.mjs）| lite 启动时在 `127.0.0.1:18088` 起一个 loopback HTTP server；把 `{method,path,headers,body}` 打包成 `llm_req` 走 WS，收到 `llm_res` 后写回 CLI |
| **supervisor** | `supervisor/services.mjs` | 新增一个 `llm-proxy` 服务项（构建/拉起 Go 二进制）|

## WS 协议扩展

现有帧（`backend/server/shared/agent-runtime/protocol.ts`）：

- lite→主：`hello` / `rpc_res` / `push` / `pong`
- 主→lite：`rpc_req` / `rpc_cancel` / `ping`

**目前没有"lite→主的请求/响应"通道**（`push` 是单向通知），因此新增一对帧：

- `llm_req`（lite→主）：`{ type:'llm_req', id, method, path, headers, bodyBase64 }`
- `llm_res`（主→lite）：`{ type:'llm_res', id, status, headers, chunkBase64, done }`

流式语义：一个 `llm_req` 对应多个 `llm_res` 帧，`body` 按块（base64）分帧下发，末帧 `done:true`。转发器是**通用**的：`path` 原样透传，所以 `/v1/messages`（Anthropic）和 `/v1/chat/completions`（OpenAI）走同一条隧道，后端 relay 按 path 转发给 llm-proxy，由 llm-proxy 自己按 path 分派。`id` 用于在 lite 侧匹配请求/响应与中断（预留 `llm_cancel`）。

## 报错修复清单（直接继承 llm-proxy，零改动）

本机走代理后自动生效：

1. SSE 缺 `message_stop` 补帧（防 Claude Code 卡死）
2. 损坏 thinking 块规范化（`thinking` 字段缺失补空串 + `signature` 清空——对应 Lovdex 已知的 `s.thinking.length` 崩溃）
3. 空响应发 `error` SSE 事件触发重试
4. thinking 400 "must be passed back" 逐级重试（先剥 thinking 块，再关 thinking 参数）
5. 图片 400 "do not support image" 回退 VLM
6. 禁用 gzip（防 SSE 缓冲被破坏）、180s 响应头超时
7. VLM 图片先描述后路由 + 20MB 描述缓存

## 配置与密钥

在 `app.config.json` 新增 `llmProxy` 段（沿用 `backend/server/modules/config/config.ts` 的 `DEFAULT_APP_CONFIG` 与 deep-merge / 原子持久化机制）：

```
llmProxy: {
  enabled: true,
  port: 8088,
  anthropicUrl: "https://www.sophnet.com/api/open-apis/anthropic",   // 代理的上游
  openaiUrl:    "https://www.sophnet.com/api/open-apis/openai",
  vlmModel: "...", vlmMaxTokens: 8000,
  routing: { sonnet/opus/haiku → 模型名, 可选表值 { model, upstream } 选网关 }
}
```

**baseUrl 语义变化**（`enabled=true` 时）：

- `providers.claude.baseUrl` 的语义是"claude CLI 的目标地址"，改为 `http://127.0.0.1:8088`（= 本地代理）。`syncProviderEnv` 照旧把 `ANTHROPIC_BASE_URL` 写成 `c.baseUrl`，因此本机 claude 自动指向代理。
- `llmProxy.anthropicUrl` = 代理真正的上游（sophnet）。
- **升级迁移**：首次启用时若 `llmProxy.anthropicUrl` 为空，用旧的 `providers.claude.baseUrl`（sophnet）填充它，再把 `providers.claude.baseUrl` 改写为 `http://127.0.0.1:8088`。

- 上游密钥**复用 `providers.claude.apiKey`**（即现有 sophnet key）。backend 在拉起 Go 进程时生成 TOML 并注入 `SOPHNET_API_KEY` 环境变量，不新增密钥。
- `SENSITIVE_KEYS` / `SENSITIVE_CONTAINER_KEYS`（`config.ts`）补上 llmProxy 相关字段，保证匿名 `GET /api/config` 继续打码。
- supervisor 的 `env-filter.mjs` 若需注入 `SOPHNET_API_KEY`，与 `OWNED_ANTHROPIC_ENV`（`env-sync.ts`）保持同步。

## 模型路由归属（已定：方案 A）

模型路由**仍留在 CLI 侧**（`providers.claude.sonnetModel/opusModel/haikuModel` → `ANTHROPIC_DEFAULT_*_MODEL` 不变）。llm-proxy 的 routing 表基本空转，主要承担**报错修复 + VLM 图片 + 远程转发**。现有行为零变化。

> 备选方案 B（清掉 CLI 侧 `ANTHROPIC_DEFAULT_*_MODEL`、把路由集中到 llm-proxy）留作后续，需要时再切。

## 远程 configEnv 与转发器端口

- 远程 claude 会话的 `configEnv.ANTHROPIC_BASE_URL` 由主进程在 `buildProviderConfigEnv`（`env-sync.ts:107`）里构造时改为 `http://127.0.0.1:18088`（lite 转发器端口），**不再下发 sophnet URL**。`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 对远程可下发任意占位值（代理会注入真实上游密钥）。
- lite 转发器端口默认 `18088`，作为固定约定；lite 配置可覆盖，主进程用固定常量（v1 不做 hello 协商）。
- **已确认的缺口一并修复**：`headless-task-run.service.ts:108-133` 目前构造 `runtimeOptions` 时**不带 `configEnv`**，导致远程项目上的 headless 任务漏掉代理地址/凭据。融合时在该处补上与 `chat-websocket.service.ts:273-281` 等价的 `configEnv` 注入。

## codex/opencode 备注

- 转发隧道对协议无关，codex/opencode 只需把各自 CLI 的 base URL 指到 lite 转发器 `127.0.0.1:18088`，隧道后端 relay 按 path 转发到 llm-proxy 的 `/v1/chat/completions`（原样透传到 `openaiUrl`）。
- codex 的 base URL 接线方式（`~/.codex/auth.json` / SDK 配置）在实现阶段需先验证确认；opencode 沿用 `apiKeys` 机制。

## 测试与验收

- llm-proxy 自带 `go test ./...`（协议互译 / SSE / thinking / VLM 缓存）。
- lite 转发器单测：HTTP→WS→relay→mock 上游→WS→HTTP 往返 + 流式分帧。
- 后端 relay 单测：`llm_req` → 本地 mock → `llm_res` 分帧正确。
- E2E：真机远程会话冒烟，确认 claude CLI 请求走了隧道、报错修复生效、远程无外网可运行。

## 非目标（本次不做）

- 不重写 llm-proxy 为 TypeScript（方案 B）。
- 不把 LLM 执行整体搬回本机（方案 C）。
- 不覆盖 qoder（协议不同，llm-proxy 无法直接覆盖）。
- 不做模型路由集中化（方案 A 的备选 B 留待后续）。
