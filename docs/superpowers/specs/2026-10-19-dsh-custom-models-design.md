# DSH 自定义模型（customModels）设计

- 日期：2026-10-19
- 状态：已实现（4b21185..bd80e9f，2026-10-19；后端 69 + dsh 目录 39 + 前端 11 测试全过，typecheck 零新增。实现期补充：自定义条目与预定义 value 撞车时丢弃后者（pickers 按 value 做 React key）；profileFormEntries 放行 string[] 使选档回填 customModels）
- 范围：backend/server（config、providers/dsh）、web 设置页；llm-proxy 零改动

## 1. 背景与问题

DSH provider 的模型下拉目前是写死的 4 项（`backend/server/modules/providers/list/dsh/dsh-models.provider.ts:55-63`）：

| value | label |
|---|---|
| `default` | Default (DeepSeek Harness) |
| `["deepseek-official","deepseek-v4-flash"]` | DeepSeek V4 Flash |
| `["deepseek-official","deepseek-flash"]` | DeepSeek V41 Flash |
| `["deepseek-official","deepseek-v4-pro"]` | DeepSeek V4 Pro |

value 是 JSON 编码的 `[route, model]` 二元组——dsh ACP `configOptions[model]` 的线格式，runner 经 `session/set_config_option` 原样下发（`server/dsh-acp-runner.js` `applySessionConfig`）。

问题：dsh 的 `deepseek-official` 路由**不锁模型**——端点（llm-proxy 或直连上游）服务什么 id 都行（dsh-models.provider.ts 头注释已实测：`glm-5.3-flash`、`claude-opus-4-8`、`GLM-5.3` 等均可达）。用户换供应商时模型名与 DeepSeek 官方不一致，却没有入口配置，只能用写死的 4 项。

对比：claude provider 的模型列表从 `app.config providers.claude` 派生（`claude-models.provider.ts` `buildClaudeModelOptions`，槽位可填任意具体 id），每次调用重算；dsh 没有这条派生路径。

## 2. 方案

**配置文件扩展**：`app.config` 的 `providers.dsh` 下新增 `customModels: string[]`，每条格式：

```
route|model          → label 缺省用 model 名
route|model|label    → 自定义显示名
```

示例：

```json
"dsh": {
  "customModels": [
    "deepseek-official|glm-5.3",
    "deepseek-official|DeepSeek-V4-Pro-0813|V4 Pro 0813",
    "sophnet|kimi-k2"
  ]
}
```

存储格式、与预定义列表的关系均已用户确认：**字符串数组**（非逗号分隔单串）、**追加不覆盖**。

### 2.1 后端解析（DshProviderModels.getSupportedModels）

静态 4 项在前，customModels 解析条目追加在后。每条解析成：

- `value` = `JSON.stringify([route, model])`——与官方条目线格式完全一致，runner 零改动
- `label` = 第三段，缺省用 model 名
- `description` = route 名（与官方条目一致）
- `effort` = 复用 `DSH_EFFORT`（`off/low/high/max`，default `high`）

`DEFAULT` 仍为 `'default'`，不受 customModels 影响。

**解析容错**：按 `|` split 后少于 2 段、或 route/model 段为空的条目直接跳过，不报错（与 claude 的 `oneMillionModels` 解析风格一致）。route/model 含 `|` 的场景不支持（可接受：dsh 的 route 名与模型 id 均不含 `|`）。

### 2.2 缓存处理（关键坑）

`provider-models.service.ts` 对 dsh 有 72 小时内存+磁盘缓存（`PROVIDER_MODELS_CACHE_TTL_MS`，:19），`UNCACHED_PROVIDERS` 目前只有 `claude`（:21）。只改 `getSupportedModels()` 的话，用户改完设置后下拉 **3 天不刷新**（见记忆 lovdex-dsh-provider-gaps 的同类坑）。

处理：把 `'dsh'` 加入 `UNCACHED_PROVIDERS`。理由：

- dsh 列表现在依赖 app.config，和 claude 一样是每次重算的廉价本地计算（纯字符串处理，不再是无状态静态表）
- 缓存本是给 codex/qoder/opencode 那种"跑 CLI 探测"的 provider 用的

### 2.3 配置层

- `DEFAULT_APP_CONFIG.providers.dsh` 加 `customModels: []`（`config.ts`）
- PUT `/api/config` 校验：`customModels` 非数组 → 400；数组内出现非字符串 → 400。格式非法的行（少于 2 段）**不**在写入时拒绝——删掉中间一行不该把整个保存变红，解析时跳过即可。

### 2.4 设置页入口

`web/src/components/settings/ProviderSettingsPage.tsx` 的 DeepSeek Section（:602-625）加一个多行文本框，每行一条 `route|model[|label]`，`patchProvider('dsh', 'customModels', lines)`（textarea 天然按行转数组）。

两个必须同步的白名单（既有契约"两边都要改"）：

- 后端 `backend/server/modules/config/provider-profiles.ts:32`：`dsh: ['baseUrl', 'apiKey', 'customModels']`——否则"保存到档"存不进凭据档
- 前端 `web/src/components/settings/providerProfiles.ts:37`：同步加 `'customModels'`

### 2.5 deepMerge 语义确认

`deepMerge` 对数组是整体替换（`override ?? base`，config.ts:175-176），所以 PUT 全量提交 `customModels` 数组 = 精确替换，无逐元素合并的歧义。

## 3. 数据流

```
设置页 textarea ──PUT /api/config──▶ app.config providers.dsh.customModels
                                              │
前端 GET /api/providers/dsh/models ◀─────────┤ (UNCACHED，每次重算)
                                              ▼
DshProviderModels.getSupportedModels() = 静态4项 + customModels 解析追加
                                              ▼
用户选中 → value = '["deepseek-official","glm-5.3"]' → runner applySessionConfig
        → dsh session/set_config_option → 路由到端点 → 端点按模型名应答
```

llm-proxy 零改动：dsh 经 `deepseek-official` 到 proxy 的请求，模型名未命中 `[routing]` 别名就原样透传（VLM 移除后的语义），端点什么模型就答什么。

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| customModels 条目格式非法（<2 段/空段） | 解析时静默跳过，其余条目正常 |
| route 填错（dsh 不认识） | dsh 运行时回 unknown route，runner 仅 warn 不 fatal（现状语义），用户自行修正 |
| PUT 传非数组/非字符串数组 | 400 |
| 自定义模型与预定义 value 重复 | 无所谓——前端下拉出现两个同 value 项，选哪个等价 |

## 5. 测试

- **dsh-models.provider 单测**（新文件 `dsh-models.provider.test.ts`）：正常条目、带 label、缺 label、空行/垃圾行跳过、追加顺序（自定义在预定义之后）、DEFAULT 不变
- **config 层测试**：DEFAULT_APP_CONFIG 带 `customModels: []`；PUT 校验数组类型（非数组 / 含非字符串 → 400）
- **profile 测试**：`snapshotProviderFields` 能带出 customModels
- **service 层测试**：dsh ∈ UNCACHED_PROVIDERS，`getProviderModels('dsh')` 不读也不落缓存
- 前端仅 textarea 的换行 `split('\n')` / `join('\n')` 转换，无分支逻辑，不新增测试

## 6. 不做的（YAGNI）

- 前端聊天弹窗里的自由输入（后续真需要再说）
- codex/qoder/opencode 的写死列表（无"换供应商改模型名"痛点；qoder 已有 runtime 回报追加机制）
- route 合法性校验（route 由 dsh patch/profile 决定，Lovdex 无法枚举）
