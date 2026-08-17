# 修改密码 + 登出整理 — 设计文档

> 状态：设计定稿 · 2026-08-13
> 定位：在已有登录门槛（邮箱 + 验证码）基础上，补上**修改密码**能力，并整理侧边栏底部（登出已存在，删除版本品牌行）。
> 范围：lovdex-backend（auth 模块写配置 + 新路由 + 测试）与 lovdex-cli（改密弹窗 + 侧边栏入口 + i18n）。

---

## 1. 背景与目标

登录门槛已于 2026-08-13 上线：固定邮箱 `zhiju.huang@sophgo.com` + 固定验证码（默认 `888888`），凭据存在 `lovdex-backend/server/modules/auth/auth.config.json`，后端强制拦截。当前**验证码是写死的**，用户无法在 UI 上修改。

**目标**：
1. **修改密码**：登录状态下可在 UI 修改验证码，改完**立即生效**（无需重启服务），下次登录用新验证码。
2. 修改密码需验证**当前验证码**（防误改）；当前会话不受影响（JWT 密钥不变，token 不失效）。
3. 新验证码写回 `auth.config.json`（只改 `code` 字段，保留 email/jwtSecret 与文件格式）。
4. **登出**已在侧边栏底部（`SidebarFooter.tsx`），保留不动。
5. 删除侧边栏底部 "Lovdex v… – Open Source" 版本品牌行（用户指定）。

**不做的**：
- 不做找回密码 / 重置密码（单用户门槛，改密需已登录 + 当前码）。
- 不做登录页上的改密入口（改密入口在应用内侧边栏）。
- 不改 `AUTH_ENABLED` 逃生阀与平台模式（`IS_PLATFORM`）行为。
- 不改数据库（登录与改密均零 DB 写入）。

---

## 2. 方案选型

**选：方案 A —— 后端写配置 + 热更新内存（立即生效）。**

| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 写回 config + 热更新（选）** | 新路由 `POST /api/auth/change-password`（需登录）校验当前码后，原子写回 `auth.config.json` 并同步更新内存 `authConfig.code` | ✅ 立即生效不用重启；只动一个字段；与「凭据放配置文件」的既有决策一致。❌ 后端进程需对配置文件有写权限（仓库目录世界可写，满足）。 |
| B 只写文件不更新内存 | 改完需重启才生效 | ❌ 体验差，用户得记住重启。 |
| C 存 DB | 验证码放数据库 | ❌ 与既有「登录零 DB 写入」决策冲突；单用户门槛杀鸡用牛刀。 |

---

## 3. 配置

新验证码校验规则（代码常量）：
- **入参先去空白**（`currentCode`、`newCode` 均 `.trim()`），与登录页前端 trim 行为一致；存储的是 trim 后的值。
- 长度 ≥ 4、≤ 64（`auth.config.ts` 中 `MIN_CODE_LENGTH = 4`、`MAX_CODE_LENGTH = 64`）。
- 不强制数字/字母；任意非空字符串。
- 新码与当前码相同：允许（等价于重写一次，不报错）。

写入 `auth.config.json` 保持原格式：2 空格缩进 + 末尾换行，字段顺序 email / code / jwtSecret 不变。

---

## 4. 后端设计

### 4.1 热更新（改 `server/modules/auth/auth.config.ts`）

新增 `updateAuthCode(newCode: string): boolean`：
- 重新读取当前文件（保留用户可能手动改过的 email/jwtSecret），只替换 `code`；文件读不到时用内存中的 email/jwtSecret 兜底。
- **原子写**：先写 `<path>.tmp`，再 `fs.renameSync` 覆盖，避免写一半损坏。
- 成功：`authConfig.code = newCode`，返回 `true`；失败（权限/磁盘等）：返回 `false`，**不改内存**。
- 打日志：成功/失败各一条。

### 4.2 路由（改 `server/modules/auth/auth.routes.ts`）

新增 `POST /api/auth/change-password`，**套 `authenticateToken`**（仅此路由，login/me 保持公开）：

| 场景 | 响应 |
|---|---|
| 未登录 / token 无效 | `401 { error: '未登录或登录已过期' }` |
| body 缺字段 / 当前码不对 | `401 { error: '当前验证码不正确' }` |
| 新码长度 < 4 或 > 64 | `400 { error: '新验证码长度需在 4-64 位之间' }` |
| 写文件失败 | `500 { error: '修改失败，请检查服务端配置文件权限' }` |
| 成功 | `200 { ok: true }` |

- 校验顺序：先鉴权 → 再当前码 → 再新码格式 → 最后写文件。
- `authenticateToken` 从 `server/middleware/auth.js` 引入；全局 `validateApiKey` 已在其前执行，API_KEY 生效时 `req.apiKeyValidated` 会放行（与既有行为一致）。

### 4.3 挂载

路由已挂在 `app.use('/api/auth', authRoutes)`，无需改 `server/index.js`；`authenticateToken` 只作为 change-password 的中间件。

---

## 5. 前端设计

### 5.1 API（改 `src/utils/api.js`）

`api.auth` 增加（**实现定为 raw fetch**，刻意不用 `authenticatedFetch`——改密接口的 401 是「当前验证码输错」，不应触发 `authenticatedFetch` 的全局 401 登出逻辑；与 `login` 的做法一致，手动带 Bearer 头）：

```js
// changePassword uses a raw fetch (not authenticatedFetch) so a wrong
// current password (401) doesn't trigger the global "token expired" logout.
changePassword: (currentCode, newCode) => {
  const token = localStorage.getItem('auth-token');
  return fetch(`${API_BASE_URL}/api/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(!IS_PLATFORM && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ currentCode, newCode }),
  });
},
```

### 5.2 ChangePasswordDialog（新增 `src/components/auth/ChangePasswordDialog.tsx`）

复用现有 `Dialog` / `DialogContent` / `DialogTitle`（`shared/view/ui`）：

- 受控组件：`{ open, onOpenChange }`。
- 三个 `type="password"` 输入框：当前验证码 / 新验证码 / 确认新验证码。
- 客户端校验：三项非空；新码两次一致；新码长度 ≥ 4（提示用 i18n）。
- 提交 → `api.auth.changePassword`：
  - `200` → 清空表单、显示成功提示（短暂后关闭）、`onOpenChange(false)`。
  - `401` → 提示「当前验证码不正确」。
  - `400` → 提示新码格式问题。
  - 网络错误（`TypeError`）→ 提示网络错误。
- 成功关闭后由 SidebarFooter 保持按钮 focus 管理（Dialog 已处理 focus 恢复）。

### 5.3 侧边栏入口（改 `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`）

- 在「退出登录」按钮上方加一个「修改密码」小按钮（`KeyRound` 图标，样式与登出按钮一致）。
- `useState` 管理弹窗开关，`!IS_PLATFORM` 时渲染 `<ChangePasswordDialog>`。

### 5.4 i18n（改 `src/i18n/locales/en/auth.json`）

新增 `changePassword` 命名空间：title / current / new / confirm / submit / success / errors（mismatch / tooShort / wrongCurrent / networkError）。

### 5.5 登出与品牌行清理（改 `SidebarFooter.tsx`）

- 登出按钮**保留**（不动）。
- **已删除** "Lovdex v… – Open Source" 版本品牌行；同步清理 `currentVersion` 在 `SidebarFooter` / `SidebarContent` / `Sidebar` 的传参链（该 prop 仅用于品牌行）。

---

## 6. 数据流

```
应用内点「修改密码」→ Dialog 弹窗 → 填当前/新/确认 → POST /api/auth/change-password
→ 后端 authenticateToken 校验登录 → 校验当前码 → 校验新码格式
→ 原子写回 auth.config.json + authConfig.code = 新码 → { ok: true }
→ 前端提示成功、关闭弹窗；当前会话继续有效；下次登录用新验证码
```

---

## 7. 错误处理与恢复

| 场景 | 行为 |
|---|---|
| 当前码不对 | `401`，前端提示，弹窗不关 |
| 新码太短/太长 | `400`，前端提示格式问题 |
| 写配置文件失败（权限等） | `500`，前端提示，内存未改（下次仍是旧码），可重试 |
| 前端改挂 | 验证码仍可手工编辑 `auth.config.json` 后重启；`AUTH_ENABLED=false` 逃生阀不变 |
| 改密后 token | JWT 密钥未变，现有 token 全部有效，无需重新登录 |

---

## 8. 测试

**后端**（`server/modules/auth/tests/auth.routes.test.ts` 追加，node:test + tsx）：
1. 登录后正确改密（当前码对 + 合法新码）→ `200`，且配置文件 `code` 已更新、内存 `authConfig.code` 已更新。
2. 当前码错误 → `401`。
3. 新码过短（<4）→ `400`。
4. 未登录调 change-password → `401`。
5. 写失败路径：`updateAuthCode` 失败时内存不变（用 mock/不可写路径验证）。
- **测试后恢复原码**（`after` 钩子里把配置文件写回 `888888` 并同步内存），避免影响其它测试/服务。

**前端**：无 DOM 测试框架，弹窗组件不做单测；`api.auth.changePassword` 为既有 `authenticatedFetch` 模式，无新增纯逻辑。

---

## 9. 涉及文件清单

**lovdex-backend**：
- 改 `server/modules/auth/auth.config.ts`（`updateAuthCode` + 长度常量）
- 改 `server/modules/auth/auth.routes.ts`（`POST /change-password`）
- 改 `server/modules/auth/tests/auth.routes.test.ts`（改密测试）

**lovdex-cli**：
- 新增 `src/components/auth/ChangePasswordDialog.tsx`
- 改 `src/utils/api.js`（`auth.changePassword`）
- 改 `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`（改密按钮 + 删除品牌行）
- 改 `src/components/sidebar/view/subcomponents/SidebarContent.tsx`、`src/components/sidebar/view/Sidebar.tsx`（清理 `currentVersion` 传参链）
- 改 `src/i18n/locales/en/auth.json`（`changePassword` 文案）
