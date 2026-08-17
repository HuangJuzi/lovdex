# 邮箱 + 验证码登录 — 设计文档

> 状态：设计定稿 · 2026-08-12
> 定位：为 Lovdex 加一个**后端强制拦截**的登录门槛——固定邮箱 + 固定验证码登录，登录一次后在浏览器免登录；未登录的 API/WebSocket 请求一律 401/拒绝。
> 范围：lovdex-backend（auth 模块 + 中间件 + 路由）与 lovdex-cli（登录页 + AuthGate + WS token）。

---

## 1. 背景与目标

当前 Lovdex **没有任何登录验证**：连上地址就能直接使用全部功能。后端 `middleware/auth.js` 对所有请求挂一个合成 `local` 用户（`id:1`），WebSocket 全放行；前端也无登录页，`auth.json` 的登录文案是历史遗留空壳。

**目标**：
1. 固定邮箱 `zhiju.huang@sophgo.com` + 固定验证码 `888888` 登录。
2. 登录成功后签发 token，前端存 `localStorage['auth-token']`，**登录一次后再次访问免登录**。
3. **后端强制拦截**：无有效 token 的 HTTP 请求 401、WebSocket 拒绝连接——绕开前端直接调 API 也进不来。
4. token 有效期 **7 天**，带**滑动续期**（活跃使用不打断，闲置超 7 天才需重登）。

**不做的**（刻意排除）：
- 不做真正的注册/多用户/角色权限：固定单用户门槛。
- 不做邮箱发码（验证码是写死的，不发真实邮件）。
- 不做验证码次数限制/锁定/审计（内网门槛场景，非安全防线）。
- 不改 `IS_PLATFORM` 平台模式的行为（平台模式保持现状）。

**定位说明**：验证码固定为 `888888` 可被猜测，这本质是一个「访问门槛」而非安全防护，但足以挡住「连地址就能用」的随手访问。

---

## 2. 方案选型

**选：方案 A —— JWT(HS256) 无状态 + 后端强制校验。**

| 方案 | 做法 | 优劣 |
|---|---|---|
| **A JWT + 后端校验（选）** | `POST /api/auth/login` 校验固定邮箱/码后签发 HS256 JWT；`authenticateToken` / `authenticateWebSocket` 校验 token，无效 401/拒连。token 存前端 localStorage | ✅ 无状态、不用建表；贴合现有脚手架（前端已读 `auth-token`、发 `Authorization: Bearer`、处理 `X-Refreshed-Token`、WS 已支持 `?token=`）；登录路径零 DB 写入。❌ 手写 HS256 需单测兜底（约 20 行，`node:crypto`）。 |
| B 数据库不透明 token | 登录后随机 token 存 DB，每请求查库 | ❌ 每请求查库、要建表；对本需求偏重，且引入 DB 依赖。 |
| C HttpOnly cookie 会话 | 抗 XSS 读 token | ❌ 前后端跨域（前端 5187 → 后端 3001）下 cookie 要处理 CORS credentials + CSRF，与现有 `auth-token` 模式冲突。 |

---

## 3. 配置（`server/modules/auth/auth.config.ts` 新增）

所有可调项集中在**代码常量 + 环境变量覆盖**，**不落 DB**：

| 配置项 | 默认值 | 位置 | 说明 |
|---|---|---|---|
| `AUTH_ENABLED` | `true` | env `AUTH_ENABLED` | `false` 时回退到现在的开放模式（合成 local 用户），作为**安全阀** |
| `email` | `zhiju.huang@sophgo.com` | `server/modules/auth/auth.config.json` | 允许登录的邮箱（**配置文件，非环境变量**） |
| `code` | `888888` | `server/modules/auth/auth.config.json` | 固定验证码（**配置文件**） |
| `jwtSecret` | `lovdex@2026` | `server/modules/auth/auth.config.json` | HS256 签名密钥（**配置文件**，不再读 `app_config` 里的 DB 密钥） |
| `JWT_EXPIRES_IN` | `7d` | 代码常量 | token 有效期 |
| `JWT_REFRESH_WINDOW` | `24h` | 代码常量 | 剩余有效期进入该窗口时，响应头返回新 token 续期 |

> 凭据(邮箱/验证码/密钥)存 `auth.config.json`,`auth.config.ts` 启动时读取;文件缺失/损坏时回退默认值并打告警。`AUTH_ENABLED` 仍是环境变量开关。

---

## 4. 后端设计

### 4.1 JWT 工具（`server/modules/auth/jwt.ts` 新增）

手写 HS256 签发/校验（`node:crypto`），**不加 jsonwebtoken 依赖**：

- `signToken(payload)` → `base64url(header).base64url(payload).hmac`
- `verifyToken(token)` → 解析校验签名与 `exp`；失败返回 `null`，不抛异常
- 载荷 `{ sub, username, iat, exp }`；`sub` 固定为 `1`、`username` 固定为 `email`（单用户）
- 前端 `isValidRefreshedToken` 已要求 token 是三段 JWT 形状，天然兼容

### 4.2 路由（`server/modules/auth/auth.routes.ts` 新增）

- `POST /api/auth/login`（公开，不套 `authenticateToken`）
  - body `{ email, code }`；与 `AUTH_EMAIL`/`AUTH_CODE` 比对
  - 成功 → `{ token, user: { id, username: email } }`
  - 失败 → `401 { error: '邮箱或验证码不正确' }`
  - **登录路径零 DB 写入**（不建 users 行、不更新 last_login）
- `GET /api/auth/me`（公开，只解析 token）
  - token 有效 → `{ user }`；无效/缺失 → `401`
  - 前端启动时用它验证本地 token

### 4.3 中间件（改 `server/middleware/auth.js`）

- 新增统一的 token 提取：`Authorization: Bearer <token>` **或** `?token=<token>`（SSE/EventSource 带不了 header，前端 `search/sessions`、`clone-progress` 已走 query）
- `authenticateToken`：
  - `IS_PLATFORM` 或 `AUTH_ENABLED=false` → 维持现状（合成 local 用户），平台模式行为完全不变
  - 否则校验 token；缺失/无效 → `401 { error: '未登录或登录已过期' }`；有效 → 挂 `req.user = { id, username }`
  - 校验通过且剩余有效期 ≤ `JWT_REFRESH_WINDOW` → 签发新 token 放 `X-Refreshed-Token` 响应头（前端 `authenticatedFetch` 已自动存回）
  - `validateApiKey` 保留：业务服务设了 `API_KEY` 可继续绕过
- `authenticateWebSocket`：校验 `?token=` 或 Authorization header；无效返回 `null`（`verifyWebSocketClient` 收到 `null` 即拒绝连接）

### 4.4 挂载（改 `server/index.js`）

- `app.use('/api/auth', authRoutes)` 放在 `validateApiKey` 之后、其它受保护路由之前；login/me 自身不套 `authenticateToken`
- 其余受保护路由（`/api/projects`、`/api/tasks`、`/api/providers`、`/api/operator/*`、文件操作等）不动，统一经 `authenticateToken` 拦截

---

## 5. 前端设计

### 5.1 AuthGate（`src/components/auth/AuthGate.tsx` 新增）

包在 `App.tsx` 的 `<Routes>` 外层：

- `IS_PLATFORM` → 直接放行（平台逻辑不变）
- 无 token → 渲染 `<LoginPage/>`
- 有 token → 调 `/api/auth/me` 校验：
  - 200 → 渲染应用
  - 401 → 清 `auth-token`，渲染 `<LoginPage/>`
  - 网络错误 → 短暂 loading 后重试（不误判为未登录）
- 校验期间显示全屏 loading（简单 spinner），应用主体与 WebSocket 不挂载——**未登录时不会触发 WS 无限重连**

### 5.2 LoginPage（`src/components/auth/LoginPage.tsx` 新增）

- 邮箱输入框（**预填固定邮箱**）+ 验证码输入框 + 提交按钮
- 提交 → `POST /api/auth/login`：
  - 成功 → 存 `localStorage['auth-token']`，`setAuth` 进入应用
  - 失败 → 提示「邮箱或验证码不正确」
- 样式沿用现有 `shared/view/ui` 组件（Button / Input / Card）与 Tailwind 主题

### 5.3 WebSocket token（改 `src/contexts/WebSocketContext.tsx`）

- `buildWebSocketUrl` 在 URL 末尾追加 `?token=<localStorage['auth-token']>`（WS 带不了 header，query 是后端已支持的方式）

### 5.4 i18n（改 `src/i18n/locales/en/auth.json`）

- 复用现有 `login` 命名空间，替换为邮箱/验证码文案：title/description/email/code/submit/errors

### 5.5 退出登录（侧边栏底部）

- 在 `src/components/sidebar/view/Sidebar.tsx` 底部设置按钮旁加一个小的「退出登录」图标按钮（`lucide-react` 的 `LogOut`）
- 点击 → 清除 `localStorage['auth-token']` → 回到登录页
- 不引入设置面板的改动，入口始终可见、改动面最小

---

## 6. 数据流

```
首次访问 → AuthGate 无 token → LoginPage
输入邮箱(预填)+ 888888 → POST /api/auth/login → { token } → localStorage['auth-token']
之后:HTTP 带 Authorization: Bearer;WS 带 ?token=;SSE 带 ?token=
HTTP 校验通过且临近过期 → 响应头 X-Refreshed-Token 新 token → 前端自动存回(滑动续期)
token 过期/失效 → /api/auth/me 401 → 清 token → 回到 LoginPage
```

---

## 7. 错误处理与恢复

| 场景 | 行为 |
|---|---|
| 登录失败（邮箱/码不对） | `401 { error }`，前端提示 |
| 未登录/过期请求受保护 API | `401`，前端 AuthGate 捕获后回登录页 |
| 未登录连 WS | `verifyWebSocketClient` 拒绝，前端 3s 重连；但 AuthGate 拦在前面，应用主体不挂载，不会进入该循环 |
| **前端改挂了 / 登录页进不去** | 后端 `.env` 设 `AUTH_ENABLED=false` → 重启后端 → 立即回到开放模式；或 `curl -X POST /api/auth/login` 直接拿 token 调 API。**后端 auth 与前端是否正常完全解耦** |
| DB 被重置 | JWT 密钥在代码常量（`lovdex@2026`），不依赖 DB；旧 token 仍可校验。登录本身也不写 DB |

---

## 8. 测试

**后端**（`server/modules/auth/tests/auth.test.ts`，node:test + tsx，与现有测试同构）：

1. 正确邮箱+验证码 → 返回三段的 token，`/api/auth/me` 校验通过
2. 错误邮箱 / 错误验证码 → 401
3. 伪造 token / 过期 token → `/api/auth/me` 401、`authenticateToken` 拦截
4. 临近过期 token → 响应含 `X-Refreshed-Token` 新 token
5. `AUTH_ENABLED=false` → `authenticateToken` 挂合成 local 用户（保持开放）
6. `?token=` query 通道可校验（SSE 场景）

**前端**：无 DOM 测试框架，登录页组件不做单测；token 存取为既有 `localStorage` 模式，无新增纯逻辑。若抽了纯函数（如 token 提取），按现有 `node:test` 纯逻辑测试风格补测。

---

## 9. 涉及文件清单

**lovdex-backend**：
- 新增 `server/modules/auth/auth.config.ts`、`server/modules/auth/jwt.ts`、`server/modules/auth/auth.routes.ts`、`server/modules/auth/tests/auth.test.ts`
- 改 `server/middleware/auth.js`、`server/index.js`
- `.env.example` 追加 `AUTH_ENABLED` / `AUTH_EMAIL` / `AUTH_CODE` / `JWT_SECRET` 注释（默认值即常量，可不设）

**lovdex-cli**：
- 新增 `src/components/auth/AuthGate.tsx`、`src/components/auth/LoginPage.tsx`
- 改 `src/App.tsx`（包 AuthGate）、`src/contexts/WebSocketContext.tsx`（WS URL 带 token）、`src/i18n/locales/en/auth.json`、退出登录入口
