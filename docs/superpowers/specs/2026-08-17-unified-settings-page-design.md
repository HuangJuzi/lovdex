# 统一设置页（Provider / Operator / 数据库 / 账号）

Date: 2026-08-17  Status: Approved

## 背景与目标

当前设置能力散落在四个入口、两种形态：

- **Provider 设置**：侧边栏底部齿轮 → 模态弹窗（`SettingsDialog`），另有独立路由 `/settings/providers`（`ProviderSettingsPage`）。
- **Operator Agent 设置**：独立路由 `/settings/operator`（`OperatorSettingsPage`），从助手面板齿轮进入。
- **修改密码**：侧边栏底部按钮 → 弹窗（`ChangePasswordDialog`）。
- **登出**：侧边栏底部按钮 → 直接 `logout()`。
- **数据库路径**：只存在于 `~/.lovdex/data/app.config.json` 的 `database.path`，Web 上无处可改，只能手改配置文件。

目标：把以上能力合并到**同一个设置页** `/settings`（左侧 Tab 导航），并把**数据库路径**加入设置页（走 `app.config.json` / `PUT /api/config`，不走环境变量）。

用户已确认的两个决策：

1. 页面形态 = **左侧 Tab 导航页**（非单页滚动、非模态）。
2. 「数据库」只暴露 **`database.path` 路径输入框**（不做连接状态/重置/迁移）。

## 设计

### 1. 新页面 `SettingsPage`

单一路由 `/settings`，`web/src/components/settings/SettingsPage.tsx`：

- 顶部 sticky header：`BackToTasksButton`（复用 `tasks/TaskBackNav.tsx`）+ 标题「设置」。
- 左侧竖排 Tab 导航：**Provider 设置 / Operator Agent 设置 / 数据库 / 账号**。
- 右侧面板渲染当前 Tab 的表单体（每个 Tab 一个可复用组件，见下）。
- 激活 Tab 由 URL 查询参数 `?tab=` 驱动（`useSearchParams`），默认 `providers`；支持从助手面板深链 `/settings?tab=operator`。非法值回退到默认 Tab。
- 移动端：Tab 栏在小屏折叠为顶部横排（沿用现有 `isMobile` / 响应式 Tailwind 惯例）。

四个 Tab 的内容：

| Tab | key | 内容 | 来源 |
|---|---|---|---|
| Provider 设置 | `providers` | provider 凭据/模型/运行参数 | 复用 `ProviderSettingsForm`（已从 `ProviderSettingsPage.tsx` 抽出） |
| Operator Agent 设置 | `operator` | operator 开关/模型/并发/prompt | 从 `OperatorSettingsPage.tsx` 抽出表单体为 `OperatorSettingsForm` |
| 数据库 | `database` | 数据库路径输入框 | 新建 `DatabaseSettingsForm` |
| 账号 | `account` | 修改密码内联表单 + 登出按钮 | 新建 `AccountSettingsSection` |

### 2. Operator 表单抽离（`OperatorSettingsPage.tsx`）

- 把现有 `OperatorSettingsPage` 的**表单体**（`loaded` 后的 sections + 保存栏 + 加载/错误态）抽成 `export function OperatorSettingsForm()`，页面外框（header + 返回按钮 + `max-w-2xl` 容器）保留给路由页。
- 改动最小化：`OperatorSettingsPage` 保留为「header + `<OperatorSettingsForm />`」，向后兼容现有 `/settings/operator` 深链（后续会重定向，见 §4）。

### 3. 账号 Tab（`AccountSettingsSection.tsx`）

- **修改密码**：把 `ChangePasswordDialog.tsx` 的表单体（current/new/confirm + 校验 + `POST /api/auth/change-password` + 成功/错误提示）抽成 `ChangePasswordForm` 内联渲染，去掉 `Dialog` 外框；沿用 `auth` 命名空间的 i18n key（`t('changePassword.*')`）。
- **登出**：一个按钮，点击调 `useAuth().logout()`（清除 token、切回登录页）。
- `IS_PLATFORM()` 为真时**隐藏整个「账号」Tab**（platform 模式无本地密码/登出，与现有 `SidebarFooter` 的 `!IS_PLATFORM()` 门一致）。

### 4. 数据库 Tab（`DatabaseSettingsForm.tsx`）

- `GET /api/config` 读 `database.path`（config 已含该字段，`GET /api/config` 明文返回），`PUT /api/config` 写（复用 `stripMaskedPlaceholders` 链路；`database.path` 非敏感，无掩码）。
- 单个文本输入框 `database.path` + 提示文案：「保存后需重启后端生效」（与 Provider 表单里端口/host 的提示一致，因为数据库连接在 boot 时建立）。
- 输入框采用与 `ProviderSettingsPage.tsx` 内部 `TextField` 相同的视觉样式（`h-9 rounded-md border border-border bg-muted px-2 py-1.5`）；实现时把该 `TextField` 提为共享导出（或在 `DatabaseSettingsForm` 内自建同款）——不依赖未导出的内部组件。draft 只 patch `database.path`，不触碰其它字段。

### 5. 路由与入口改造

- `App.tsx` 新增 `<Route path="/settings" element={<SettingsPage />} />`。
- 旧路由 `/settings/providers`、`/settings/operator` 改为 `<Navigate replace to="/settings?tab=providers|operator" />`。
- `SidebarFooter.tsx`：
  - 底部「Provider 设置」齿轮按钮：`onClick` 由 `openSettings`（开模态）改为 `navigate('/settings')`，文案改为「设置」。
  - **移除**底部「修改密码」「登出」两个按钮及 `ChangePasswordDialog`（已并入账号 Tab）。
- `SidebarAssistant.tsx`：两处 `navigate('/settings/operator')` 改为 `navigate('/settings?tab=operator')`。

### 6. 清理（模态方案废弃）

- 删除 `web/src/components/settings/SettingsDialog.tsx`。
- 删除 `web/src/hooks/useSettingsDialog.tsx`。
- `App.tsx` 移除 `SettingsDialogProvider` / `SettingsDialog` 挂载与 import。
- 删除 `web/src/components/auth/ChangePasswordDialog.tsx`（逻辑迁入 `ChangePasswordForm`）。

### 7. 数据流 / 错误处理

- Provider 与数据库两 Tab 均走 `GET /api/config`（匿名、掩码）读 / `PUT /api/config`（需登录）写；前端把整份 draft 原样回传，后端 `stripMaskedPlaceholders` 丢弃 `••••`/`****` 打码占位，真实密钥保持不变。`database.path` 无掩码，明文往返。
- Operator Tab 走 `GET/PUT /api/operator/settings`（现状不变）。
- 密码 Tab 走 `POST /api/auth/change-password`（raw fetch，避免 401 触发全局登出），保留原错误映射：401 当前密码错 / 400 新密码无效 / 网络错误。
- 保存失败统一 `setSaveError` 展示红字，不抛未捕获异常。

## 行为语义

- **设置页是唯一入口**：Provider / Operator / 数据库 / 账号 全部从 `/settings` 进入；侧边栏齿轮、助手面板齿轮都指向它。
- **实时性**：Provider 与 Operator 保存后对新会话即时生效（现状不变）；数据库路径保存仅写 `app.config.json`，**需重启后端**才生效（数据库连接在 boot 建立，不做运行时重连）。
- **platform 模式**：不显示「账号」Tab（无本地密码/登出）；其余三 Tab 正常。
- **不涉及**：`useProjectsState` 中已废弃的 `onShowSettings` 链（`showSettings` / `settingsInitialTab` 目前被 `SidebarModals` 忽略，无渲染效果）本次**不动**，避免范围蔓延。

## 测试

- `SettingsPage`：`?tab=` 默认/非法值回退、Tab 切换渲染对应表单、`IS_PLATFORM` 隐藏账号 Tab。
- `DatabaseSettingsForm`：加载展示 `database.path`、编辑保存后 `PUT /api/config` 载荷只含 `database.path`、空值/错误态。
- `ChangePasswordForm`：校验（必填/两次一致/长度）、成功/失败提示（复用/迁移自 `ChangePasswordDialog` 的行为）。
- 路由：`/settings/providers`、`/settings/operator` 重定向到 `/settings?tab=…`。
- 现有 `ProviderSettingsForm` / `OperatorSettingsForm` 逻辑不回归（抽取不改行为）。

## 涉及文件

- `web/src/components/settings/SettingsPage.tsx`（新增）
- `web/src/components/settings/DatabaseSettingsForm.tsx`（新增）
- `web/src/components/settings/AccountSettingsSection.tsx`（新增，含 `ChangePasswordForm`）
- `web/src/components/settings/ProviderSettingsPage.tsx`（`ProviderSettingsForm` 保持不变，供复用）
- `web/src/components/operators/OperatorSettingsPage.tsx`（抽出 `OperatorSettingsForm`）
- `web/src/App.tsx`（路由 + 移除 `SettingsDialog` 相关）
- `web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`（齿轮改导航 + 移除密码/登出）
- `web/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx`（深链改 `?tab=operator`）
- 删除：`web/src/components/settings/SettingsDialog.tsx`、`web/src/hooks/useSettingsDialog.tsx`、`web/src/components/auth/ChangePasswordDialog.tsx`
- 对应 tests

后端**无改动**（`database.path` 已在 `DEFAULT_APP_CONFIG`、`GET/PUT /api/config` 已支持）。
