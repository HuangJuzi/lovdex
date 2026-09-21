# 定时任务：去掉优先级/标签 chip、加模型选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「新建/编辑定时任务」表单里的优先级、标签两个 chip 换成模型选择 chip，并让所选模型落库、在该定时任务触发时真正生效。

**Architecture:** 纯前端改动，后端链路（`scheduled_tasks.executor_model` 列 → scheduler create/update → dispatch → 建任务 → SDK）早就通了，只是 UI 从没发过这个字段。本次抽出 `useProviderModels` 共享 hook（拉取模型列表 + stale-response 守卫），供 `ScheduledTaskForm` 与 `CreateTaskDialog` 共用；选中值策略留在各调用方，因为两者需求不同。表单的 `ScheduledTaskDraft` 删 `priority`/`label`、加 `executorModel`。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind。测试是 `node:test` + `node:assert/strict`，组件用 `react-dom/server` 的 `renderToStaticMarkup` 做静态标记冒烟——**没有 DOM**，effect 与交互都不执行，所以所有逻辑都要抽成纯函数才能测。

**Spec:** `docs/superpowers/specs/2026-09-21-scheduled-task-model-chip-design.md`

---

## 环境准备（每个任务开始前都要做）

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH          # 全局 export 的 server/tsconfig.json 会让 npx tsx 读错配置
```

**基线数字（2026-09-21 实测，改动前）：**

| 检查 | 基线 |
|---|---|
| `npm run typecheck` | 0 个错误（web 侧是干净的） |
| `npx eslint src/components/tasks/ScheduledTaskForm.tsx` | **6 problems**（5 条 `react-refresh/only-export-components` + 1 条 `tailwindcss/classnames-order`） |
| `npx eslint src/components/tasks/CreateTaskDialog.tsx` | 6 problems |
| `npx eslint src/components/tasks/ScheduledTaskForm.test.tsx` | 3 problems |
| `npx eslint src/components/tasks/CreateTaskDialog.test.tsx` | 0 |

**读数字要看 eslint 的汇总行，别用 `grep -c` 数行** —— 末尾的「✖ N problems」和「0 errors and 1 warning potentially fixable」也含 `warning` 字样，会把 6 数成 8：

```bash
npx eslint <file> 2>&1 | grep -E '^✖'
```

**验收判据是「这几个文件的数字不增加」，不是「仓库总数为 0」** —— 仓库里有另一个 session 在并发改文件，总数每次跑都不一样。

**预期会多 1 条警告**：Task 3 给 `toDraft` 加 `export` 后，`ScheduledTaskForm.tsx` 会多一条 `react-refresh/only-export-components`（该规则对「文件同时导出组件和普通函数」报警，现有 5 条就是这么来的），所以 Task 3 之后是 **7**，这是预期的，不是回归。

**提交注意：** 工作区被两个 session 共用。提交一律用**单条原子命令带 pathspec**，别用 `git commit --amend`（HEAD 可能已经被对方移走了）：

```bash
git add <file> && git commit -m "<msg>" -- <file>
```

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/components/tasks/useProviderModels.ts` | 新建 | 拉取某引擎的模型列表（含 stale 守卫）+ 两个纯函数：`modelOptionsFor`（chip 选项）、`nextModelOnLoad`（首次加载后的选中值） |
| `web/src/components/tasks/useProviderModels.test.ts` | 新建 | 上面两个纯函数的单测 |
| `web/src/components/tasks/CreateTaskDialog.tsx` | 改 | 删掉内联的模型拉取（125-148 行、60/65 行 state），改用共享 hook。**对外行为不变** |
| `web/src/components/tasks/ScheduledTaskForm.tsx` | 改 | Draft 删 `priority`/`label`、加 `executorModel`；chip 行换成模型 chip；`toApiBody` 跟着改 |
| `web/src/components/tasks/ScheduledTaskForm.test.tsx` | 改 | 新增断言；fixture 的 DB 行形状不动 |

**不改**：后端任何文件、`web/src/types/app.ts`（`ScheduledTask` 仍带 `priority`/`label`，后端仍返回它们）、`TaskDetail.tsx`、`ConvertToTaskDialog.tsx`、`taskStatus.ts`。

---

## Task 1: `useProviderModels` —— 纯函数 + hook

**Files:**
- Create: `web/src/components/tasks/useProviderModels.ts`
- Test: `web/src/components/tasks/useProviderModels.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/useProviderModels.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { modelOptionsFor, nextModelOnLoad } from './useProviderModels';

const MODELS = [
  { value: 'default', label: '默认' },
  { value: 'opus', label: 'Opus' },
];

// ---- modelOptionsFor ----

test('modelOptionsFor falls back to a single 默认模型 entry when the list is empty', () => {
  assert.deepEqual(modelOptionsFor([], ''), [{ value: '', label: '默认模型' }]);
  // 列表为空时即便当前值非空也走兜底：没有可点的项，标一个「不在列表」没有意义。
  assert.deepEqual(modelOptionsFor([], 'opus'), [{ value: '', label: '默认模型' }]);
});

test('modelOptionsFor maps value/label when the current value is in the list', () => {
  assert.deepEqual(modelOptionsFor(MODELS, 'opus'), [
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor keeps a stale model as a labelled extra row', () => {
  assert.deepEqual(modelOptionsFor(MODELS, 'ghost'), [
    { value: 'ghost', label: 'ghost（不在当前引擎列表）' },
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor does not add an extra row for the empty (default) value', () => {
  assert.deepEqual(modelOptionsFor(MODELS, ''), [
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor falls back to value when a model has an empty label', () => {
  assert.deepEqual(modelOptionsFor([{ value: 'x', label: '' }], 'x'), [{ value: 'x', label: 'x' }]);
});

// ---- nextModelOnLoad ----

test('nextModelOnLoad picks the first model when creating', () => {
  assert.equal(nextModelOnLoad({ mode: 'create', engineSwitched: false, models: MODELS, current: '' }), 'default');
});

test('nextModelOnLoad falls back to the empty value when creating with no models', () => {
  assert.equal(nextModelOnLoad({ mode: 'create', engineSwitched: false, models: [], current: '' }), '');
});

test('nextModelOnLoad keeps the stored value when editing without an engine switch', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: false, models: MODELS, current: 'opus' }), 'opus');
});

test('nextModelOnLoad keeps NULL (empty) when editing without an engine switch', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: false, models: MODELS, current: '' }), '');
});

test('nextModelOnLoad resets to the first model when editing after an engine switch', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: true, models: MODELS, current: 'opus' }), 'default');
});

test('nextModelOnLoad resets to the empty value when editing after a switch to an engine with no models', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: true, models: [], current: 'opus' }), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/useProviderModels.test.ts
```

Expected: FAIL —— `Cannot find module './useProviderModels'`。

- [ ] **Step 3: 实现纯函数**

创建 `web/src/components/tasks/useProviderModels.ts`：

```ts
import { useEffect, useRef, useState } from 'react';

import type { ProviderModelOption, TaskEngine } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';

import type { ChipSelectOption } from './ChipSelect';

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: { models?: { OPTIONS?: ProviderModelOption[]; DEFAULT?: string } };
};

/**
 * 引擎模型列表拉取（含 stale-response 守卫），供定时任务表单与新建任务弹窗共用。
 *
 * `active === false` 时**不发请求**（弹窗关着就没必要拉）。引擎或 active 变化都会
 * 重新拉取；旧请求的结果若晚于新请求返回会被丢弃——没有这道守卫时，快速切换引擎
 * 会让先发的慢响应覆盖后发的快响应，芯片里显示的是上一个引擎的模型。
 *
 * 只负责「拉取」，**不管选中值**：两个调用方的选中策略不同（新建任务弹窗每次打开
 * 都重置到第一项，定时任务编辑老数据时要保持 NULL），把策略塞进来就需要一个回调
 * 参数，反而更绕。选中策略见 `nextModelOnLoad`，由调用方自己调。
 *
 * **调用方契约**：`loadedEngine` 是 `models` 的「适用引擎」，不是「当前引擎」。引擎
 * 切换后、新响应落地前，`models` 仍是**上一个引擎**的列表、`loadedEngine` 仍是上一个
 * 引擎名（不会清回 null）。所以消费 `models` 前必须先比对 `loadedEngine === engine`，
 * 否则会拿旧引擎的模型列表去渲染或设选中值，而且错得很安静。
 * 拉取失败时同样会把 `loadedEngine` 标成当前引擎，配合空列表兜底项使用。
 */
export function useProviderModels(
  engine: TaskEngine,
  active: boolean,
): { models: ProviderModelOption[]; loadedEngine: TaskEngine | null } {
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [loadedEngine, setLoadedEngine] = useState<TaskEngine | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    // 每次 effect run 都作废在途请求——**放在早退之前**，否则弹窗关闭时在途的
    // 那次响应仍持有有效 id，会在重新打开时先于新响应把旧列表写进 state。
    // 同 useTaskEngineAvailability。
    const requestId = ++requestRef.current;
    if (!active) return;
    authenticatedFetch(`/api/providers/${engine}/models`)
      .then(async (res) => {
        if (!res.ok) return [] as ProviderModelOption[];
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .catch((err) => {
        // 只给日志加守卫，**不要** early return：下面那个 .then 还要把 loadedEngine
        // 标上，失败路径也必须走到那里（否则调用方永远停在「加载中」）。
        if (requestRef.current === requestId) console.error(`load models for ${engine} failed`, err);
        return [] as ProviderModelOption[];
      })
      .then((list) => {
        if (requestRef.current !== requestId) return;
        setModels(list);
        // 失败也标记成「该引擎已加载」：否则调用方会永远停在「加载中」，
        // 而空列表本来就有「默认模型」兜底项可用。
        setLoadedEngine(engine);
      });
  }, [active, engine]);

  return { models, loadedEngine };
}

/**
 * 模型 chip 的选项。空列表兜底成一项「默认模型」（值为空串 = 不指定，跑 provider
 * 默认槽位）；当前值不在列表里时**前置**一项带标注的同值项——没有这一条，芯片会
 * 显示空白，用户随手一保存就把模型静默改成 NULL。
 */
export function modelOptionsFor(models: ProviderModelOption[], current: string): ChipSelectOption[] {
  if (models.length === 0) return [{ value: '', label: '默认模型' }];
  const mapped: ChipSelectOption[] = models.map((m) => ({ value: m.value, label: m.label || m.value }));
  if (!current || mapped.some((o) => o.value === current)) return mapped;
  return [{ value: current, label: `${current}（不在当前引擎列表）` }, ...mapped];
}

/**
 * 模型列表加载完成后该选中哪一项。
 *
 * 新建：总是第一项（与 CreateTaskDialog 一致，用户看到的就是实际会跑的模型）。
 * 编辑：保持库里的值——`''` 代表 NULL，即「跟随 provider 默认槽位」，一打开编辑就
 * 回填第一项会让「只是看一眼再保存」把老定时任务悄悄钉死到某个模型。
 * 但引擎被切过之后例外：旧模型不属于新引擎，只能取新引擎的第一项。
 */
export function nextModelOnLoad({
  mode,
  engineSwitched,
  models,
  current,
}: {
  mode: 'create' | 'edit';
  engineSwitched: boolean;
  models: ProviderModelOption[];
  current: string;
}): string {
  if (mode === 'edit' && !engineSwitched) return current;
  return models[0]?.value ?? '';
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/useProviderModels.test.ts
```

Expected: `# pass 11` / `# fail 0`。

- [ ] **Step 5: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck
```

Expected: 无输出（0 错误）。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/useProviderModels.ts web/src/components/tasks/useProviderModels.test.ts
git commit -m "feat(tasks): add useProviderModels hook and model option helpers" -- web/src/components/tasks/useProviderModels.ts web/src/components/tasks/useProviderModels.test.ts
```

---

## Task 2: `CreateTaskDialog` 迁移到共享 hook

行为必须**完全不变**（每次打开、每次切引擎都重置到第一项）。`CreateTaskDialog.test.tsx` 是这次重构的回归护栏。

**Files:**
- Modify: `web/src/components/tasks/CreateTaskDialog.tsx`

- [ ] **Step 1: 先记录回归基线**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/CreateTaskDialog.test.tsx
```

Expected: `# pass 3` / `# fail 0`。重构后必须仍是这个数字。

- [ ] **Step 2: 删掉内联的模型 state 与请求 ref**

`CreateTaskDialog.tsx` 里删这两行（60、65 行）：

```ts
  const [models, setModels] = useState<ProviderModelOption[]>([]);
```
```ts
  const modelsRequestRef = useRef(0);
```

`useRef` 仍然被 `submittingRef` 使用，**不要**从 import 里删掉。

- [ ] **Step 3: 删掉内联的拉取 effect**

删掉 `CreateTaskDialog.tsx:125-148` 整段（注释 `// 模型随引擎重载（沿用 TaskBoard 的 stale-response 守卫）。` 起、到 `}, [open, engine]);` 止）：

```ts
  // 模型随引擎重载（沿用 TaskBoard 的 stale-response 守卫）。
  useEffect(() => {
    if (!open) return;
    const requestId = modelsRequestRef.current + 1;
    modelsRequestRef.current = requestId;
    const eng = engine;
    authenticatedFetch(`/api/providers/${eng}/models`)
      .then(async (res) => {
        if (!res.ok) return [] as ProviderModelOption[];
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .then((list) => {
        if (modelsRequestRef.current !== requestId) return;
        setModels(list);
        setModel(list.length > 0 ? list[0].value : '');
      })
      .catch((err) => {
        if (modelsRequestRef.current !== requestId) return;
        console.error('load models for task create failed', err);
        setModels([]);
        setModel('');
      });
  }, [open, engine]);
```

替换为：

```ts
  const { models, loadedEngine } = useProviderModels(engine, open);

  // 列表到达后回到第一项：每次打开、每次切引擎都重置（与重构前的行为一致）。
  useEffect(() => {
    if (loadedEngine !== engine) return;
    setModel(models.length > 0 ? models[0].value : '');
  }, [loadedEngine, engine, models]);
```

- [ ] **Step 4: 删掉搬走的本地类型与 import**

删掉 `CreateTaskDialog.tsx:17-20` 的本地类型（已挪进 `useProviderModels.ts`）：

```ts
type ProviderModelsApiResponse = {
  success?: boolean;
  data?: { models?: { OPTIONS?: ProviderModelOption[]; DEFAULT?: string } };
};
```

第 8 行的 import 去掉 `ProviderModelOption`（`ProviderModelsApiResponse` 删掉后它在本文件已无引用）：

```ts
import type { Project, Task, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';
```

加一行新 import（放在 `ChipSelect` 那组的字母序位置）：

```ts
import { modelOptionsFor, useProviderModels } from './useProviderModels';
```

`authenticatedFetch` 仍被第 120 行附近的「加载项目列表」effect 使用，**保留** import。

- [ ] **Step 5: 换用共用的选项函数**

`CreateTaskDialog.tsx:230-232`：

```ts
  const modelOptions: ChipSelectOption[] = models.length === 0
    ? [{ value: '', label: '默认模型' }]
    : models.map((m) => ({ value: m.value, label: m.label || m.value }));
```

替换为：

```ts
  const modelOptions: ChipSelectOption[] = modelOptionsFor(models, model);
```

- [ ] **Step 6: 跑回归测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/CreateTaskDialog.test.tsx
```

Expected: `# pass 3` / `# fail 0`，与 Step 1 一致。

- [ ] **Step 7: typecheck 与 lint 核对**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck
npx eslint src/components/tasks/CreateTaskDialog.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck 无输出；eslint **6 problems**（与基线相同）。

若 typecheck 报 `ProviderModelOption is declared but never used`，说明第 8 行的 import 没删干净。

- [ ] **Step 8: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/CreateTaskDialog.tsx
git commit -m "refactor(tasks): share useProviderModels with CreateTaskDialog" -- web/src/components/tasks/CreateTaskDialog.tsx
```

---

## Task 3: `ScheduledTaskForm` 数据层 —— 去 priority/label，加 executorModel

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 写失败的测试**

在 `ScheduledTaskForm.test.tsx` 末尾追加（文件已 import `EMPTY_DRAFT`、`toApiBody`，需在顶部那行动态 import 里补上 `toDraft`）：

先把第 21 行改成：

```ts
const { ScheduledTaskForm, EMPTY_DRAFT, canSubmitScheduledTask, switchCronMode, toApiBody, toDraft, toProjectChipOptions } = await import('./ScheduledTaskForm');
```

再追加测试：

```ts
test('draft no longer carries priority or label', () => {
  assert.equal('priority' in EMPTY_DRAFT, false);
  assert.equal('label' in EMPTY_DRAFT, false);
  assert.equal(EMPTY_DRAFT.executorModel, '');
});

test('toApiBody carries executorModel and drops priority/label', () => {
  const body = toApiBody({ ...EMPTY_DRAFT, executorModel: 'opus' });
  assert.equal(body.executorModel, 'opus');
  assert.equal('priority' in body, false);
  assert.equal('label' in body, false);
});

test('toApiBody maps an empty executorModel to null (provider default slot)', () => {
  assert.equal(toApiBody({ ...EMPTY_DRAFT, executorModel: '' }).executorModel, null);
});

test('toDraft keeps a stored executor_model', () => {
  const d = toDraft(mkScheduledTask({ executor_model: 'opus' }) as never);
  assert.equal(d.executorModel, 'opus');
});

test('toDraft maps a NULL executor_model to the empty value', () => {
  const d = toDraft(mkScheduledTask({ executor_model: null }) as never);
  assert.equal(d.executorModel, '');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: FAIL —— `toDraft` 是 `undefined`（当前未 export），且 `EMPTY_DRAFT.executorModel` 断言失败。

- [ ] **Step 3: 改 Draft 类型与默认值**

`ScheduledTaskForm.tsx:32-54` 的类型里，把 `priority` / `label` 两行换成：

```ts
  executorProvider: TaskEngine;
  /** 空串 = 不指定，跑 provider 的默认模型槽位（后端见 null）。 */
  executorModel: string;
```

`EMPTY_DRAFT`（56-73 行）同样替换，`executorProvider: 'claude'` 之后：

```ts
  executorModel: '',
```

- [ ] **Step 4: 清理 import**

第 4 行去掉 `TaskLabel, TaskPriority`：

```ts
import type { ScheduledTask, ScheduledTaskScheduleType, TaskEngine } from '../../types/app';
```

删掉第 28 行整行（`LABEL_META` / `LABEL_ORDER` / `PRIORITY_META` / `PRIORITY_ORDER` 已无引用）：

```ts
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
```

- [ ] **Step 5: `toDraft` 导出并换字段**

第 145 行加 `export`：

```ts
export function toDraft(initial?: ScheduledTask | null): ScheduledTaskDraft {
```

把 `162-163` 行的 `priority: initial.priority,` / `label: initial.label,` 换成：

```ts
    executorModel: initial.executor_model ?? '',
```

- [ ] **Step 6: `toApiBody` 换字段**

`103-118` 行里，把 `priority: d.priority,`（110）与 `label: d.label,`（111）换成一行：

```ts
    executorModel: d.executorModel || null,
```

（放在 `executorProvider: d.executorProvider,` 之后。）

不改 `priority`/`label` 这两个后端列——因为 PATCH 的 keyMap 匹配不到它们，**已有行的原值会保留**，不会被打回默认值。

- [ ] **Step 7: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: `# fail 0`，总数 = 原有用例数 + 5。

- [ ] **Step 8: typecheck + lint**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck
npx eslint src/components/tasks/ScheduledTaskForm.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck 无输出；eslint **7 problems**（基线 6 + `toDraft` 加 `export` 引入的 1 条 `react-refresh` 警告，见「环境准备」的说明）。

- [ ] **Step 9: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(scheduled-tasks): carry executorModel in the draft, drop priority/label" -- web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
```

---

## Task 4: `ScheduledTaskForm` UI —— 模型 chip 与选中策略

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 写失败的测试**

在 `ScheduledTaskForm.test.tsx` 末尾追加：

```ts
test('drops the priority and label chips', () => {
  const html = renderWithOptions([]);
  assert.equal(html.includes('aria-label="优先级"'), false);
  assert.equal(html.includes('aria-label="标签"'), false);
});

test('renders a model chip', () => {
  const html = renderWithOptions([]);
  assert.ok(/<button[^>]*aria-label="模型"/.test(html), 'model chip must render');
});

// 引擎还不可用时（列表未到）模型 chip 置灰，但**必须仍在 DOM 里**，
// 否则用户看不到「这里有模型可选」，芯片行会随加载状态抖动。
test('model chip renders disabled before the model list arrives', () => {
  const html = renderWithOptions([]);
  const modelChip = /<button[^>]*aria-label="模型"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(modelChip.length > 0, 'model chip must render');
  assert.equal(modelChip.includes('disabled'), true);
});

// 兜底项：列表没到（或拉取失败）时显示「默认模型」，而不是空白芯片。
test('model chip shows the 默认模型 fallback before the list arrives', () => {
  const html = renderWithOptions([]);
  assert.ok(html.includes('默认模型'));
});
```

注意：`ScheduledTaskForm.tsx:91` 的**注释**里有「列表标签」四个字，但 `renderToStaticMarkup` 不输出源码注释，所以用 `aria-label` 精确匹配（上面就是这么写的），不要退化成裸的 `html.includes('标签')`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: FAIL —— 仍能找到 `aria-label="优先级"`，且找不到 `aria-label="模型"`。

- [ ] **Step 3: 接入 hook 与两个 ref**

在 `ScheduledTaskForm` 组件里，`const { isMobile } = useDeviceSettings(...)`（253 行）之后加：

```ts
  const { models, loadedEngine } = useProviderModels(draft.executorProvider, open);
  // 挂载时的引擎。表单每次打开都会因 ScheduledTasksPanel 的 key={formKey} 重新挂载
  // （见 ScheduledTasksPanel.tsx:29/32/90），所以这两个 ref 天然是「每次打开」的作用域。
  const initialEngineRef = useRef(draft.executorProvider);
  const modelPickedRef = useRef(false);
```

- [ ] **Step 4: 加选中值策略 effect**

放在已有的「引擎可用性结算后纠正引擎」那个 effect（267-273 行）**之后**：

```ts
  // 模型列表到达后决定选中哪一项。策略在 nextModelOnLoad 里，这里只负责调用时机：
  //   - loadedEngine !== 当前引擎 → 列表还没跟上，等；
  //   - 用户手动选过且没切引擎 → 不覆盖他的选择；
  //   - 自动纠正引擎（上面那个 effect）也算「切过」——engineSwitched 为真，模型跟着重置。
  useEffect(() => {
    if (loadedEngine !== draft.executorProvider) return;
    const engineSwitched = loadedEngine !== initialEngineRef.current;
    if (modelPickedRef.current && !engineSwitched) return;
    const next = nextModelOnLoad({
      mode: initial ? 'edit' : 'create',
      engineSwitched,
      models,
      current: draft.executorModel,
    });
    if (next !== draft.executorModel) set('executorModel', next);
  }, [loadedEngine, models, draft.executorProvider, draft.executorModel, initial]);
```

加 import：

```ts
import { modelOptionsFor, nextModelOnLoad, useProviderModels } from './useProviderModels';
```

- [ ] **Step 5: 换掉 chip**

`ScheduledTaskForm.tsx:363-378` 的优先级 chip 与标签 chip 整段删掉，原地换成：

```tsx
              <ChipSelect
                ariaLabel="模型"
                label="模型"
                options={modelOptionsFor(models, draft.executorModel)}
                value={draft.executorModel}
                disabled={models.length === 0}
                isMobile={isMobile}
                onChange={(v) => {
                  modelPickedRef.current = true;
                  set('executorModel', v);
                }}
              />
```

同时删掉 `310-311` 行的 `priorityOptions` / `labelOptions` 两个常量（已无引用）。

- [ ] **Step 6: 引擎 chip 切换时清掉「用户已选」标记**

`354-362` 行的引擎 chip，`onChange` 里加一句：

```tsx
                onChange={(v) => {
                  modelPickedRef.current = false;
                  set('executorProvider', v as TaskEngine);
                }}
```

漏了这一步的症状：用户选了 Opus → 切到 codex → 模型仍是 Opus（而 Opus 不属于 codex），要等用户再手动改一次。

- [ ] **Step 7: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: `# fail 0`。

- [ ] **Step 8: typecheck + lint + 全量回归**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck
npx eslint src/components/tasks/ScheduledTaskForm.tsx 2>&1 | grep -E '^✖'
npx tsx --test src/components/tasks/CreateTaskDialog.test.tsx
npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

Expected: typecheck 无输出；eslint 仍是 **7 problems**；两个回归测试文件 `# fail 0`。

- [ ] **Step 9: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(scheduled-tasks): replace priority/label chips with a model picker" -- web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
```

---

## Task 5: 浏览器手工验收

自动化测试跑不了 effect 与交互（无 DOM），所以这一节是**唯一**能验证真实行为的地方。**不要**用整页截图当证据（截图读图会编造内容），要读 DOM 状态和数据库。

**Files:** 无（只读验证）

- [ ] **Step 1: 确认服务在跑**

```bash
ss -ltnp | grep -E ':5188|:3188'
```

Expected: 两个端口都在监听。若没有，**先问用户**再重启（重启后端需要用户逐次许可）。

- [ ] **Step 2: 记录当前定时任务表**

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT schedule_id, title, executor_provider, executor_model, priority, label FROM scheduled_tasks LIMIT 10;"
```

记下几条 `executor_model` 为空的**老**任务，Step 4 要用。

- [ ] **Step 3: 新建一条定时任务，验证模型落库**

在浏览器（`http://<本机 IP>:5188`，不要用 localhost）打开任务页 → 切到定时任务视图 → 新建：
1. 确认 chip 行是「名称 / 项目 / 引擎 / 模型」，**没有**优先级和标签。
2. 模型 chip 显示的是当前引擎的**第一个**模型（不是「默认模型」）。
3. 选一个非第一项的模型（例如 Opus），保存。

然后查库：

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT schedule_id, executor_provider, executor_model, priority, label FROM scheduled_tasks ORDER BY created_at DESC LIMIT 1;"
```

Expected: `executor_model` = 刚才选的模型名；`priority` = `P2`、`label` = `other`（后端默认值兜底）。

- [ ] **Step 4: 编辑一条老任务，验证 NULL 不被回填**

编辑 Step 2 记下的那条 `executor_model` 为空的定时任务：确认模型 chip 显示「默认模型」，**不做任何修改**直接保存。再查库：

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT schedule_id, executor_model, priority, label FROM scheduled_tasks WHERE schedule_id = '<该 id>';"
```

Expected: `executor_model` 仍是 NULL，且 `priority`/`label` 保持原值（若原来不是 P2/other，也没被改掉）。

- [ ] **Step 5: 验证切引擎会重置模型**

编辑任意一条定时任务 → 把引擎从 claude 切成别的 → 模型 chip 应跳到新引擎的第一个模型。

- [ ] **Step 6: 验证「Lovdex 助手」项目下模型仍可点**

新建定时任务 → 项目选「Lovdex 助手」→ 模型 chip **不应该**置灰（这与「新建任务」弹窗的行为**不同**，是有意为之）。

- [ ] **Step 7: 验证模型真的生效**

对 Step 3 建的那条任务点「立即运行」，然后确认派发出的任务带着模型：

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT task_id, executor_model FROM tasks ORDER BY created_at DESC LIMIT 1;"
```

Expected: `executor_model` = 定时任务上存的模型名，不是 NULL。

- [ ] **Step 8: 记录验证结果**

把每一步的实际输出贴进对话，**失败就如实说失败**，别用「应该没问题」代替。

---

## 覆盖检查（对照 spec）

| spec 章节 | 落在哪个 Task |
|---|---|
| §1 共享 hook + 纯函数 | Task 1 |
| §1 `CreateTaskDialog` 改用 hook | Task 2 |
| §2.1 Draft 类型与默认值 | Task 3 Step 3-5 |
| §2.2 选中值策略（含自动纠正引擎） | Task 4 Step 3-4、Step 6 |
| §2.3 模型 chip | Task 4 Step 5 |
| §2.3 助手项目也允许选模型 | Task 4 Step 5（不加 `isAssistant` 判断即达成）；Task 5 Step 6 验收 |
| §2.4 `toApiBody` | Task 3 Step 6 |
| §3 边界：模型不在列表 / 拉取失败 / 老数据 NULL / 切引擎 | Task 1（纯函数）、Task 5 Step 4-5 |
| §4 明确不改的部分 | 全计划无后端改动；Task 3 Step 6 保留 priority/label 列 |
| §5 测试与验收 | 每个 Task 的测试步骤 + Task 5 |

## 与 spec 的两处偏差（有意为之，执行时按本计划走）

1. **`ScheduledTaskForm.test.tsx` 的 fixture 不动。** spec §5 说「fixture 去掉 `priority`」，但 `mkScheduledTask`（`ScheduledTaskForm.test.tsx:39-47`）建模的是**数据库行**，而 `scheduled_tasks.priority` / `label` 两列本次保留、后端仍会返回。删掉 fixture 里的字段反而让 fixture 不再反映真实响应形状。真正要断言的是 `EMPTY_DRAFT` 和 `toApiBody` 里没有它们——Task 3 Step 1 已经覆盖。

2. **`toDraft` 的断言方式。** spec §5 只说要测 `toDraft`，本计划额外要求给它加 `export`（Task 3 Step 5）。代价是多一条 `react-refresh` 警告（见「环境准备」），这是无 DOM 环境下唯一能测到「老数据 NULL → `''`」的办法。

## 已知不做的事（避免执行时顺手扩大范围）

- `update_scheduled_task` 助手工具（`operator.tools.ts:529-552`）的 schema 里**没有** `executorModel`——这是个独立缺口，本次不补。
- 定时任务列表/卡片**不展示**模型，只改表单。
- 后端 `priority` / `label` 列不删，`scheduler.service.ts:113-114`、`168` 不动。
- `TaskDetail.tsx` / `ConvertToTaskDialog.tsx` 的模型选择不动（原生 `<select>`、含显式「默认模型 (default)」项，语义不同）。
