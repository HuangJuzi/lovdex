# DeepSeek 设置区块 + 跳转 session 时侧栏选中展开 — 设计

日期：2026-10-12
状态：已与用户逐节确认（两节均 OK）

## 背景与目标

两个独立的小需求：

1. **Provider 设置页添加 DeepSeek（dsh）区块**：dsh 已是后端一等 provider（注册表/配置/凭据/auth status 全齐），后端 `PROFILE_FIELDS` 也预留了 `dsh: ['baseUrl', 'apiKey']`，唯独设置页前端刻意没做区块（`web/src/components/settings/providerProfiles.ts:18` 的 `ProviderKey` 联合类型只有 claude/codex/opencode/qoder 四个）。本次补上 UI，配置 baseUrl + apiKey，并纳入配置档管理。
2. **跳转到 session 时左侧栏选中对应项目并展开高亮**：从任务页/通知/收件箱等入口 `navigate('/session/:id')` 后，项目行会高亮、session 行会高亮（URL→选中态同步已存在于 `web/src/hooks/useProjectsState.ts:831-879`），但 owning 项目的会话列表常是收起的（`useSidebarController` 的 `initialSelectionSettled` 守卫），看不到 session 名。本次让这种跳转强制展开 owning 项目。

## 第 1 部分：Provider 设置添加 DeepSeek

### 现状要点

- 后端零改动即可支撑：`GET /api/config` 的 `maskConfig` 按 key 名递归打码（`apiKey` 命中 `first6****last6` 规则，`dsh.apiKey` 自动覆盖）；`GET /api/providers/dsh/auth/status` 已存在（`dsh-auth.provider.ts` 读 `providers.dsh.apiKey`，返回 installed/authenticated）；env 下发 `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` 已实现（`env-sync.ts:125-138`）；`PROFILE_FIELDS.dsh = ['baseUrl', 'apiKey']` 已在白名单。
- 前端缺口：`ProviderKey` 联合类型、`FORM_FIELDS`、`readSelections` 都只有 4 个 provider；`ProviderSettingsPage.tsx` 无 dsh Section。前后端注释均警告：**给 PROFILE_FIELDS 加 provider 且要 UI 时，必须一并加宽前端联合类型，否则静默失能**（API 建的 dsh 档前端看不见、`activeProviderProfiles.dsh` 标记清不掉）。

### 改动清单（全部前端）

1. `web/src/components/settings/providerProfiles.ts`
   - `ProviderKey` 加 `'dsh'`；
   - `FORM_FIELDS` 加 `dsh: ['baseUrl', 'apiKey']`（必须 ⊆ 后端 PROFILE_FIELDS.dsh）；
   - `readSelections` 返回值补 `dsh` 键；
   - 更新文件头注释（「后端还带 dsh（刻意不做）」的说法已过时）。
2. `web/src/components/settings/ProviderSettingsPage.tsx`
   - `ProvidersConfig` 类型加 `dsh?: { baseUrl?: string; apiKey?: string }`；
   - `selections` 初始 state 补 `dsh: ''`；
   - 在 Qoder Section 与 LLM Proxy Section 之间新增：
     - `Section title="DeepSeek" provider="dsh"`（`provider` prop 让右上角 AuthStatus 自动拉 `/providers/dsh/auth/status`）；
     - `SecretField label="API Key (apiKey)"`（`revealable={false}`，与 claude/codex 一致）；
     - `TextField label="Base URL (baseUrl)"`，placeholder 说明「留空跟随 llm-proxy」的既有语义；
     - `headerExtra={selectorFor('dsh')}` 配置档选择器；
     - 底部说明文案与其他 Section 一致（配置档由服务端保管密钥；切换后点保存生效，只影响新会话）。

### 语义说明（写进 UI 的既有契约）

- `dsh.apiKey`/`dsh.baseUrl` 留空 = 继承 llm-proxy 凭据 / 跟随 claude provider 规则（`config.ts:66-99` 注释）。placeholder 提示这一点，不额外做逻辑。
- 打码占位串回传时后端 `stripMaskedPlaceholders` 丢弃，真值保留——无需前端处理。

### 测试

- `providerProfiles.test.ts`：`readSelections` 含 `dsh` 键（从 `activeProviderProfiles.dsh` 读档 id）；`FORM_FIELDS.dsh` 存在且 ⊆ 后端白名单（值断言 `['baseUrl','apiKey']`）。
- `ProviderSettingsPage` 无既有组件测试（SSR-only 测试环境跑不了 effect），不新增；依赖 `Section provider="dsh"` 的类型检查 + AuthStatus 既有行为。

## 第 2 部分：跳转 session 时侧栏选中项目 + 展开高亮

### 现状要点

- 入口都走 `navigate('/session/:id')`：任务页（TaskBoard/TaskDetail）、通知 toast/汇总弹窗（AppContent）、Service Worker 通知、搜索结果/最近会话（Sidebar 内 handleSessionClick，本就展开）、助手会话（SidebarAssistant）。
- URL→选中态同步：`useProjectsState.ts:831-879` 遍历 projects 匹配 sessionId，setSelectedProject + setSelectedSession —— 项目行高亮（`SidebarProjectItem.tsx:102` isSelected）与 session 行高亮（`SidebarSessionItem.tsx:55`）已自动跟上。
- 唯一缺口：展开。`useSidebarController.ts:159-190` 自动展开副作用受 `shouldAutoExpandSelectedProject` 的 `initialSelectionSettled` 守卫——挂载后**首次**解析到选中项目时严格遵守持久化展开状态，不强制展开（为了「从 /tasks 切回主页面当前项目不被强制打开」）。于是外部跳转进来时列表是收起的。

### 方案（已选 A；备选 B「每入口传 navigate state」因入口多、易漏、刷新丢 state 被否）

`useSidebarController` 的自动展开副作用扩展为同时观察 `selectedSession?.id`：

- **触发条件**：选中会话 id 发生变化，且新选中会话的归属项目（`selectedSession.__projectId`）≠ 上一个选中会话的归属项目。
- **动作**：无条件把该 projectId 加入 `expandedProjects`（不受 `initialSelectionSettled` 限制）。
- **不触发的场景**（保持现状）：
  - 会话变了但归属项目没变（同项目内换会话，含侧栏点击）→ 项目多半已展开；即便用户手动收起过，也不强制展开（尊重用户意图）；
  - 侧栏点击项目头/会话行 → 现有 `userToggledProjectRef` 让位机制不变。
- 实现细节：上一个选中会话的归属项目用 ref 记录（副作用内对比，避免重渲染循环）。归属项目取 `selectedSession.__projectId ?? selectedProject.projectId`——注意 URL 解析路径（`useProjectsState` 的匹配 effect）产出的 session 对象不保证带 `__projectId`（那是侧栏 `handleSessionClick` 才打的标记），所以 **selectedProject 对比是外部跳转的主路径**，`__projectId` 只在侧栏点击链路上可用。
- 任何「落进会话」的路径（冷启动 restore-last-session / /tasks 切回主页面恢复同一会话 / URL 直开/刷新）都会走「null→session」触发展开：**有意为之，且是最终裁决的语义**（2026-10-12 用户确认）——/tasks 与 / 是不同 Route，往返必然重挂 AppContent、ref 清零，「切回同一会话不展开」与「URL 直开展开」在此实现下不可区分，两者统一为「落进会话 = 展开归属项目」。代价是用户曾手动收起的项目在切回/刷新时会被重新展开一次，接受。

### 验收标准

- 从任务页「打开会话」/ 通知点击 / 收件箱跳入 → 左侧栏 owning 项目展开，session 行高亮（primary 边框 + 左 accent 条）。
- 侧栏手动收起某项目后，同项目内点其他会话 → 不强制展开。
- 「落进会话 = 展开归属项目」统一语义：URL 直开/刷新、冷启动 restore、/tasks 切回主页面恢复会话，均展开 owning 项目（重挂后 ref 清零、均走 null→P 路径，无法也不必区分）。

### 测试

- `utils.test.ts`：`shouldAutoExpandSelectedProject` 语义不变（不回归）；如新增纯函数判定「跨项目会话切换是否强制展开」，按新函数补用例。
- `useSidebarController` 是 hook（SSR 测试环境不跑 effect），靠人工验收 + 现有 `SidebarProjectSessions.test.tsx` 不回归。

## 错误处理

- 第 1 部分：GET /config 失败已有 loadError 分支；dsh 区块字段留空保存 = 清除该配置（既有全局语义）；auth status 拉取失败显示「认证状态未知」（AuthStatus 既有行为）。
- 第 2 部分：`__projectId` 缺失走 selectedProject 回退；均不引入新错误路径。

## 范围外（明确不做）

- dsh 的 binPath/dshHome/patchPath/toolApprovalTimeoutMs 等高级字段不做 UI（用户确认只要 baseUrl + apiKey）。
- 不改后端任何文件。
- 不改「最近会话」/搜索结果区块的选中高亮样式。
