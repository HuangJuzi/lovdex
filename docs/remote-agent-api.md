# Remote-Lite Agent 接口文档

> 覆盖对象：`backend/remote-agent`（lite）。lite 是部署在远程机器上的常驻代理，被 Lovdex 主后端（以下称 **main**）通过 WebSocket 反向接入，用来在远端机器上跑 AI CLI 会话（claude/qoder…）、操作远端文件系统、执行远端 git 与探测远端环境。
>
> 帧协议与全部 RPC 参数/响应 schema 在 `server/shared/agent-runtime/protocol.ts`；lite 端分发逻辑在 `backend/remote-agent/src/rpc-dispatch.ts`。本文档按线上行为整理，**以源码为准**。

## 1. 拓扑与连接

```
┌────────────────────────┐  WS (反向接入)  ┌───────────────────────┐
│  main (Lovdex 后端)    │ ◄────────────── │  lite (远端主机代理)   │
│  ws server             │  token 鉴权     │  ws client 自连回 main │
└────────────────────────┘                └───────────────────────┘
```

- lite **主动**向 main 的 WebSocket 地址发起连接（`POST /api/remote-agents/ws` 升级），地址来自本地 `config.json` 的 `serverUrl`，连接时自动追加 `?token=<token>`。
- 直连场景 lite 访问 main 的监听地址；隧道场景 main 通过 `ssh -R` 把远端回拨口转发回本机（见 `remote-tunnels.ts`）。
- 心跳：lite 每 **15s** 发 `ping`，main 回 `pong`；main 侧同时有保活探测。
- 断线重连：默认 **3s** 后重连（`RECONNECT_MS`）。重连成功后 `hello` 重新注册身份，push 总线重新指向新 socket（`setPushEmitter`）。
- **致命关闭码不重试**：main 用 `4001 invalid token` / `4002 host id mismatch` 拒绝时，lite 记日志并**以码 0 退出**（systemd `Restart=on-failure` 视为干净停止，避免死循环刷日志）。

## 2. 鉴权与握手

连接建立后 lite 发送首个帧 `hello`：

```jsonc
{
  "type": "hello",
  "hostId": "bf38bf4f-...",
  "agentVersion": "0.1.0",
  "nodeVersion": "v22.22.0",
  "os": "linux",
  "roots": ["/home/sophgo/workpath"],            // 允许操作的目录白名单
  "capabilities": [ "session/claude", "session/messages", "fs/stat", "fs/list", "fs/read", "fs/write", "fs/tree", "fs/create", "fs/rename", "fs/delete", "git/exec", "providers/probe" ],
  "providers": [                                  // 可选：启动探针结果
    { "provider": "claude", "installed": true, "version": "2.x.x" }
  ]
}
```

- `token` 由 main 侧校验；**首个 hello 的 `hostId` 必须与 token 绑定的主机一致**，否则 main 以 `4002` 关闭（防伪造/冒名）。
- main 广播 `rpc_res{id:"hello", ok:true}` 表示接受。
- `capabilities` 是 lite 自描述的完整 RPC 能力列表，main 据此向使用者暴露远端能力。

## 3. 帧协议

所有帧为 JSON 文本（ws 消息）。

### lite → main（`AgentFrameIn`）

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `hostId, agentVersion, nodeVersion, os, roots[], capabilities[], providers?[]` | 连接握手，仅首帧 |
| `rpc_res` | `id, ok, data?, error?` | 对 `rpc_req` 的应答；失败时 `error` 为人类可读消息 |
| `push` | `topic, payload` | 主动事件推送（见 §7 Push 主题） |
| `pong` | `at` (ms epoch) | 对 `ping` 的应答 |

### main → lite（`AgentFrameOut`）

| type | 字段 | 说明 |
|---|---|---|
| `rpc_req` | `id, method, params` | 方法调用；`id` 全局限定（uuid） |
| `rpc_cancel` | `id` | 中断在途请求（kill git 子进程等） |
| `ping` | `at` (ms epoch) | 保活探测 |

lite 收到 `rpc_req` 会为每个在途 id 挂一个 `AbortController`；`rpc_cancel` 触发它，长任务（session/git）据此尽快停止。

## 4. RPC 方法参考

统一语义：`rpc_req` → 成功回 `rpc_res{ok:true, data}`；异常回 `{ok:false, error}`。参数用 zod 校验，非法参数直接 `error`。

### 4.1 `session/start`

启动一个远端 AI CLI 会话（claude）。这是远程运行的核心入口。

| 参数 | 类型 | 说明 |
|---|---|---|
| `appSessionId` | string | main 侧应用级会话 id（全局限定） |
| `providerSessionId` | string \| null | 续跑时传入的原生会话 id；首次为 null |
| `provider` | `'claude'`\|`'codex'`\|`'opencode'`\|`'qoder'` | 默认 `claude`；当前仅 claude 落地，codex/opencode/qoder 为多 provider 改造预留 |
| `command` | string | 提示词 |
| `cwd` | string | 工作目录；必须存在且落在 `roots` 内（I4 强校验） |
| `model` | string? | 可选模型覆盖 |
| `permissionMode` | string? | 默认 `default` |
| `includePartialMessages` | boolean? | 默认 true |
| `configEnv` | Record<string,string> | 按会话下发的 provider 配置 env（仅本次 run 合并进子进程环境，**不透写 lite 自己的 env**） |

成功响应：

```jsonc
{ "providerSessionId": "484297d7-..." }
```

- `providerSessionId` 早期即可解析：入参带 `resume` 则立即确认；否则取 SDK 流第一条带 `session_id` 的事件。
- 会话运行期间 SDK 事件经 `normalizeAgentEvent` 推送到 `session:<appSessionId>` 主题（见 §7）；结束推 `complete` 终态帧。
- main 侧 rpc 等待超时（约 60s）：`providerSessionId` 迟迟不出现则 rpc 报错。重复 `start` 同一 `appSessionId` 会拒绝（`session already running`）。

### 4.2 `session/messages` ⭐（远程历史）

读取**本机**上的会话 transcript 并返回**原始文件内容**（解析/归一化全部在 main 侧，与本地历史共用同一核心，lite 不重复实现解析规则）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `provider` | `'claude'`\|`'qoder'` | transcript 目录布局按 provider 区分 |
| `providerSessionId` | string | 原生会话 id |
| `projectPath` | string | 项目路径，用于编码 transcript 子目录 |

目录布局（lite 本机 `$HOME`）：

| provider | 目录 |
|---|---|
| claude | `~/.claude/projects/<encode(projectPath)>/<providerSessionId>.jsonl`；`encode` = 非 `[a-zA-Z0-9-]` 全部转 `-` |
| qoder | `~/.qoder/projects/<encode(projectPath)>/<providerSessionId>.jsonl`；`encode` = `/` 转 `-` |

成功响应：

```jsonc
{
  "transcript": "{...}\n{...}\n",            // 主 jsonl 全文；文件不存在为 ""
  "agentFiles": { "xyz": "{...}\n" }         // 同目录下 agent-<id>.jsonl 原文，按 agent id
}
```

错误/缺失语义：主文件不存在 → 返回 `{transcript:"", agentFiles:{}}`（等价 Phase-1 的空历史），不报错。

### 4.3 `session/interrupt`

中断一个在途会话。

| 参数 | 说明 |
|---|---|
| `appSessionId` | string |

响应：`{ "interrupted": boolean }`。

### 4.4 `approval/respond`

响应一个工具审批请求（在 `session/start` 的 run 内由 SDK `canUseTool` 挂起）。

| 参数 | 说明 |
|---|---|
| `requestId` | string（工具事件里的 `tool_use_id`） |
| `decision` | `{allow:true}` / `{deny:true, message?}` 或 SDK 式 `{behavior, ...}` |

响应：`{ "accepted": boolean }`。审批超时（默认 120s）自动 deny 并推 `cancelled`。

### 4.5 `fs/*` —— roots 白名单文件系统

所有路径先经 `resolveWithinRoots` 校验（真实路径 + 符号链接/`..` 逃逸拒绝），再执行系统调用。

#### `fs/stat`

| 参数 | 说明 |
|---|---|
| `path` | string |

响应：

```jsonc
{ "exists": true, "isDirectory": false, "isFile": true, "size": 4096, "mtimeMs": 1787181235000 }
```

#### `fs/list`

| 参数 | 说明 |
|---|---|
| `path` | string |
| `maxEntries` | number? 默认 200，上限 2000 |

响应：

```jsonc
{ "path": "/srv/app", "entries": [ { "name": "src", "type": "dir", "size": null } ] }
```

`type`: `'dir'|'file'|'symlink'`；文件 `size` 为字节数、`dir` 为 null。

#### `fs/read`

| 参数 | 说明 |
|---|---|
| `path` | string |
| `maxBytes` | number? 默认 1 MiB，上限 32 MiB |
| `encoding` | `'utf8'|'base64'`，默认 utf8 |

响应：`{ "content": "...", "truncated": boolean }`（超 `maxBytes` 截断并置 `truncated`）。

#### `fs/write`

| 参数 | 说明 |
|---|---|
| `path` | string |
| `content` | string |
| `encoding` | `'utf8'|'base64'`，默认 utf8 |

响应：`{ "success": true, "size": 123 }`。

#### `fs/create`

| 参数 | 说明 |
|---|---|
| `parentPath` | string |
| `type` | `'file'|'directory'` |
| `name` | string |

响应：`{ "success": true, "path": "/srv/app/new.txt" }`。

#### `fs/rename`

| 参数 | 说明 |
|---|---|
| `oldPath` | string |
| `newName` | string |

响应：`{ "success": true, "newPath": "/srv/app/renamed.txt" }`。

#### `fs/delete`

| 参数 | 说明 |
|---|---|
| `path` | string |
| `type` | `'file'|'directory'` |

响应：`{ "success": true }`。

#### `fs/tree`

| 参数 | 说明 |
|---|---|
| `path` | string |
| `maxDepth` | number? 默认 10，上限 20 |
| `showHidden` | boolean? 默认 true |

响应：`{ "path": "...", "nodes": RemoteFileTreeNode[] }`；节点含 `name/path/type/size/modified/permissions(八进制+rwx)/isSymlink/children?`。

### 4.6 `git/exec`

在 roots 白名单内执行固定 git 命令集（任意 `args` 数组，但禁止重定向类选项）。

| 参数 | 说明 |
|---|---|
| `args` | string[]，至少 1 项 |
| `cwd` | string，必须落在 roots 内 |
| `identity` | `{name,email}?`；存在时以 `-c user.name=... -c user.email=...` 注入提交身份 |
| `timeoutMs` | number? 默认 300_000 |

**禁止选项**：`-C`、`--git-dir`、`--work-tree`、`--exec-path`（防止把操作引到 roots 之外）；参数含 NUL 拒绝；`git fetch/pull/push` 等网络操作用 detach 进程组，超时/中断可整组 SIGKILL（防 helper 子进程悬挂）。

响应：`{ "stdout": "...", "stderr": "...", "exitCode": 0 }`。

### 4.7 `providers/probe`

探测远端环境：四位 provider CLI 是否安装 + git + node + OS。

| 参数 | 说明 |
|---|---|
| `refresh` | boolean? 默认 false |

响应：

```jsonc
{
  "providers": [
    { "provider": "claude", "installed": true,  "version": "2.0.x" },
    { "provider": "codex",  "installed": false, "version": null },
    { "provider": "opencode","installed": false,"version": null },
    { "provider": "qoder",  "installed": false, "version": null }
  ],
  "gitInstalled": true,
  "gitVersion": "2.39.2",
  "nodeVersion": "v22.22.0",
  "os": "linux x64"
}
```

版本探测：`<bin> --version`，5s 超时。`qoder` 的二进制名是 `qodercli`（与其余三家同名 bin 不同）。

## 5. 未知方法

`rpc_dispatch` 对未识别方法抛 `unknown rpc method: <method>` → 以 `{ok:false, error}` 返回。严格：**没有方法时不要期待空成功**。

## 6. 取消与超时

- main 侧：`registry.rpc(hostId, method, params, timeoutMs=60_000, signal?)`，宿主离线/超时/被 `rpc_cancel` 都会 reject；abort 时向 lite 补发 `rpc_cancel`。
- lite 侧：每个在途 `rpc_req` 对应一个 `AbortController`；`rpc_cancel` 直接 `abort()`，git 子进程/会话循环据此尽快停止；结束时清理 `inflight` 映射并回 `rpc_res`。
- WS 断开：lite 对**所有**在途会话执行 `interruptAll`（防止残留 run 挡后续 resume）。

## 7. Push 主题（lite → main）

| 主题 | payload | 说明 |
|---|---|---|
| `session:<appSessionId>` | 归一化 SDK 事件（`normalizeAgentEvent` 输出） | 会话消息流；每条即一条写就绪消息 |
| `session:<appSessionId>` (终态) | `{ type:"complete", providerSessionId, done:true, exitCode? }` | 运行结束帧；失败时 `exitCode:1` + `error` |
| `approval:<requestId>` | `{ appSessionId, approval: { tool_use_id, name, input } }` | 工具审批请求 → main 转权限弹窗 |
| `approval:<requestId>` (取消) | 同上 + `cancelled: true` | 审批超时/run 结束时自动 deny |

## 8. 配置（`config.json`）

默认路径：运行用户 `~/.lovdex-remote/config.json`；可用 `LOVDEX_REMOTE_CONFIG` 环境变量或显式 `--config` 覆盖。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `serverUrl` | string | ✅ | main WS 地址（连接时追加 `?token=`） |
| `token` | string | ✅ | ≥8 字符，与 main `remote_hosts` 表 token 哈希匹配 |
| `hostId` | string | ✅ | 稳定标识；与 token 绑定 |
| `roots` | string[] | ✅ | ≥1；操作白名单，**无 `/` 默认值** |
| `agentVersion` | string | — | 默认 `0.1.0` |
| `apiKeyEnvPath` / `claudeCliPath` | string | — | 预留的会话级配置入口 |

## 9. 部署

- main 侧 `buildLitePackage`：用 esbuild 把 `backend/remote-agent/src/index.ts` 打成**单文件 ESM** `dist/lite.mjs`（依赖内联，`--banner:js` 注入 `createRequire` 垫片），连同 `package.json` 打成 `lite.tgz`。
- bootstrap 通过 scp 推到远端 `~/.lovdex-remote/lite.tgz`，`install.sh` 就地展开，systemd unit `ExecStart=node dist/lite.mjs` 拉起。
- 每次部署会重铸**确定性 token**（按 hostId 派生），运行中的 lite 复用同一 token + 哈希，滚动部署不打断鉴权。

## 10. 安全边界（重要）

1. **roots 白名单**是硬边界：`fs/*`、`git/exec` 的 `cwd`、`session/start` 的 `cwd` 全部在 syscall 前 `resolveWithinRoots` 校验——符号链接、`..`、realpath 逃逸一律拒绝。
2. **身份绑定**：`hello.hostId` 必须与 `?token=` 的主机一致；rpc 只能发给已 `hello` 的 host，且每帧都校验身份。
3. **git 禁选项**：`-C/--git-dir/--work-tree/--exec-path` 拒绝，防越 roots。
4. **会话 cwd 校验**：root 之外目录的 `session/start` 直接拒绝。
5. **credential 不入库**：`agent_token_hash`/`key_credential_id` 永不从路由序列化；推包不落明文密钥。

## 11. 演进备注

- `capabilities` 自描述：新加 RPC method 时应同步加入 hello 列表（`session/messages` 已加入）。
- 多 provider（codex/opencode/qoder）的 `session/start` 通用化仍在计划中；`session/messages` 目前支持 claude + qoder 的 JSONL 布局，opencode（sqlite 库）/codex 待补。
- 主侧历史拉取路径：`fetchHistory` → `lookupRemoteHost(project_path)` 命中 → `runtime.historyClient.fetchMessages` → `session/messages` → 共享解析 `server/modules/providers/list/shared/transcript-history.ts`。