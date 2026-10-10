# 多套 baseUrl / API Key 配置档（provider profiles）设计

- 日期：2026-10-10
- 状态：设计已确认，待实现
- 范围：后端 `backend/server/modules/config/`（新增一个 router + 一处 PUT 规则）+ 前端设置页 Provider Tab。
- 前置：无。既有 `GET/PUT /api/config`、`syncProviderEnv`、`llmProxyManager.reconcile()` 均不改语义。

## 1. 背景与目标

### 1.1 现状

用户手上有多个平台的 API Key（sophnet 一类 Anthropic 兼容网关）需要来回切。但现在：

- 凭据唯一真源是 `~/.lovdex/data/app.config.json`，`providers.claude` 下只有**一份** `apiKey` + `baseUrl`（`config.ts:33` 是 sophnet 默认值）。
- 设置页就是一组平铺输入框（`ProviderSettingsPage.tsx:296` 起），没有任何"多套配置"的概念。
- 要换平台只能手改 baseUrl + 重填 key + 四个模型名（不同平台模型名不同，漏改一个就 400/404）。

### 1.2 目标

每个 provider 能存**多套命名配置档**，在设置页下拉选中后点保存即切换到该套，无需重填密钥。

### 1.3 非目标（明确不做）

- **不做全局快捷入口。** 只在设置页 Provider Tab 内（用户已确认）。顶栏/侧栏不做快切下拉。
- **不改 `providers.*` 的生效语义。** 生效字段仍是唯一真源，`env-sync.ts` / `buildProviderConfigEnv` / `resolveDshProviderEnv` / `llm-proxy` **一行不动**。
- **不把配置档做成"生效指针"**（`providers.claude.activeProfile` + `get()` 返回解析视图）。方案 B，已否决：`get()`/`getRaw()` 语义分叉，读 `get()` 的代码全都拿到视图而非落盘值。
- **不用前端 localStorage 存档**（方案 C，已否决）：密钥明文落浏览器，且打码串 PUT 上去会被服务端丢弃、根本切不过去。
- **不纳入 `llmProxy.*` 到配置档**（用户已确认配置档内容 = baseUrl + apiKey + 模型名）。
- **不纳入 `oneMillionModels`、`dshHome`、`patchPath`**。要加只是白名单加一行。
- **不做配置档数量上限、不做导入导出、不做同名去重**。

## 2. 核心约束：密钥不能经由浏览器在两处之间搬运

这条决定了整个方案的形状。

`GET /api/config` 返回的 apiKey 是打码串（`sk-abc****567890`，`config.ts:189` 的 `maskConfig` → `maskApiKey`）。而 `PUT` 时 `stripMaskedPlaceholders`（`config.routes.ts:58`）会把**含 `****` 的字符串整个丢掉**当作"未改动"。

于是"把当前生效的 key 存成一个新配置档"若走前端 PUT，存下去的是一个**没有 key 的空壳**——切过去直接把 key 清空。同理"把 B 档的 key 填进表单再保存"也表达不出来（表单里的打码串会被服务端理解为"保持当前生效值"，而当前生效值是 A 档的 key）。

**结论：所有"在两处之间复制密钥"的动作必须由服务端完成。**客户端只能发**非密钥**的载荷（档 id、档名、非密钥字段）；密钥的取值路径是 `app.config.json → app.config.json`，不经过浏览器。

## 3. 数据模型

`app.config.json` 新增**两个顶层键**（不进 `providers`，避免污染 env-sync 遍历的对象）：

```jsonc
"providerProfiles": {
  "claude": {
    "p_9f3c1a": {
      "name": "sophnet 主账号",
      "values": {                    // 白名单字段的完整快照，真值，从不出浏览器
        "baseUrl": "https://www.sophnet.com/api/open-apis/anthropic",
        "apiKey": "sk-真-key",
        "defaultModel": "DeepSeek-V4-Flash-0731",
        "opusModel": "DeepSeek-V4-Pro-0813",
        "sonnetModel": "claude-opus-4-8",
        "haikuModel": "DeepSeek-V4-Flash-0731"
      }
    }
  },
  "codex": {}, "opencode": {}, "qoder": {}, "dsh": {}
},
"activeProviderProfiles": { "claude": "p_9f3c1a" }   // 仅供 UI 标注「当前档」，不是真源
```

`AppConfig` 类型（`config.ts:134` 由 `DEFAULT_APP_CONFIG` 推导）随之增加两个字段，默认值 `{}`。

### 3.1 白名单（快照范围 = 应用范围）

| provider | 字段 |
|---|---|
| `claude` | `baseUrl` `apiKey` `defaultModel` `opusModel` `sonnetModel` `haikuModel` |
| `codex` | `binPath` `apiKey` |
| `opencode` | `binPath` `apiKeys`（整个 env→key 映射一起存） |
| `qoder` | `personalAccessToken` |
| `dsh` | `baseUrl` `apiKey` |

白名单以常量表形式放在新模块里，是"快照取哪些字段"和"UI 渲染哪些字段"的同一份依据。

已知不一致（**本次不修**，属既有技术债）：`codex.apiKey` 在设置页有输入框，但 `syncProviderEnv` 从不把它写进 env（codex 认证走 `~/.codex/auth.json`，见 `env-sync.ts:152` 的 `buildProviderConfigEnv`）。把它纳入配置档只是保持一致，不会让 codex 突然可用。

### 3.2 打码

`maskConfig` 已按 key 名递归打码（`config.routes.ts` / `config.ts:189`）：`providerProfiles.claude.<id>.values.apiKey` 命中 `apiKey` → `maskApiKey`；`qoder.*.personalAccessToken` 命中 `SENSITIVE_KEYS`；`opencode.*.apiKeys` 命中 `SENSITIVE_CONTAINER_KEYS`（`config.ts:152`）。**无需新增打码代码。**

`activeProviderProfiles` 只有档 id，不打码。

需要知道的暴露面：`GET /api/config` 是**匿名**的（`config.routes.ts:16`，登录页要用）。配置档的**名字**与 baseUrl/模型名会对匿名访问者可见。baseUrl/模型名今天就已可见，新增暴露的是档名（"sophnet 主账号"这类）。判定为可接受。

## 4. API 契约

### 4.1 `PUT /api/config`（既有端点，加一条规则）

body 可以带档标记：

```jsonc
{
  "providers": { "claude": { "baseUrl": "...", "apiKey": "sk-abc****567890", "defaultModel": "..." } },
  "activeProviderProfiles": { "claude": "p_9f3c1a" }
}
```

服务端处理顺序（`config.routes.ts:30` 的 `buildConfigWriteRouter`）：

1. `body = stripMaskedPlaceholders(req.body)`（既有，不动）。
2. 对每个 `[provider, id] of Object.entries(body.activeProviderProfiles)` 且 `id` 为非空字符串：
   - 查 `cfg.get().providerProfiles[provider]?.[id]`；**不存在 → `404 { error: { message } }`**（不静默忽略）。
   - 把该档的 `values` 深拷贝后与该 provider 的 body 字段**合并**，结果写回 `body.providers[provider]`。
     合并**必须走 `deepMerge(values, bodyProvider)`**，不能对象展开：strip 后的打码字段值是 `undefined` 但**键还在**，`{...values, ...bodyProvider}` 会把真 key 覆盖成 `undefined`；`deepMerge` 的 `override ?? base`（`config.ts:156`）才会把它当作"未提供"而保留档里的真值。
     `deepMerge` 目前是 `config.ts` 的模块私有函数（`config.ts:154`）——需要 `export` 出来，或把这段解析逻辑直接放进 `config.ts`。倾向后者：解析函数与 `deepMerge` 同文件，语义耦合更近。
3. `syncProviderEnv(cfg.update(body))` → `onWrite` → `llmProxyManager.reconcile()`（全部既有）。

于是：

| 客户端动作 | 结果 |
|---|---|
| 只选档（表单字段即该档值） | 生效字段**完全等于**该档 |
| 选档 + 手改模型 | 该档的 `baseUrl`/`apiKey` + 你改的模型 |
| 选档 + 手填新 apiKey | 新 key 生效（真实字符串不是打码串，body 覆盖档值） |
| 选档 + 清空 apiKey | key 被清（`''` 不是打码串，body 覆盖 → `setOrDelete` 删掉 env） |

**`null` 的坑（必须写死）**：`deepMerge` 用 `override ?? base`，**`null` 被当作"未提供"而保留旧值**。所以"切回自定义"要清档标记，UI 必须发**空串 `''`**（`'' ?? base` → `''`，falsy，等效无档），**不能发 `null`**。

### 4.2 `POST /api/config/provider-profiles`（新增）

body：`{ "provider": "claude", "name": "sophnet 主账号" }`

- 用**当前生效字段**（白名单内）`structuredClone` 出真值快照，生成新 id，写进 `providerProfiles[provider][id]`。
- 返回 masked 的 `GET /api/config` 同形 body（前端直接拿它替换 draft）。
- **不触发** `syncProviderEnv` / `reconcile()`：新建档不改变任何生效字段。

### 4.3 `DELETE /api/config/provider-profiles/:provider/:id`（新增）

- 删掉该档。若它正是 `activeProviderProfiles[provider]`，顺手把标记清成 `''`（**生效字段不动**）。
- 返回 masked 的 `GET /api/config` 同形 body（与 POST 一致，前端直接替换 draft）。
- 同样**不触发** env 同步 / 代理重启。
- 未知 provider / id → `404`。

### 4.4 重命名：不新增端点

直接 `PUT { providerProfiles: { claude: { p_9f3c1a: { name: '新名' } } } }`。`name` 不是密钥，`deepMerge` 直接改掉。

### 4.5 挂载

`index.js:420-421` 之后追加一行（沿用同一鉴权）：

```js
app.use('/api/config', authenticateToken, buildProviderProfilesRouter({ cfg: cfgStore }));
```

`GET /api/config` 保持匿名不受影响（读 router 只声明 `GET '/'`，非 GET 请求会落到后面的中间件）。

## 5. UI 设计（设置页 Provider Tab）

每个 provider 的 `Section` 头部（`ProviderSettingsPage.tsx:169`）现在是「标题 + 认证状态」，加一行紧凑控件：

```
Claude                                        已认证（xxx）
配置档  [ sophnet 主账号 ▾ ]   [存为新档] [重命名] [删除]
```

### 5.1 下拉行为

选项 =「自定义（不归属任何档）」+ 各档名。

- 选某档 → 把该 provider 的**表单字段**替换成该档的值（`apiKey` 显示该档的打码串，其余字段是真值）。**此刻不写盘**。
- 档名在被手改过时加后缀 `（已修改）`；**不加后缀即表示表单与该档一致**。比对在客户端做——打码串也能比，因为打码由真值决定，值同则码同。
  （早期草稿还提过一个正向的 `当前` 徽标；实现时判定它与"无后缀"表达同一件事、纯属冗余，故未做。）
- 切到「自定义」→ 表单值不动，只是保存时发 `activeProviderProfiles[provider] = ''`。

### 5.2 保存

页脚那个全局「保存」按钮不动。它 PUT 出去的 body = 各 provider 的表单字段 + 各下拉当前的档标记。于是"选档→保存"= 应用该档，"选档→改模型→保存"= 该档的 key/url + 你改的模型（第 4.1 节的表）。

### 5.3 三个操作按钮

- **存为新档** → 输入名字 → 先 `PUT(draft)`（把表单里未保存的修改落进生效字段）→ 再 `POST(provider, name)` → 用返回的 masked 配置刷新 draft，下拉切到新档。
  下拉停在某档时点它 = 把该档复制成新档（因为 PUT 阶段会先把该档真值应用上去）。
- **重命名** → 输入名字 → `PUT { providerProfiles: { <p>: { <id>: { name } } } }`。
- **删除** → 二次确认 → `DELETE`。删的若正是当前档，下拉回落到「自定义」，**表单值原样保留**（用户不会因为删档丢掉当前配置）。

### 5.4 文案

Section 内加一行小字：

> 配置档由服务端保管密钥；切换后点保存生效，**只影响新会话**（运行中的会话沿用启动时的凭据）。

`llmProxy.enabled === true` 且 `llmProxy.anthropicUrl` 非空时，在 Claude 段额外显示一行警示（原因见 6.1）。

### 5.5 可测试性

仓库的 web 测试是 `renderToStaticMarkup` SSR（不跑 effect、无 DOM，见 `SettingsPage.test.tsx:1`），所以把逻辑抽成纯函数模块 `web/src/components/settings/providerProfiles.ts`：

- `profileToFormValues(profile)` —— 档 → 表单字段
- `isProfileModified(providerValues, profile, fields)` —— 决定标不标「已修改」
- `buildConfigPutBody(draft, selections)` —— 含 `activeProviderProfiles`（自定义 → `''`）

用 `node:test` 直接测纯函数；再补一个 SSR 冒烟断言下拉渲染出来。

## 6. 生效语义与边界

### 6.1 生效链路（已在代码中核实）

- 保存 → `cfg.update()` 原子写盘（tmp + rename）→ `syncProviderEnv()` 写 `process.env`。子进程在 **spawn 时快照 env**，所以**新会话生效、运行中的会话不换**。
- llm-proxy 会跟着动：`index.js:421` 的 `onWrite` → `reconcile()`（`manager.ts:79`）用新的 `claude.baseUrl`（作 `anthropicUrl` 兜底）与新 `claude.apiKey` 重写 toml 并重启 Go 代理（`manager.ts:93`）。**开关代理时切档一样生效。**
- **坑**：若 `llmProxy.anthropicUrl` 被显式填了非空，`resolveLlmProxy` 就用它而不用 `claude.baseUrl`——切档只改了"直连"路径，代理仍打老上游。→ UI 显示警示（5.4），别让用户以为切了其实没切。
- 远程会话：`buildProviderConfigEnv` 在 `session/start` 时取值 → 影响**之后新起**的远程会话。
- dsh：`resolveDshProviderEnv`（`env-sync.ts:125`）里 dsh 档显式填了 `baseUrl`/`apiKey` 时优先，没填才跟随 claude/代理。

### 6.2 边界

- 允许存空 `apiKey` 的档；应用它 = 清空 key。
- **档 id 不存在 → 404，不静默忽略。**静默忽略会让用户以为切了其实没切，是最坏的一种失败模式。
- `name`：trim 后为空或长度 > 40 → 400。**同名允许**（id 才是主键）。
- 档数不设上限。
- 客户端若把打码串塞进 `values`：`stripMaskedPlaceholders` 会剥掉 → `deepMerge` 保留原真值。安全兜底。
- POST 快照必须 `structuredClone`，不能引用现有对象。

## 7. 错误处理

- 写盘/IO 失败 → `500 { error: 'config write failed' }`，不透出 fs 文本（沿用 `config.routes.ts:44` 的既有语义）。POST/DELETE 一致。
- 校验失败 / 未知档 → `400` / `404`，body 带 `error` 字段（前端既有 `err?.error?.message ?? err?.error` 读法直接兼容）。
- 并发写：复用 `cfg.update()` 的原子写，不新增锁。

## 8. 测试与验收

后端 `node:test`（`backend/server/modules/config/tests/`）：

1. POST 快照出的档里 `apiKey` 是**真值**；`GET` masked 只暴露打码串（验证递归打码覆盖到 `providerProfiles`）。
2. PUT 带档标记的四种情形（只选档 / 选档+覆写模型 / 选档+填新 key / 选档+清空 key）。
3. body 带打码 apiKey 时档里真 key 不被覆盖（`deepMerge` 路径，不能写成对象展开）。
4. `null` 不清标记、`''` 才清 —— 防止后人"顺手改成 null"。
5. 未知档 id → 404；`name` 空白/超长 → 400。
6. 删除当前档后 active 标记清空、`providers.claude.*` 不变。

路由测试走仓库既有的 ephemeral server 模式（参考 `modules/auth/tests/auth.routes.test.ts:12` 的 `startServer`），用 `npx tsx --test --tsconfig server/tsconfig.json` 跑。

前端：`providerProfiles.ts` 纯函数单测 + 一个 SSR 冒烟。

**验收标准**：`tsc --noEmit` 与 `eslint` **零新增**（后端 baseline 本来就有 pre-existing 报错）。不改 `env-sync.ts` / `providers/*` / `llm-proxy/*` / 远程链路任何文件，回归面为零。

## 9. 后续可选（不在本期）

- 把 `oneMillionModels`、`dshHome`、`patchPath` 加进白名单。
- 配置档导入/导出（导出必然要处理密钥，需另设计）。
- 全局快切入口（顶栏/侧栏）。
- 修 `codex.apiKey` 不写 env 的既有缺口。
