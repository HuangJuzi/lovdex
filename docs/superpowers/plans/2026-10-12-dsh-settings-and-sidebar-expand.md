# DeepSeek 设置区块 + 跳转 session 侧栏展开 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页新增 DeepSeek（dsh）凭据区块（baseUrl + apiKey，纳入配置档），并让外部跳转到 session 时左侧栏自动展开 owning 项目。

**Architecture:** 第 1 部分纯前端：加宽 `ProviderKey` 联合类型 + 表单白名单 + 设置页 Section，后端零改动（PROFILE_FIELDS.dsh、打码、auth status、env 下发均已就绪）。第 2 部分改 `useSidebarController` 的自动展开副作用：观察「选中会话跨项目变化」并强制展开目标项目，绕过既有的首挂守卫。

**Tech Stack:** React 18 + TypeScript（web/，vite），测试用 node:test + tsx（无 DOM 环境，只测纯函数）。

**测试运行方式（重要，环境坑）：** 必须从**仓库根** `/mnt/b/workdir/github/lovdex` 运行：
```bash
TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test web/src/components/settings/providerProfiles.test.ts
```
全局导出的 `TSX_TSCONFIG_PATH` 指向 `server/tsconfig.json`，在 web/ 下直接 `npx tsx` 会报 `Cannot resolve tsconfig at path: .../web/server/tsconfig.json`。typecheck 用 `cd web && npx tsc --noEmit -p tsconfig.json`（当前基线 exit=0）。

**规格文档：** `docs/superpowers/specs/2026-10-12-dsh-settings-and-sidebar-expand-design.md`

**提交信息约定：** commit message 用英文、**不加** Co-Authored-By: Claude 署名行。

---

### Task 1: providerProfiles 加宽 dsh（纯逻辑 + 测试）

**Files:**
- Modify: `web/src/components/settings/providerProfiles.ts`
- Test: `web/src/components/settings/providerProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `web/src/components/settings/providerProfiles.test.ts` 里改两处已有用例并加一个新用例（对齐文件现有 node:test + assert/strict 风格）：

把 `readSelections fills every provider key` 用例的断言补上 dsh：

```typescript
test('readSelections fills every provider key', () => {
  assert.deepStrictEqual(readSelections({ activeProviderProfiles: { claude: 'p_a' } }), {
    claude: 'p_a',
    codex: '',
    opencode: '',
    qoder: '',
    dsh: '',
  });
  assert.deepStrictEqual(readSelections({}), { claude: '', codex: '', opencode: '', qoder: '', dsh: '' });
});
```

文件末尾追加新用例：

```typescript
test('FORM_FIELDS.dsh matches the backend PROFILE_FIELDS whitelist', () => {
  // 后端 provider-profiles.ts: PROFILE_FIELDS.dsh = ['baseUrl', 'apiKey']。
  // 前端必须 ⊆ 后端（多一个 = 存档时后端丢弃该字段，静默失能）。
  assert.deepStrictEqual(FORM_FIELDS.dsh, ['baseUrl', 'apiKey']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test web/src/components/settings/providerProfiles.test.ts`（从仓库根）
Expected: FAIL —— `readSelections fills every provider key` 报 deepStrictEqual 不匹配（缺 dsh 键）；`FORM_FIELDS.dsh` 用例报 `FORM_FIELDS.dsh` 为 undefined。

- [ ] **Step 3: 最小实现**

`web/src/components/settings/providerProfiles.ts` 三处改动：

1) `ProviderKey` 联合类型（约第 18 行）：

```typescript
export type ProviderKey = 'claude' | 'codex' | 'opencode' | 'qoder' | 'dsh';
```

2) `FORM_FIELDS`（约第 32-37 行）补 dsh 行：

```typescript
export const FORM_FIELDS: Record<ProviderKey, readonly string[]> = {
  claude: ['apiKey', 'baseUrl', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel', 'oneMillionModels'],
  codex: ['binPath', 'apiKey'],
  opencode: ['binPath'],
  qoder: ['personalAccessToken'],
  dsh: ['baseUrl', 'apiKey'],
};
```

3) `readSelections`（约第 51-59 行）补 dsh 键：

```typescript
export function readSelections(cfg: Record<string, unknown>): Record<ProviderKey, string> {
  const active = (cfg.activeProviderProfiles ?? {}) as Record<string, string>;
  return {
    claude: selectionFor(active, 'claude'),
    codex: selectionFor(active, 'codex'),
    opencode: selectionFor(active, 'opencode'),
    qoder: selectionFor(active, 'qoder'),
    dsh: selectionFor(active, 'dsh'),
  };
}
```

4) 更新文件头 `ProviderKey` 上方注释块（约第 10-17 行）——「后端还带 dsh（它今天在设置页没有凭据区块，是刻意不做）」已过时，改为：

```typescript
/**
 * 设置页**有配置档 UI** 的 provider。
 *
 * 与后端 `PROFILE_FIELDS` 同心圆（那边是"档里存什么"，这边是"表单看得见什么"）。
 * **给后端 PROFILE_FIELDS 加 provider 时，如果同时要给它 UI，必须一并加宽这个
 * 联合类型** —— 否则是静默失能（API 建的档前端看不见，activeProviderProfiles
 * 标记也没法从这里清）。
 */
```

- [ ] **Step 4: 运行测试确认通过**

Run: `TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test web/src/components/settings/providerProfiles.test.ts`
Expected: 全部 pass（9+1=10 个，0 fail）

- [ ] **Step 5: typecheck**

Run: `cd web && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0。此时 `ProviderSettingsPage.tsx` 的 `selections` 初始 state `{ claude: '', codex: '', opencode: '', qoder: '' }` 会因缺 dsh 键而**类型报错**——这是预期的（Task 2 修），如果 Step 5 因这个报错，直接把 Task 2 Step 1 的初始 state 补丁先打上再验（两任务可以在同一工作树上按序执行，此处只为确认没有其他类型回归）。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/settings/providerProfiles.ts web/src/components/settings/providerProfiles.test.ts
git commit -m "feat(settings): widen ProviderKey with dsh in profile helpers"
```

---

### Task 2: ProviderSettingsPage 新增 DeepSeek Section

**Files:**
- Modify: `web/src/components/settings/ProviderSettingsPage.tsx`

- [ ] **Step 1: 补 selections 初始 state**

`ProviderSettingsForm` 里（约第 212-214 行）：

```typescript
  const [selections, setSelections] = useState<Record<ProviderKey, string>>({
    claude: '', codex: '', opencode: '', qoder: '', dsh: '',
  });
```

- [ ] **Step 2: ProvidersConfig 类型加 dsh**

在 `qoder?: { personalAccessToken?: string };`（约第 50 行）之后加：

```typescript
  dsh?: { baseUrl?: string; apiKey?: string };
```

- [ ] **Step 3: 渲染层解构 dsh 配置**

在 `const qoder = draft?.providers?.qoder ?? {};`（约第 478 行）之后加：

```typescript
  const dsh = draft?.providers?.dsh ?? {};
```

- [ ] **Step 4: 新增 DeepSeek Section**

在 Qoder Section（`</Section>` 约 598 行）与 LLM Proxy Section（约 600 行 `<Section title="LLM Proxy...">`）之间插入（对齐既有 Section 的字段组件与文案）：

```tsx
      <Section
        title="DeepSeek"
        provider="dsh"
        headerExtra={selectorFor('dsh')}
      >
        <SecretField
          label="API Key (apiKey)"
          value={dsh.apiKey ?? ''}
          onChange={(v) => patchProvider('dsh', 'apiKey', v)}
          revealable={false}
        />
        <TextField
          label="Base URL (baseUrl)"
          value={dsh.baseUrl ?? ''}
          placeholder="留空 = 跟随 llm-proxy（推荐）；仅指向代理不代理的上游时填写"
          onChange={(v) => patchProvider('dsh', 'baseUrl', v)}
        />
        <p className="text-xs text-muted-foreground">
          apiKey 留空 = 继承 llm-proxy 的凭据（与 claude provider 同一把）。两个字段都只影响新会话。
        </p>
        <p className="text-xs text-muted-foreground">
          配置档由服务端保管密钥；切换后点保存生效，只影响新会话（运行中的会话沿用启动时的凭据）。
        </p>
      </Section>
```

注意：`Section` 的 `provider="dsh"` 会让右上角 `<AuthStatus provider="dsh" />` 自动拉 `GET /api/providers/dsh/auth/status`——该端点已存在（`dsh-auth.provider.ts`），无需后端改动。

- [ ] **Step 5: typecheck**

Run: `cd web && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0（`selectorFor`/`patchProvider`/`Section` 均已泛型化到 `ProviderKey`，加宽后自动覆盖 dsh）。

- [ ] **Step 6: 手工冒烟（live dev server 验证，用户环境已有）**

设置页打开 `http://172.26.13.41:<port>/settings?tab=providers`：确认 DeepSeek Section 出现在 Qoder 与 LLM Proxy 之间；AuthStatus 行显示「已认证/未认证/认证状态未知」之一；配置档下拉能新建 dsh 档。**如当前没有可用的 dev server，跳过此步并在完成报告里注明**——不做重启/拉起服务的操作（重启需用户逐次确认）。

- [ ] **Step 7: Commit**

```bash
git add web/src/components/settings/ProviderSettingsPage.tsx
git commit -m "feat(settings): DeepSeek credentials section with profile support"
```

---

### Task 3: 侧栏跳转展开（纯函数 + 副作用改造）

**Files:**
- Modify: `web/src/components/sidebar/utils/utils.ts`
- Modify: `web/src/components/sidebar/utils/utils.test.ts`
- Modify: `web/src/components/sidebar/hooks/useSidebarController.ts`

- [ ] **Step 1: 写失败测试**

在 `web/src/components/sidebar/utils/utils.test.ts` 末尾追加（对齐现有 node:test 风格；先在 import 里加 `shouldExpandOnSessionJump`）：

```typescript
test('shouldExpandOnSessionJump expands when the selected session moves across projects', () => {
  // 外部跳转（任务页/通知/URL 直开）：选中会话从 null 或别的项目变到 p2
  assert.equal(
    shouldExpandOnSessionJump({ prevProjectId: null, nextProjectId: 'p2' }),
    true,
  );
  assert.equal(
    shouldExpandOnSessionJump({ prevProjectId: 'p1', nextProjectId: 'p2' }),
    true,
  );
});

test('shouldExpandOnSessionJump does not expand for same-project or empty selection', () => {
  // 同项目内换会话（含侧栏点击）：不强制展开，尊重用户可能的手动收起
  assert.equal(
    shouldExpandOnSessionJump({ prevProjectId: 'p1', nextProjectId: 'p1' }),
    false,
  );
  // 没有选中会话（回到「新会话」页）
  assert.equal(
    shouldExpandOnSessionJump({ prevProjectId: 'p1', nextProjectId: null }),
    false,
  );
  assert.equal(
    shouldExpandOnSessionJump({ prevProjectId: null, nextProjectId: null }),
    false,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test web/src/components/sidebar/utils/utils.test.ts`（从仓库根）
Expected: FAIL —— import 报 `shouldExpandOnSessionJump` 不存在（或等价的模块导出错误）。

- [ ] **Step 3: 实现纯函数**

`web/src/components/sidebar/utils/utils.ts` 在 `shouldAutoExpandSelectedProject`（约第 72-96 行）之后加：

```typescript
/**
 * 「选中会话跨项目变化」是否要强制展开目标项目。
 *
 * 外部跳转（任务页「打开会话」/ 通知点击 / URL 直开 / restore-last-session）
 * 只改 URL，不经过侧栏点击链路——此时 owning 项目高亮了但会话列表常是收起的
 * （首挂守卫严格遵守持久化展开状态）。本判定让「会话换了、项目也换了」强制
 * 展开一次；「同项目内换会话」不展开（尊重用户手动收起）。
 */
export const shouldExpandOnSessionJump = ({
  prevProjectId,
  nextProjectId,
}: {
  prevProjectId: string | null;
  nextProjectId: string | null;
}): boolean => {
  if (!nextProjectId) {
    return false;
  }
  return prevProjectId !== nextProjectId;
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test web/src/components/sidebar/utils/utils.test.ts`
Expected: 全部 pass（原有用例 + 2 个新用例，0 fail）。

- [ ] **Step 5: 改造 useSidebarController 副作用**

`web/src/components/sidebar/hooks/useSidebarController.ts`：

1) import 增加（第 19 行 `shouldAutoExpandSelectedProject,` 之后）：

```typescript
  shouldExpandOnSessionJump,
```

2) 在既有自动展开 effect（约第 159-190 行）之后新增一个 effect（保留原有 effect 不动——它管「选中项目变化」的让位语义，新 effect 管「选中会话跨项目变化」的强制展开）：

```typescript
  // 跨项目跳转强制展开：外部入口（任务页/通知/URL 直开/restore-last-session）
  // 只改 URL 不经侧栏，owning 项目高亮但列表常是收起的。选中会话变化且归属
  // 项目变化时展开目标项目一次——不受首挂守卫限制（那是给「切回主页面恢复
  // 同一会话」的）。侧栏内点击不受影响：userToggledProjectRef 的让位只约束
  // 上面的 effect，而侧栏点击通常伴随同项目（不触发本 effect 的展开分支）。
  const lastSessionProjectRef = useRef<string | null>(null);
  useEffect(() => {
    const nextProjectId = _selectedSession?.__projectId ?? selectedProject?.projectId ?? null;
    const prevProjectId = lastSessionProjectRef.current;
    lastSessionProjectRef.current = nextProjectId;

    if (!shouldExpandOnSessionJump({ prevProjectId, nextProjectId })) {
      return;
    }

    setExpandedProjects((prev) => {
      if (prev.has(nextProjectId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(nextProjectId);
      return next;
    });
  }, [_selectedSession?.id, _selectedSession?.__projectId, selectedProject?.projectId]);
```

注意：`useSidebarController` 的入参里 `selectedSession` 已被解构重命名为 `_selectedSession`（约第 89 行），直接用这个名字。依赖数组用 `?.id`/`?.projectId` 字段级依赖（与上方既有 effect 的 `[selectedProject?.projectId]` 风格一致）。

**边界语义说明（写给实现者）：** `__projectId ?? selectedProject?.projectId` 的回退是主路径——URL 解析产出的 session 对象不带 `__projectId`（那是侧栏 `handleSessionClick` 才打的标记），所以外部跳转靠 `selectedProject.projectId` 对比。副作用：纯「切项目」操作（`handleProjectSelect` 会 `setSelectedSession(null)`）中 nextProjectId 变 null、不展开；紧接着 URL 恢复会话时 prev=null → 展开，正确。

- [ ] **Step 6: typecheck + 全量 web 测试**

Run:
```bash
cd web && npx tsc --noEmit -p tsconfig.json
```
Expected: exit 0

Run（从仓库根）:
```bash
TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test web/src/components/sidebar/utils/utils.test.ts web/src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx
```
Expected: 全部 pass（`SidebarProjectSessions.test.tsx` 是展开渲染的回归哨兵）。

- [ ] **Step 7: 手工验收（有 live dev server 时）**

按 spec 验收标准走四个场景：
1. 任务页「打开会话」→ owning 项目展开 + session 行高亮（primary 边框 + 左 accent 条）；
2. 侧栏手动收起某项目后同项目内点其他会话 → 不强制展开；
3. 从 /tasks 切回主页面（同一会话）→ 维持持久化展开状态；
4. 刷新带 sessionId 的 URL → 展开。
**没有可用 dev server 就跳过并在完成报告注明**；不做任何重启操作。

- [ ] **Step 8: Commit**

```bash
git add web/src/components/sidebar/utils/utils.ts web/src/components/sidebar/utils/utils.test.ts web/src/components/sidebar/hooks/useSidebarController.ts
git commit -m "feat(sidebar): auto-expand the owning project when jumping to a session"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec 第 1 部分（ProviderKey/FORM_FIELDS/readSelections/类型/Section/文案）→ Task 1+2；spec 第 2 部分（纯函数判定 + 副作用 + 回退路径）→ Task 3。测试映射：providerProfiles.test 两处、utils.test 新函数两用例、typecheck 两次。无缺口。
- **占位符**：无 TBD/「适当处理」类占位；每个代码步骤给了完整代码。
- **类型一致性**：`ProviderKey`（Task 1 定义）→ Task 2 的 `selections`/`patchProvider`/`selectorFor`/`Section provider` 全部走同一联合类型；`shouldExpandOnSessionJump`（Task 3 定义）签名与测试、副作用调用一致；`_selectedSession` 重命名与现有解构一致。
- **已知风险标注**：Task 1 Step 5 的 typecheck 可能因 Task 2 未做而报 selections 缺键——计划里已给处理办法（先打 Task 2 Step 1 补丁再验）。
