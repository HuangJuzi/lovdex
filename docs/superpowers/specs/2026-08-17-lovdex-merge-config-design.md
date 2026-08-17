# Lovdex 单仓整合 + 全配置化 + Provider 配置页 设计

日期：2026-08-17
状态：已获用户口头认可 → 待审阅

## 背景 / 目标

原 Lovdex 由两个独立 git 仓库组成、两套 node_modules、互不通气：

- `lovdex-cli`（React 前端，vite :5187，代理 /api /ws → 后端）
- `lovdex-backend`（Express API + WebSocket :3001，读 `.env`）

目标：

1. **合并到一个根目录**：`/mnt/b/workdir/github/lovdex/lovdex`（当前会话目录下新建），前端改叫 `web/`、后端 `backend/`，并打包 `supervisor/`、`docs/`、`systemd/`，做成自洽可跑的整体。
2. **全新单 git 仓库**：不保留两个原仓库历史（**不拷贝 `.git`**），合并根 `git init` 建一个统一仓库。
3. **README 全新**：不说明与旧项目的迁移/继承关系，只介绍 Lovdex 自己——是什么、怎么跑、怎么配。
4. **彻底去环境变量**：后端所有业务 `process.env.X` 迁入配置文件 `~/.lovdex/data/app.config.json`；仅保留系统级 `HOME/PATH/SHELL` 与逃生阀 `AUTH_ENABLED=false`。前端 Vite 构建期变量也取消，运行期从 `/api/config` 拉取。
5. **Web 配置页**：新增 `/settings/providers` 页面，集中配置四个 provider（claude / codex / opencode / qoder）的凭据、CLI 路径、provider 各自开关，以及一批运行参数（端口、DB 路径、workspace、operator 等）。

## 现状盘点（信息来源：梳理两仓库代码 + .env）

### 后端 `process.env` 读取点（业务键）

| 键 | 用途 | 读取位置 |
|---|---|---|
| `SERVER_PORT` / `PORT` | 后端端口（默认 3001） | `server/index.js` |
| `HOST` | 监听 host | `server/index.js` |
| `CORS_ORIGIN` | CORS 白名单 | `server/index.js` |
| `CONTEXT_WINDOW` | 上下文窗口 | server（supplier 侧） |
| `VITE_IS_PLATFORM` | 平台/OSS 模式 | `server/constants/config.js` |
| `WORKFLOWS_ENABLED` | 工作流开关 | 任务执行侧 |
| `ULTRACODE_KEYWORD_TRIGGER` | ultracode 触发词 | 任务执行侧 |
| `DATABASE_PATH` | sqlite 路径（默认 `~/.cloudcli/auth.db`，真值 `~/.sophcode/auth.db` 已写入 `.env`） | `server/modules/database/connection.ts` + `server/load-env.js` |
| `WORKSPACES_ROOT` | 工作区根（默认 `~`） | `server/shared/utils.ts` |
| `LOVDEX_MAIN_WORKSPACE` | 主工作区（默认空） | `server/utils/runtime-paths.js` |
| `ANTHROPIC_API_KEY` | claude 凭据（API key） | `providers/list/claude/claude-auth.provider.ts`、`opencode-auth` |
| `ANTHROPIC_AUTH_TOKEN` | claude 凭据（auth token） | 同上 |
| `CLAUDE_CLI_PATH` | claude CLI 路径 | probe |
| `LOVDEX_CLAUDE_1M_MODELS` | claude 1M 模型名单 | `claude-models.provider.ts` |
| `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` / `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` | claude 超时 | claude-sdk 侧 |
| `CODEX_PATH_OVERRIDE` | codex bin 路径 | codex 侧 |
| `OPENCODE_BIN` | opencode bin 路径 | opencode 侧 |
| `OPENAI_API_KEY` 等 `OPENCODE_ENV_CREDENTIAL_KEYS` | opencode 凭据（多键） | `opencode-auth.provider.ts` |
| `QODER_PERSONAL_ACCESS_TOKEN` | qoder 凭据 | `qoder-auth.provider.ts` |
| `QODER_TOOL_APPROVAL_TIMEOUT_MS` | qoder 超时 | qoder-runner 侧 |
| `FS_CONCURRENCY` | 文件并发 | server 侧 |
| `LOVDEX_OPERATOR_MODEL` / `MAX_CONCURRENT` / `WORKSPACE` | operator 默认配置 | `operator.config.ts` |
| `AUTH_ENABLED` | 认证开关（逃生阀，保留 env） | `auth.config.ts` |

系统级保留：`HOME`、`PATH`、`SHELL`。`CLAUDE_CLI_PATH` 等业务键一律迁入配置，但**读取处保留"配置为空时回退原 env"**，已有 environment 注入（如 systemd 里的 ANTHROPIC_MODEL 覆盖）在未配 config 时继续生效，保证既有部署平滑。

### 前端 env 读取点

| 键 | 用途 | 读取位置 |
|---|---|---|
| `VITE_API_BASE_URL` | API 基地址（空则同源代理 /api，dev 由 vite proxy 处理） | `src/constants/config.ts` → `utils/api.js` |
| `VITE_IS_PLATFORM` | 平台模式 | `src/constants/config.ts` |
| `VITE_URL` / `VITE_PORT` 等 | 遗留/未用 | 忽略 |

### 已有可复用先例

- `auth.config.json`：登录凭据已迁出 env，JSON 文件 + 原子写 `updateAuthCode`（tmp + rename）。**配置化可完全复刻此模式**。
- `app_config` 表（SQLite KV）：已用于 `jwt_secret`、`operator_config`。**但目标明确选文件配置（`~/.lovdex/data/app.config.json`），不用它承载新配置** —— 它仍可作为次级/追加存储保留给既有功能。
- `GET/PUT /api/operator/settings` + `OperatorSettingsPage`：配置页 UI/API 的现成样板。

## 目标目录结构

```
/mnt/b/workdir/github/lovdex/lovdex/        ← 合并根 = 新 git 仓库
├── README.md                                ← 全新，介绍 Lovdex（不涉迁移历史）
├── .gitignore                               ← 根级合并：node_modules/ dist/ *.log data/ .env …
├── .env.example                             ← 仅记录 AUTH_ENABLED 逃生阀用法
├── web/                                     ← 原 lovdex-cli 内容（不含 .git/node_modules/dist/.env）
│   ├── package.json（name: lovdex-web）
│   ├── src/  public/  shared/  index.html  vite.config.js  tsconfig.json …
├── backend/                                 ← 原 lovdex-backend 内容（不含 .git/node_modules/dist-server/.env）
│   ├── package.json（name: lovdex-backend）
│   ├── server/  shared/ …
├── supervisor/                              ← 拷贝改造：services.mjs 的 cwd 指到 web/backend
├── docs/                                    ← 拷贝 ~/.lovdex/docs（superpowers/plans、specs、mockup）
└── systemd/                                 ← 拷贝 lovdex.service，路径指向新目录（存档，不启用）
```

拷贝源以 `~/.lovdex` 为准（另一份 `/mnt/b/workdir/github/lovdex` 落后一个 commit）。

### 不拷贝 / 不保留

- 两个原 `.git`、`node_modules`、`dist`、`dist-server`、`.env`（gitignored，凭据进新配置）
- `supervisor/run.pid`、`run.state.json`、`logs/`（运行时产物）
- `operator-workspace/`（空）、`.claude/`（本地配置）、两个 orca 研究 html

## 配置系统设计

### 文件位置

`~/.lovdex/data/app.config.json`（`DATA_DIR` 默认 `~/.lovdex/data`，可被 `LOVDEX_DATA_DIR` env 覆盖）。**首次启动若缺文件 → 自动生成默认配置**（含 auth.jwtSecret 随机值）。

### Schema（app.config.json）

```jsonc
{
  "server": {
    "host": "0.0.0.0",
    "port": 3188,
    "corsOrigin": "*",
    "contextWindow": null,
    "isPlatform": false,
    "workflowsEnabled": true,
    "ultracodeKeywordTrigger": ""
  },
  "database": { "path": "/home/zhijuhuang/.sophcode/auth.db" },
  "workspaces": { "root": "~", "mainWorkspace": "" },
  "auth": { "enabled": true, "email": null, "code": null, "jwtSecret": "<auto-generated>" },
  "providers": {
    "claude": {
      "cliPath": "claude",
      "apiKey": "",
      "authToken": "",
      "oneMillionModels": "",
      "streamCloseTimeoutMs": 10000,
      "toolApprovalTimeoutMs": 60000
    },
    "codex": { "binPath": "codex" },
    "opencode": { "binPath": "opencode", "apiKeys": {} },
    "qoder": { "personalAccessToken": "", "toolApprovalTimeoutMs": 60000 }
  },
  "operator": {
    "enabled": true,
    "autoVerdictEnabled": true,
    "model": "",
    "workspace": "~/.lovdex/operator-workspace",
    "maxConcurrent": 2
  },
  "runtime": { "fsConcurrency": 50 }
}
```

### 后端组件

- `server/modules/config/config.ts`：模块单例，`load()` 读文件 + 深度合并默认值 → 内存对象；`get(keys...)` / `set(appConfig)` 原子写（tmp+rename）；启动即加载；文件缺失自动生成默认并落盘。
- `server/modules/config/config.routes.ts`：
  - `GET /api/config` — 返回当前配置，**凭据字段脱敏**（如 `"••••4j2d"` 掩码 + `hasValue: boolean`）。**匿名可读**：登录页/启动引导需要拿到 `server.isPlatform` 等公开参数渲染品牌，不能 401；脱敏的非敏感字段无泄密风险。
  - `PUT /api/config` — **需登录**（JWT 保护）部分更新（传的对象深度合并），校验 schema 后落盘；返回脱敏结果
- **provider-auth 改造**：各 provider 的 `checkCredentials()` 优先读 `appConfig`（次选 orig env，确保既有部署平滑），返回 `method: 'config'`。

### env 迁移映射（一次性）

每个读取点替换为 `appConfig.get(...)`；`load-env.js` 保留仅做逃生阀处理；`process.env.AUTH_ENABLED` 保持特殊（唯一留存的环境开关）。

### 前端改造

- `src/constants/config.ts` 删除 `VITE_*` 引用，新增 `fetchRuntimeConfig()`：启动时 `GET /api/config`，把 `server.isPlatform`、`server.corsOrigin` 等灌入内存 store（platform 模式判断）。
- `vite.config.js` 保留 dev proxy（不需要 `API_BASE_URL`，同源相对路径，与现状一致）。
- 新增 `src/components/settings/ProviderSettingsPage.tsx` + 路由 `/settings/providers` + 侧边栏">设置"入口。
- 页面结构（复用 OperatorSettingsPage 的 Toggle/Input/Button UI 模式）：
  - **✓ 认证状态卡片** ×4（claude/codex/opencode/qoder）：读 `GET /api/providers/auth-status`（若已有）或 `GET /api/config` 脱敏值；显示安装/登录/方法/错误
  - **每个 provider 配置折叠面板**：API key/token（password 型可显隐）、CLI 路径、专属开关（1M models、超时、调用 qoder PAT）
  - **运行参数区**：端口、host、DB 路径、workspace root、context window、operator 开关/并发/模型、workflows、ultracode 触发词
  - **保存**：`PUT /api/config`，提示"部分参数需重启后端生效（端口/DB/host）"

## 上线衔接

- 拷贝的 `supervisor/services.mjs` 把 `lovdex-cli`→`web`、`lovdex-backend`→`backend`；`systemd/lovdex.service` 指向新目录路径（文件更新到位，**但不 daemon-reload、不 enable/start**——用户已确认此阶段"不切换运行，线上仍跑 ~/.lovdex"）。
- 运行切换由用户后续单独发起，不在本计划默认动作内。

## 验证

- 新仓库 `git init` + 首次 commit（README/.gitignore/两源码树）。
- 后端：`npm run typecheck`（现存量 4 错误基线不致新增）、`npm run lint`（存量 44 条不致新增）、测试集 `npx tsx --test`（在合并目录解压后可能需先 `npm install`——按"不迁 node_modules"，验证阶段临时 install 或复用 ~/.lovdex 的 node_modules via symlink）。
- 前端：`npm run typecheck`、`npm run build`。
- 手工验证：无 `.env`、无配置 → 首启自动生成 `app.config.json`；`GET /api/config` 脱敏正常；`PUT` 保存 provider key → `qoder-auth` 读到 → 状态变 authenticated。
- 验证要用临时 git + 真实 git 环境（backend 测试的既有 recipe）。

## 明确不做（YAGNI）

- 不实现配置导入导出、多环境分档、加密存储（密钥明文 JSON，权限 0600）。
- 不做迁移向导、不做旧目录清理（旧位置保留不动）。
- 单仓库不引入 workspace/hoisting 重构构建链（两子项目各自独立 build/dev 保持现状）。

## 决策记录

| 决策 | 结论 |
|---|---|
| 合并根位置 | `/mnt/b/workdir/github/lovdex/lovdex`（会话当前目录下新建） |
| Git | 新建单仓库，丢弃两原仓库历史 |
| 子目录命名 | `web/`（原 cli）+ `backend/`（原 backend） |
| 附随内容 | 全量：supervisor / docs / systemd 一并拷入 |
| node_modules | 不拷贝 |
| 配置化范围 | 全部运行参数 + provider 凭据；唯一留存 env `AUTH_ENABLED`（逃生阀） |
| 配置文件位置 | `~/.lovdex/data/app.config.json`，**首次启动自动生成** |
| README | 全新，仅介绍 Lovdex 自身 |
| 前端配置页 | `/settings/providers`，覆盖四 provider + 运行参数 |
| 默认端口 | 前端 dev **5188**、后端 **3188**（supervisor、vite、config schema、README 同步） |