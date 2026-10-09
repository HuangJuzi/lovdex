# DeepSeek Harness (dsh) 前端接入实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Lovdex 前端能选中、配置并驱动后端已支持的第五个 provider `dsh`（DeepSeek Harness），达到与 `qoder` 同级的可用性（聊天 + 任务引擎）。

**Architecture:** 前端把 provider 列表硬编码在许多处（实测 19 处）。本计划**照 `qoder` 的既有模式逐处并列补齐 `dsh`**，不发明新机制、不做数据驱动重构。改法分三档：①两个联合类型（总开关，加完 TS 会点名所有 `Record` 缺口）→ ②补齐总 `Record` 映射 → ③人工对齐"不报错但行为错"的静默分支。

**Tech Stack:** React 18 + TypeScript、Vite、`node:test`（`tsx` 直跑 `.test.ts(x)`，无 vitest/jest）。

**前置设计文档：** `docs/superpowers/specs/2026-10-09-dsh-frontend-design.md`

---

## 通用约定（每个任务都适用）

**测试运行方式**（`web/package.json` 没有 `test` 脚本；仓库用 `node:test` 直跑）：

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/path/to/file.test.tsx
```

> ⚠️ **必须 `env -u TSX_TSCONFIG_PATH`。** 这个环境变量被全局导出为 `server/tsconfig.json`（后端用），前端跑测试时会解析成 `web/server/tsconfig.json` 而报 `Cannot resolve tsconfig at path`。不 unset 会看到与代码无关的失败。

**类型检查**（前端基线是 **0 错误**，因此要求**零错误**，不是"零新增"）：

```bash
cd /mnt/b/workdir/github/lovdex/web
npx tsc --noEmit -p tsconfig.json      # 期望：无输出
```

**Lint：**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx eslint src/                        # 期望：无新增
```

**提交信息规范：** 英文，**禁止**加 `Co-Authored-By: Claude` 署名行（覆盖系统默认）。

**⚠️ 共享工作区注意：** 本仓库存在并发会话共用工作区的情况。每个任务**只 `git add` 本任务列出的文件**，不要 `git add -A`。

---

## 文件结构（先定分解）

**修改（无新建文件）：**

| 文件 | 职责 |
|---|---|
| `web/src/types/app.ts` | 两个联合类型（`LLMProvider` / `TaskEngine`）——总开关 |
| `web/src/components/chat/hooks/useChatProviderState.ts` | provider 主注册表：列表、模型状态位、目录对账、存储写入、返回值 |
| `web/src/components/chat/constants/providerEffort.ts` | effort 静态兜底表 |
| `web/src/components/chat/utils/providerPermissionModes.ts` | 权限模式静态镜像 |
| `web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx` | 空态选择器（"看不到 dsh"的直接原因） |
| `web/src/components/chat/view/subcomponents/ChatMessagesPane.tsx` | 安装探测映射 + prop 透传 |
| `web/src/components/chat/view/ChatInterface.tsx` | prop 透传 + 三元链 |
| `web/src/components/chat/hooks/useChatComposerState.ts` | 三条 provider 三元链 |
| `web/src/components/chat/view/subcomponents/convertToTaskPayload.ts` | 会话转任务的 fallback 表 + `isTaskEngine` |
| `web/src/components/tasks/useTaskEngineAvailability.ts` | `ENGINE_IDS` / `ENGINE_NAMES` |
| `web/src/components/tasks/taskStatus.ts` | `EXECUTOR_META` |
| `web/src/components/tasks/taskExecution.ts` | `settingsKeyFor` |
| `web/src/components/tasks/TaskDetail.tsx` | 执行引擎硬编码 `<option>` 列表 |
| `web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.test.tsx` | 既有断言更新（4 → 5 provider） |
| `web/src/components/tasks/useTaskEngineAvailability.test.ts` | 既有断言更新（两处列表） |

---

## Task 1: 联合类型 + 总 Record 映射

改完两个联合类型后，TS 会立刻点名所有 `Record<LLMProvider|TaskEngine, …>` 的缺口。本任务把**编译器能抓到的**全部一次补齐；静默分支留给后续任务。

**Files:**
- Modify: `web/src/types/app.ts:1`, `web/src/types/app.ts:97`
- Modify: `web/src/components/chat/hooks/useChatProviderState.ts:21`
- Modify: `web/src/components/chat/utils/providerPermissionModes.ts:11`
- Modify: `web/src/components/chat/view/subcomponents/convertToTaskPayload.ts:17`
- Modify: `web/src/components/tasks/useTaskEngineAvailability.ts:8`
- Modify: `web/src/components/tasks/taskStatus.ts:89`

- [ ] **Step 1: 先改两个联合类型（制造编译错误）**

`web/src/types/app.ts:1`：

```ts
export type LLMProvider = 'claude' | 'codex' | 'opencode' | 'qoder' | 'dsh';
```

`web/src/types/app.ts:97`：

```ts
export type TaskEngine = 'claude' | 'codex' | 'opencode' | 'qoder' | 'dsh';
```

- [ ] **Step 2: 跑 typecheck，记录 TS 点名的文件**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json`
Expected: 报错集中在若干 `Record<LLMProvider, …>` / `Record<TaskEngine, …>` 处（缺失 `'dsh'` 属性）。把报出的文件清单记下来——与下面步骤比对，若出现**本任务未列出**的文件，停下来报告（说明地形与实测不符）。

- [ ] **Step 3: 补 `FALLBACK_DEFAULT_MODEL`**

`web/src/components/chat/hooks/useChatProviderState.ts:21` 附近：

```ts
const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  codex: 'gpt-5.4',
  opencode: 'opencode/deepseek-v4-flash-free',
  qoder: 'auto',
  // dsh's catalog `DEFAULT` is the neutral 'default' slot; the runner skips it
  // rather than sending it as an ACP route, so it is safe as a placeholder.
  dsh: 'default',
};
```

- [ ] **Step 4: 补 `PROVIDER_PERMISSION_MODES`**

`web/src/components/chat/utils/providerPermissionModes.ts:11`：

```ts
export const PROVIDER_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
  qoder: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
  // ACP has no Claude-specific mode concepts. dsh's runner only distinguishes
  // per-call popup approval from unattended auto-approval, so offering more
  // would let the user pick a mode the backend does not honour. Must stay in
  // sync with the backend's PROVIDER_CAPABILITIES.dsh.
  dsh: ['default', 'autoApprove'],
};
```

- [ ] **Step 5: 补 `convertToTaskPayload` 的 fallback 表**

`web/src/components/chat/view/subcomponents/convertToTaskPayload.ts:17`：

```ts
const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  codex: 'gpt-5.4',
  opencode: 'opencode/deepseek-v4-flash-free',
  qoder: 'auto',
  dsh: 'default',
};
```

- [ ] **Step 6: 补 `ENGINE_NAMES`**

`web/src/components/tasks/useTaskEngineAvailability.ts:8`：

```ts
export const ENGINE_NAMES: Record<TaskEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  qoder: 'Qoder',
  dsh: 'DeepSeek Harness',
};
```

- [ ] **Step 7: 补 `EXECUTOR_META`**

`web/src/components/tasks/taskStatus.ts:89`：

```ts
export const EXECUTOR_META: Record<TaskEngine, { label: string; badge: string }> = {
  claude: { label: '◈ Claude', badge: 'bg-success/10 text-success' },
  codex: { label: '◈ Codex', badge: 'bg-warning/10 text-warning' },
  opencode: { label: '◈ OpenCode', badge: 'bg-chart-6/10 text-chart-6' },
  qoder: { label: '◈ Qoder', badge: 'bg-info/10 text-info' },
  dsh: { label: '◈ DeepSeek', badge: 'bg-chart-4/10 text-chart-4' },
};
```

- [ ] **Step 8: 跑 typecheck，确认 Record 缺口清零**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: 无 `Record` 类缺失错误。**可能仍有其余错误**（静态分支的返回值类型），那是后续任务的范围——记录下来（例如 `ProviderSelectionEmptyState.tsx` 的 `getProviderDisplayName` 返回值变成可能 `undefined`）。若出现**只属于本任务文件**的新错误，就地修掉。

- [ ] **Step 9: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/types/app.ts \
        web/src/components/chat/hooks/useChatProviderState.ts \
        web/src/components/chat/utils/providerPermissionModes.ts \
        web/src/components/chat/view/subcomponents/convertToTaskPayload.ts \
        web/src/components/tasks/useTaskEngineAvailability.ts \
        web/src/components/tasks/taskStatus.ts
git commit -m "feat(web): add dsh to the provider unions and required record maps"
```

---

## Task 2: `useChatProviderState` —— provider 主注册表

这是最核心的一块：`PROVIDERS` 数组决定"拉哪些 provider 的模型"，模型状态位决定"composer 能不能持有 dsh 的模型"。

**Files:**
- Modify: `web/src/components/chat/hooks/useChatProviderState.ts`（`:28`, `:160-177`, `:219`, `:437`, `:444-494`, `:719-746`）

- [ ] **Step 1: 给 `PROVIDERS` 加 dsh**

`web/src/components/chat/hooks/useChatProviderState.ts:28`：

```ts
const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder', 'dsh'];
```

- [ ] **Step 2: 加 `dshModel` 状态位**

紧跟在 `qoderModel` 的 `useState`（约 `:175-177`）之后：

```ts
  const [dshModel, setDshModel] = useState<string>(() => {
    return localStorage.getItem('dsh-model') || FALLBACK_DEFAULT_MODEL.dsh;
  });
```

- [ ] **Step 3: 把 dsh 加进 `setStoredProviderModel` 的链**

`web/src/components/chat/hooks/useChatProviderState.ts:219` 附近，在 `qoder` 分支之后加：

```ts
    if (targetProvider === 'dsh') {
      setDshModel(model);
      localStorage.setItem('dsh-model', model);
      return;
    }
```

> 位置很重要：必须加在 `else { ... opencode ... }` 之前，否则 dsh 会静默写进 `opencode-model`。

- [ ] **Step 4: 把 dsh 加进 `providerModels` 的 Record**

`web/src/components/chat/hooks/useChatProviderState.ts:437` 附近：

```ts
  const providerModels = useMemo<Record<LLMProvider, string>>(() => ({
    claude: claudeModel,
    codex: codexModel,
    opencode: opencodeModel,
    qoder: qoderModel,
    dsh: dshModel,
  }), [claudeModel, codexModel, opencodeModel, qoderModel, dshModel]);
```

- [ ] **Step 5: 加 dsh 的目录对账 useEffect**

紧跟 `qoder` 那条 useEffect（约 `:483-494`）之后，**照其形状**：

```ts
  useEffect(() => {
    const dsh = providerModelCatalog.dsh;
    if (dsh) {
      const next = pickStoredOrCurrent('dsh-model', dshModel, dsh);
      if (next !== dshModel) {
        setDshModel(next);
      }
      if (localStorage.getItem('dsh-model') !== next) {
        localStorage.setItem('dsh-model', next);
      }
    }
  }, [providerModelCatalog.dsh, dshModel]);
```

- [ ] **Step 6: 把 dsh 加进返回的 API**

`web/src/components/chat/hooks/useChatProviderState.ts:719-746` 的 `return { ... }`，在 `qoderModel, setQoderModel,` 之后加：

```ts
    dshModel,
    setDshModel,
```

- [ ] **Step 7: 跑 typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "useChatProviderState" || echo "no errors in useChatProviderState"`
Expected: `no errors in useChatProviderState`。

> 此时 `ChatInterface` / `ChatMessagesPane` 可能因缺 prop 报错——那是 Task 5 的范围，本任务只保证本文件干净。

- [ ] **Step 8: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/hooks/useChatProviderState.ts
git commit -m "feat(web): register dsh in the chat provider state hook"
```

---

## Task 3: effort 静态兜底表

**Files:**
- Modify: `web/src/components/chat/constants/providerEffort.ts:5`

**背景（实测）：** dsh 的合法 effort 值恰好是 `off/low/high/max`（真机 `session/new` 的 `configOptions[reasoning_effort]`），**与其余四家的档位不重合**（claude 是 `low/medium/high/max`）。前端 `getEffortOptionsForModel` 优先读模型目录里的 `effort.values`（后端 dsh 目录已声明），此表只在**目录拉取完成之前**兜底；不补则在首屏窗口内 dsh 没有 effort 可选。

- [ ] **Step 1: 加 dsh 条目**

`web/src/components/chat/constants/providerEffort.ts:5`：

```ts
export const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  qoder: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  // dsh's own vocabulary (off/low/high/max) — NOT the same set as its siblings.
  // The backend catalog carries the same list; this is only the pre-fetch fallback.
  dsh: ['off', 'low', 'high', 'max'],
};
```

- [ ] **Step 2: 跑 typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "providerEffort" || echo "no errors in providerEffort"`
Expected: `no errors in providerEffort`

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/constants/providerEffort.ts
git commit -m "feat(web): add the dsh effort fallback slot"
```

---

## Task 4: `ProviderSelectionEmptyState` —— 空态选择器

**这是"看不到 dsh"的直接原因**：`PROVIDER_META` 没有 dsh 条目。

**Files:**
- Modify: `web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`（`:25`, `:51-59`, 约 `:97`, `:110`, `:195`, `:378`）

- [ ] **Step 1: `PROVIDER_META` 加条目**

`web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx:25`：

```tsx
const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "opencode", name: "OpenCode" },
  { id: "qoder", name: "Qoder" },
  { id: "dsh", name: "DeepSeek" },
];
```

- [ ] **Step 2: prop 类型与解构加一对 dshModel**

在 props 类型里 `qoderModel` / `setQoderModel`（约 `:51-59`）之后加：

```tsx
  dshModel: string;
  setDshModel: (model: string) => void;
```

在组件参数解构里同样位置加：

```tsx
  dshModel,
  setDshModel,
```

- [ ] **Step 3: `getCurrentModel` 加 dsh 形参**

约 `:96`，函数签名与函数体一起改（**注意调用点也要同步，见 Step 7**）：

```tsx
function getCurrentModel(
  p: LLMProvider,
  c: string,
  co: string,
  o: string,
  q: string,
  d: string,
) {
  if (p === "claude") return c;
  if (p === "codex") return co;
  if (p === "opencode") return o;
  if (p === "qoder") return q;
  return d;
}
```

- [ ] **Step 4: `getProviderDisplayName` 加 dsh**

约 `:110`：把最后的 `return "Claude";` 改为显式分支（不要依赖兜底）：

```tsx
function getProviderDisplayName(p: LLMProvider) {
  if (p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  if (p === "opencode") return "OpenCode";
  if (p === "qoder") return "Qoder";
  if (p === "dsh") return "DeepSeek";
  return "Claude";
}
```

- [ ] **Step 5: `setModelForProvider` 加 dsh 分支**

约 `:195`，在 `qoder` 分支之后、最终 `else`（写 opencode）之前加：

```tsx
      } else if (providerId === "dsh") {
        setDshModel(modelValue);
        localStorage.setItem("dsh-model", modelValue);
      }
```

- [ ] **Step 6: `readyPrompt` 查表加 dsh**

约 `:378`，在 `qoder` 条目之后加：

```tsx
                dsh: t("providerSelection.readyPrompt.dsh", {
                  model: dshModel,
                  defaultValue: "Ready with DeepSeek Harness {{model}}",
                }),
```

> `t(key, { defaultValue })` 在 key 缺失时会回落到 `defaultValue`，所以**即使 `i18n/locales/en/chat.json` 里没有 dsh 键也不会渲染空行**（本设计把 i18n 列为非目标）。

- [ ] **Step 7: 找到并更新 `getCurrentModel` 的调用点**

Run: `cd /mnt/b/workdir/github/lovdex/web && grep -n "getCurrentModel(" src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
在该调用处把 `dshModel` 作为第 6 个实参传入（照现有 4 个模型实参的写法）。

- [ ] **Step 8: 跑 typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "ProviderSelectionEmptyState" || echo "no errors in ProviderSelectionEmptyState"`
Expected: `no errors in ProviderSelectionEmptyState`（调用方 `ChatMessagesPane` 的缺 prop 报错属 Task 5）

- [ ] **Step 9: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx
git commit -m "feat(web): offer dsh in the chat provider picker"
```

---

## Task 5: prop 透传链（`ChatInterface` → `ChatMessagesPane`）

**Files:**
- Modify: `web/src/components/chat/view/subcomponents/ChatMessagesPane.tsx:22`, props 类型, 约 `:235-256`
- Modify: `web/src/components/chat/view/ChatInterface.tsx`（解构约 `:78-87`，透传约 `:247-251`, `:467-474`）

- [ ] **Step 1: `ChatMessagesPane` 的 `ALL_PROVIDERS` 加 dsh**

`web/src/components/chat/view/subcomponents/ChatMessagesPane.tsx:22`：

```ts
const ALL_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder', 'dsh'];
```

- [ ] **Step 2: `ChatMessagesPane` props 类型 + 解构加 dshModel**

在 props 类型里 `qoderModel` / `setQoderModel` 之后加：

```ts
  dshModel: string;
  setDshModel: (model: string) => void;
```

组件参数解构同位置加：

```ts
  dshModel,
  setDshModel,
```

- [ ] **Step 3: 往下传给 `ProviderSelectionEmptyState`**

约 `:235-256` 的 `<ProviderSelectionEmptyState ... />`，在 `qoderModel={qoderModel}` / `setQoderModel={setQoderModel}` 之后加两行：

```tsx
          dshModel={dshModel}
          setDshModel={setDshModel}
```

- [ ] **Step 4: `ChatInterface` 从 hook 解构 dshModel**

`web/src/components/chat/view/ChatInterface.tsx` 约 `:78-87` 从 `useChatProviderState()` 解构处，在 `qoderModel, setQoderModel,` 之后加：

```ts
    dshModel,
    setDshModel,
```

- [ ] **Step 5: `ChatInterface` 往下传**

约 `:467-474` 给 `ChatMessagesPane` 的 props，在 `qoderModel={qoderModel}` / `setQoderModel={setQoderModel}` 之后加：

```tsx
          dshModel={dshModel}
          setDshModel={setDshModel}
```

- [ ] **Step 6: 处理 `ChatInterface` 约 `:417` 的三元链**

`web/src/components/chat/view/ChatInterface.tsx` 约 `:417` 有一条 `? qoderModel : claudeModel` 的 provider 三元链。把它改为显式包含 dsh（照该处既有写法，在 qoder 分支后插入 `provider === 'dsh' ? dshModel :`）。

- [ ] **Step 7: 跑 typecheck，确认全绿**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: `0`

> 若仍有错误，全部集中在 `ProviderSelectionEmptyState.test.tsx`（缺新 prop）——那是 Task 7 的范围，可继续。

- [ ] **Step 8: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/ChatMessagesPane.tsx \
        web/src/components/chat/view/ChatInterface.tsx
git commit -m "feat(web): thread the dsh model through the chat prop chain"
```

---

## Task 6: 发送路径的三元链（`useChatComposerState`）

**这些是静默错误**：dsh 会静默回落到 `claudeModel` / `claude-settings` —— 也就是说，用 dsh 会话发送时实际发的是 claude 的模型，且工具设置读的是 claude 的键。

**Files:**
- Modify: `web/src/components/chat/hooks/useChatComposerState.ts`（约 `:396-401`, `:679-685`, `:703-708`）

- [ ] **Step 1: 让 hook 拿到 dshModel**

先确认 `useChatComposerState` 是怎样获得各 provider 模型的：

Run: `cd /mnt/b/workdir/github/lovdex/web && grep -n "claudeModel\|qoderModel\|dshModel" src/components/chat/hooks/useChatComposerState.ts | head -20`

按其既有方式（props 或从 `useChatProviderState` 解构）补上 `dshModel`。若 `dshModel` 来自 props，需在调用处一并传入——调用点用 `grep -rn "useChatComposerState(" src/` 找。

- [ ] **Step 2: `settingsKeyFor` 等价链（`:679-685`）**

决定：**dsh 复用 `claude-settings`**（设计 §3.1：dsh 走 ACP 逐次审批，与 claude 的 `canUseTool` 模型最接近；`allowedTools` 面板对 dsh 无意义但 `skipPermissions` 有意义，且给独立键会渲染出后端不读的空面板）。因此这条链**不改**——dsh 落到 `: 'claude-settings'` 正是想要的。**但必须加一行注释说明这是刻意为之**：

```ts
        const settingsKey =
          provider === 'codex'
            ? 'codex-settings'
            : provider === 'opencode'
              ? 'opencode-settings'
              : provider === 'qoder'
                  ? 'qoder-settings'
                // dsh deliberately shares the claude key: its runner approves
                // through ACP (like Claude's canUseTool), it has no tools
                // allow/deny list, and a dedicated key would render a settings
                // panel the backend never reads. See the frontend design §3.1.
                : 'claude-settings';
```

- [ ] **Step 3: 发送模型选择链（`:703-708`）**

```ts
    const model =
      provider === 'codex'
        ? codexModel
        : provider === 'opencode'
          ? opencodeModel
          : provider === 'qoder'
            ? qoderModel
            : provider === 'dsh'
              ? dshModel
              : claudeModel;
```

- [ ] **Step 4: 活动模型上报链（`:396-401`）**

同一形状，在 `provider === 'qoder' ? qoderModel :` 之后插入 `provider === 'dsh' ? dshModel :`。

- [ ] **Step 5: 跑 typecheck 与 lint**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"; npx eslint src/components/chat/hooks/useChatComposerState.ts`
Expected: `0` 个类型错误；lint 无新增。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/hooks/useChatComposerState.ts
git commit -m "feat(web): stop dsh falling back to claude on the send path"
```

---

## Task 7: 任务引擎 + 既有测试更新

**Files:**
- Modify: `web/src/components/tasks/useTaskEngineAvailability.ts:6`
- Modify: `web/src/components/tasks/taskExecution.ts:50`
- Modify: `web/src/components/tasks/TaskDetail.tsx:727`
- Modify: `web/src/components/chat/view/subcomponents/convertToTaskPayload.ts:25`
- Test: `web/src/components/tasks/useTaskEngineAvailability.test.ts:58,65`
- Test: `web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.test.tsx`

- [ ] **Step 1: `ENGINE_IDS` 加 dsh**

`web/src/components/tasks/useTaskEngineAvailability.ts:6`：

```ts
export const ENGINE_IDS: TaskEngine[] = ['claude', 'codex', 'opencode', 'qoder', 'dsh'];
```

- [ ] **Step 2: `taskExecution` 的 `settingsKeyFor` 加注释（不改行为）**

`web/src/components/tasks/taskExecution.ts:50` 的 `default: return 'claude-settings';` 上方加注释，说明 dsh 刻意共用：

```ts
    default:
      // claude AND dsh share this key — see the frontend design §3.1: dsh has
      // no tools allow/deny list and its approvals flow through ACP.
      return 'claude-settings';
```

- [ ] **Step 3: `TaskDetail` 的执行引擎下拉加 dsh**

`web/src/components/tasks/TaskDetail.tsx:727` 附近的硬编码 `<option>` 列表，在 qoder 之后加：

```tsx
                    <option value="dsh">DeepSeek Harness</option>
```

> 若该 `<select>` 已改为由 `ENGINE_NAMES` 驱动，则跳过本步（Step 1 已覆盖）。用 `grep -n "ENGINE_NAMES\|<option value=\"qoder\"" src/components/tasks/TaskDetail.tsx` 确认。

- [ ] **Step 4: `convertToTaskPayload` 的 `isTaskEngine` 加 dsh**

`web/src/components/chat/view/subcomponents/convertToTaskPayload.ts:25`：

```ts
function isTaskEngine(value: unknown): value is TaskEngine {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'qoder' || value === 'dsh';
}
```

> 不加则 dsh 会话转任务时 `executorProvider` 静默变成 `'claude'`。

- [ ] **Step 5: 更新 `useTaskEngineAvailability.test.ts` 的两处列表断言**

`web/src/components/tasks/useTaskEngineAvailability.test.ts:58` 与 `:65`，把

```ts
  assert.deepEqual(state.options, ['claude', 'codex', 'opencode', 'qoder']);
```

两处都改为：

```ts
  assert.deepEqual(state.options, ['claude', 'codex', 'opencode', 'qoder', 'dsh']);
```

并把两处测试名里的 "all four" 改为 "all five"。

- [ ] **Step 6: 运行该测试**

Run: `cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/useTaskEngineAvailability.test.ts`
Expected: 全部 PASS。

- [ ] **Step 7: 更新 `ProviderSelectionEmptyState.test.tsx`**

两处改动：
1. 顶部的 `ALL_PROVIDERS` 常量（`:15`）加 `'dsh'`：
   ```ts
   const ALL_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder', 'dsh'];
   ```
2. `renderPicker` 里给组件补上新增的两个 prop（照 `qoderModel="qoder-default"` / `setQoderModel={noop}` 的写法）：
   ```tsx
       dshModel="dsh-default"
       setDshModel={noop}
   ```

- [ ] **Step 8: 运行该测试**

Run: `cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/ProviderSelectionEmptyState.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 9: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/useTaskEngineAvailability.ts \
        web/src/components/tasks/taskExecution.ts \
        web/src/components/tasks/TaskDetail.tsx \
        web/src/components/chat/view/subcomponents/convertToTaskPayload.ts \
        web/src/components/tasks/useTaskEngineAvailability.test.ts \
        web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.test.tsx
git commit -m "feat(web): let dsh be chosen as a task execution engine"
```

---

## Task 8: 全量验证

**Files:** 无（仅验证）

- [ ] **Step 1: 前端 typecheck 必须为 0 错误**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: `0`（前端基线为 0，要求零错误）

- [ ] **Step 2: lint 无新增**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx eslint src/ 2>&1 | tail -3`
Expected: 与改动前相比无新增问题。

- [ ] **Step 3: 跑全部前端测试**

Run: `cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name '*.test.ts' -o -name '*.test.tsx') 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# fail 0`。

> 若个别测试因**既有**原因失败（与本改动无关），逐个确认其失败信息不涉及 provider/dsh，并在报告中说明。

- [ ] **Step 4: 后端不回归**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/*.test.* 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# fail 0`（本轮只动前端，后端应原样全绿）

- [ ] **Step 5: 浏览器手动验收**

前端由 Vite 热更新，无需重启；刷新页面即可。
1. 空态选择器里出现 **DeepSeek**（面板名），点开可见 **DeepSeek Harness** 引擎项。
2. 选中 dsh 后：模型下拉出现 dsh 目录项；effort 下拉出现 `off/low/high/max`；权限模式只有 `default/autoApprove`。
3. 任务页新建任务时，执行引擎可选 **DeepSeek Harness**。

> ⚠️ 这一步需要真实 `dsh` 可执行文件（`binPath`）与已启用的 llm-proxy。若本机未装 `dsh`，选择器仍会**显示** dsh（`installedProviders[id] !== false` 的语义），但发消息会失败——这属于环境问题，不是本计划的缺陷。

- [ ] **Step 6: 汇报验收结果**

把 Step 1–5 的**实际输出**写进汇报（不要只写"通过"）。Step 5 若因环境缺失只完成 1–3，明确说明 4 未做及其原因。

---

## Self-Review（作者自查，已执行）

**1. Spec 覆盖：**
- §2.1 两个联合类型 → Task 1 Step 1 ✅
- §2.2 六处总 Record → Task 1 Step 3–7 ✅
- §2.3 静默错分支：`PROVIDERS` → Task 2 Step 1；模型状态位/对账/返回值 → Task 2 Step 2/5/6；`setStoredProviderModel` → Task 2 Step 3；`providerModels` → Task 2 Step 4；`PROVIDER_META` 等 → Task 4；`ChatMessagesPane`/`ChatInterface` prop 链 → Task 5；composer 三条三元链 → Task 6；`ENGINE_IDS`/`settingsKeyFor`/`TaskDetail`/`isTaskEngine` → Task 7 ✅
- §3.1 `settingsKeyFor('dsh')` 复用 claude-settings → Task 6 Step 2 + Task 7 Step 2（均为"加注释不改行为"）✅
- §3.2 权限模式 `['default','autoApprove']` → Task 1 Step 4 ✅
- §3.3 effort `off/low/high/max` → Task 3 ✅
- §5 测试策略（含既有断言更新）→ Task 7 Step 5–8，Task 8 Step 3 ✅
- §6 验收标准（typecheck 0 / lint / 单测 / 浏览器）→ Task 8 ✅
- §1.3 四个"不做"→ 未建任务（正确）；其中 i18n 不做但用 `defaultValue` 兜底，→ Task 4 Step 6 ✅

**2. 占位符扫描：** 无 TBD/TODO。每个改代码的步骤都给了完整代码。**Task 5 Step 6 与 Task 6 Step 1** 是刻意的"先定位再改"——因为那两处的既有写法（三元链的具体上下文、`useChatComposerState` 获取模型的方式）需要读一眼才能对齐，写死代码反而会写错。这不是占位符，是"给定位命令而非猜测值"。

**3. 类型一致性：** `dshModel` / `setDshModel` 在 Task 2（定义）→ Task 4（props）→ Task 5（透传）→ Task 6（消费）全链同名；`FALLBACK_DEFAULT_MODEL.dsh = 'default'` 在 Task 1 定义、Task 2 消费；权限模式 `['default','autoApprove']` 在 Task 1 定义，与后端 `provider-capabilities.service.ts` 的 dsh 条目一致。
