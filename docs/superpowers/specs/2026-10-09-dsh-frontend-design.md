# Lovdex 前端接入 DeepSeek Harness（dsh）—— 第五个 provider 设计

- 日期：2026-10-09
- 状态：设计已确认，待实现
- 范围：**仅前端**（`web/src/`）。后端接入已完成（见 `2026-10-08-deepseek-harness-provider-design.md`）。
- 前置：后端 `dsh` provider 已注册、runner 已接线、`/api/providers/*` 已认 dsh；本设计只解决"UI 里选得到、并且选对"。

## 1. 背景与目标

### 1.1 现状

后端支持 dsh 之后，UI 里**依然看不到 dsh**。原因不是后端，而是前端把 provider 列表**硬编码**在若干处，其中最关键的是：

```ts
// web/src/components/chat/hooks/useChatProviderState.ts:28
const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder'];
```

这份列表**不问后端**，所以后端加了 dsh 也不会自动出现。这是后端那期刻意划出的范围，现在补齐。

### 1.2 目标

让 dsh 在前端达到与 qoder **同级**的可用性：聊天里能选中、能选模型、能选 reasoning effort、能选权限模式；并且可被选作任务/定时任务的执行引擎。

### 1.3 非目标（明确不做）

- **不做设置页的 dsh 凭据区块。** dsh 不需要凭据 UI —— 它继承 llm-proxy 的端点与凭据（见后端设计 §"follow the same LLM routing rule as the claude provider"）。给它加一个凭据表单会让用户以为要填 key，而实际上填了也不影响（端点优先级见后端 `resolveDshProviderEnv`）。**加它是误导，故不做。**
- **不做 logo 与 i18n 显示名。** 不做则 dsh 会话在消息头像/侧栏显示 Claude 图标、`messageTypes` 标签回落 "Claude"。这是**外观问题，不是功能问题**，不影响"能否选中/能否跑通"。留作可选后续。
- **不改 `RUNTIME_HONORS_SESSION_MODEL_OVERRIDE`（不加 dsh）。** 该集合决定前端是否把"会话级 `/model` 覆盖"当作运行时保证。前端那份只是 localStorage 便签；真实模型由后端 `changeActiveModel` → `session/set_config_option` 落库生效（已实现）。把 dsh 加进去会给前端一个**比后端更强的保证**，反而可能显示与运行时不一致的模型。
- **不重构前端的 provider 硬编码为数据驱动。** 19 处硬编码是既有技术债，收敛成"一张 provider 表"是更大的重构，超出本次目标。本次**照 qoder 的模式逐处补齐**，保持与现有四个 provider 同构。

## 2. 前端 provider 接触点清单（实测，`web/src/`）

### 2.1 两个联合类型（总开关）

```ts
// web/src/types/app.ts:1
export type LLMProvider = 'claude' | 'codex' | 'opencode' | 'qoder' | 'dsh';
// web/src/types/app.ts:97
export type TaskEngine = 'claude' | 'codex' | 'opencode' | 'qoder' | 'dsh';
```

前端各留一份、**不从后端共享**。加上 `'dsh'` 后，所有 `Record<LLMProvider, …>` / `Record<TaskEngine, …>` 会**编译报错**——这正是我们要的：TS 替我们点名（第 2.2 类）。

### 2.2 总 Record 映射（不补即编译失败）

| 文件 | 现有键 | dsh 值 | 依据 |
|---|---|---|---|
| `chat/hooks/useChatProviderState.ts:21` `FALLBACK_DEFAULT_MODEL` | claude/codex/opencode/qoder | `'default'` | 与后端目录 `DEFAULT: 'default'` 一致；该哨兵值在 runner 里被跳过（不当作路由发送） |
| `chat/hooks/useChatProviderState.ts:437` `providerModels` | 四值 | `dsh: dshModel` | 跟随新增状态位 |
| `chat/utils/providerPermissionModes.ts:11` `PROVIDER_PERMISSION_MODES` | 四值 | `['default', 'autoApprove']` | **必须与后端 `provider-capabilities.service.ts` 的 dsh 条目一致**（该文件自称"改一处要改三处"） |
| `tasks/useTaskEngineAvailability.ts:8` `ENGINE_NAMES` | 四值 | `'DeepSeek Harness'` | 展示名 |
| `tasks/taskStatus.ts:89` `EXECUTOR_META` | 四值 | `{ label: 'DeepSeek Harness', badge: … }` | 与 qoder 条目同形 |
| `chat/view/subcomponents/convertToTaskPayload.ts:17` `FALLBACK_DEFAULT_MODEL` | 四值 | `'default'` | 同 2.2 第一行 |

### 2.3 静默错分支（不报错但行为错——最危险的一类）

| 文件:行 | 现状（dsh 会怎样） | 改成 |
|---|---|---|
| `useChatProviderState.ts:28` `PROVIDERS` | dsh 不在 → **不拉模型、无 effort 槽、composer 根本装不下 dsh** | 追加 `'dsh'` |
| `useChatProviderState.ts:219` `setStoredProviderModel` 的 else | else → 静默写 `opencode-model` | 加 `dsh` 分支写 `dsh-model` |
| `useChatProviderState.ts:160-177` 模型状态位 | 只有四个 `useState` | 加 `dshModel` / `setDshModel` |
| `useChatProviderState.ts:444-494` 目录对账 useEffect | 只有四条 | 加第五条（dsh） |
| `useChatProviderState.ts:720-746` 返回的 API | 只有四对 | 加 `dshModel` / `setDshModel` |
| `permissionModesFor`（`providerPermissionModes.ts:31`） | `?? claude` → **dsh 静默拿到 claude 的 6 档** | 有显式条目后自然不回落 |
| `chat/view/subcomponents/ProviderSelectionEmptyState.tsx:25` `PROVIDER_META` | 无 dsh → **选择器里没有 dsh**（这才是"看不到"的直接原因） | 加条目 |
| 同上 `:97` `getCurrentModel` else | dsh → 落 qoder 的模型 | 加 dsh 分支 |
| 同上 `:110` `getProviderDisplayName` | dsh → `"Claude"` | 加 dsh |
| 同上 `:195` `setModelForProvider` else | dsh → 写 qoder-model | 加 dsh |
| 同上 `:378` `readyPrompt` 查表 | dsh → `undefined` → 渲染**空行** | 加 dsh 文案 |
| `chat/view/subcomponents/ChatMessagesPane.tsx:22` `ALL_PROVIDERS` | `installedProviders` 缺 dsh 键 → 永远不过滤（不崩，但装没装都显示） | 追加 `'dsh'` |
| `tasks/useTaskEngineAvailability.ts:6` `ENGINE_IDS` | dsh 不能作任务引擎 | 追加 `'dsh'` |
| `tasks/taskExecution.ts:50` `settingsKeyFor` else | dsh → 读 `claude-settings` | **见 §3 决策** |
| `tasks/TaskDetail.tsx:727` 硬编码 `<option>` 列表 | dsh 不能在这里被选 | 追加 |
| `chat/hooks/useChatComposerState.ts:396-401, 679-685, 703-708` 三条 provider 三元链 | dsh → 回落 `claudeModel` / `claude-settings` | 加 dsh 分支 |
| `convertToTaskPayload.ts:25` `isTaskEngine` | dsh 会话转任务 → 回落 `'claude'` | 加 `'dsh'` |
| prop 透传链（`ChatInterface` → `ChatMessagesPane` → `ProviderSelectionEmptyState`，约 6 文件） | `dshModel` 传不进去 | 逐层加一对 prop |

### 2.4 无需改动（已确认）

- **审批弹窗路径**：`useChatRealtimeHandlers.ts:326` 只读 `{ requestId, toolName, input, context }` 并按 `requestId` 索引，**不看 provider**；回答走 `chat.permission-response`（`useChatComposerState.ts:1337`），同样只按 `requestId`。dsh 的 `permission_request` 形状与 claude/qoder 相同，**零改动**。
- `chatPermissions.ts:36` / `handleGrantToolPermission`（"记住这个工具"）有 `provider !== 'claude'` 守卫——dsh 不享受该特性，与 qoder 一致，正确。
- 侧栏/项目侧 `?? 'claude'` 默认值（`Sidebar.tsx`、`AppContent.tsx` 等）只服务**未知** provider，无害。

## 3. 关键决策

### 3.1 `settingsKeyFor('dsh')` → 复用 `claude-settings`

**决策：dsh 复用 `claude-settings`，不新建独立键。**

**理由（实测依据）：**
- claude 的 `allowedTools`/`disallowedTools` 是**给 SDK 的**（`sdkOptions.allowedTools`），SDK 自己解析规则（如 `Write(/etc/**)`）。
- qoder 自己的 runner **不读这两个字段**，改走 `resolveQoderPermissionOptions(permissionMode)` → `--permission-mode`。
- dsh 的 runner 走 ACP `session/request_permission` + `autoApprove`，**同样没有 tools allow/deny 的概念**。

若给 dsh 一个独立键，前端会渲染一份"工具允许/禁止列表"的设置面板，而后端**根本不读**——那是骗人。复用 `claude-settings` 则保证 `skipPermissions`（bypassPermissions）语义可用（dsh 能兑现），且 `allowedTools` 面板与 claude 一致（同为"弹窗审批 + 可记住"的模型）。

### 3.2 dsh 的权限模式集合

**决策：`['default', 'autoApprove']`，前端静态镜像与后端 capabilities 严格一致。**

ACP 没有 Claude 特有的模式概念（`plan`/`acceptEdits` 等），dsh 的 runner 只区分"逐次弹窗审批"与"无人值守自动审批"两种。给 dsh 显示 `plan` 会让用户选到一个后端不兑现的模式。

### 3.3 dsh 的 reasoning effort 取值

**决策：`off` / `low` / `high` / `max`，默认 `high`。**

**依据（真机实测）：** dsh 的 `session/new` 返回 `configOptions[reasoning_effort]`，合法值恰为 `off/low/high/max`，当前值 `high`。**这与其余四个 provider 的档位不重合**（claude 是 `low/medium/high/max`）。已在后端 dsh 目录里以 `effort` 块声明，前端 `getEffortOptionsForModel` 优先读目录，静态表仅作拉取前兜底——因此 `FALLBACK_PROVIDER_EFFORT_VALUES` **也应同步加 dsh 条目**，否则首屏窗口内会没有 effort 可选。

### 3.4 模型展示值

后端 dsh 目录的模型值是 JSON 编码的路由对（如 `["deepseek-official","deepseek-v4-flash"]`）。前端**逐字透传**：`useChatProviderState` 的 `pickStoredOrCurrent` 按精确字符串匹配 `OPTIONS[].value`，`runtimeOptions.model` 原样送到后端，runner 再拆成 ACP config-option 值。**前端不需要理解这个格式**，不需要特殊处理。

## 4. 实施策略

**照 qoder 的模式逐处补齐，不发明新机制。** 具体做法：把 `qoder` 在每一处的出现当作模板，在其旁并列一份 `dsh`。保持全篇同构，便于日后把这 19 处收敛成一张表时一并处理。

**顺序要求：** 先改 §2.1 两个联合类型，让 TS 报出 §2.2 的全部 Record 缺口；补齐 Record 后再做 §2.3 的静默错分支（那些不会报错，必须人工逐条对齐清单）。**最后跑一次全量 `npm run typecheck`（前端基线为 0 错误，故要求零错误）。**

## 5. 测试策略

- **单元**：`permissionModesFor('dsh')` 返回 `['default','autoApprove']`；`getProviderDisplayName('dsh')` 不回落 "Claude"；`convertToTaskPayload` 对 dsh 会话不再回落 `executorProvider: 'claude'`。
- **既有断言更新**：`ProviderSelectionEmptyState.test.tsx:15`、`useTaskEngineAvailability.test.ts:58,65` 断言的是四 provider 的列表/顺序，追加 dsh 后需同步（这些是**必须改的**，不是可选的）。
- **不改**：审批弹窗相关的测试（路径未动）。

## 6. 验收标准

- `cd web && npm run typecheck` → **0 错误**（前端基线 0，要求零新增）。
- `cd web && npm run lint` → 零新增。
- 相关单测全绿（含被更新的既有断言）。
- **手动验收（浏览器）**：刷新页面后，空态选择器里出现 **DeepSeek Harness**；选中它 → 模型下拉出现 dsh 的目录项 → effort 下拉出现 `off/low/high/max` → 权限模式下拉只有 `default/autoApprove`。
- **端到端（可选，需真实 dsh 会话）**：发一条消息，观察流式文本与单一 `complete`；触发一次工具审批，确认弹窗可 allow/reject。

## 7. 后续（可选，不在本期）

- dsh 的 logo（`SessionProviderLogo` 加分支）与 i18n 显示名（`messageTypes.dsh`、`providerSelection.readyPrompt.dsh`）。
- 把 19 处硬编码收敛为单张 provider 表（技术债）。
