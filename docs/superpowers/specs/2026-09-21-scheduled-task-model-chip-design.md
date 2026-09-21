# 定时任务表单：去掉优先级/标签，加上模型选择 设计

日期：2026-09-21
状态：已确认，待写实现计划

## 0. 背景与目标

`ScheduledTaskForm.tsx` 的 chip 工具条（`345-378` 行）目前是：名称 / 项目 / 引擎 / 优先级 / 标签。本次改两件事：

1. **删掉优先级 chip（`363-370`）与标签 chip（`371-378`）**，连同 `ScheduledTaskDraft` 的 `priority` / `label` 字段和 `toApiBody` 里对应的两项。
2. **加上模型 chip**，位置在引擎 chip 之后。

为什么现在能做：后端链路**早就通了**，只差 UI 没接。

| 环节 | 位置 | 状态 |
|---|---|---|
| 表列 | `backend/server/modules/database/schema.ts:208` `executor_model TEXT` | 已有 |
| 建/改校验与映射 | `scheduler.service.ts:251`（create）、`291`（update keyMap `executorModel: 'executor_model'`） | 已有 |
| dispatch 透传 | `scheduler.service.ts:112` `executorModel: schedule.executor_model` | 已有 |
| 建任务落库 | `tasks.db.ts:110` → `tasks` 表 `executor_model`（`schema.ts:172`） | 已有 |
| 起运行时 | `backend/server/index.js:623` `model: task?.executor_model ?? null` → `headless-task-run.service.ts:107` → `claude-sdk.js:296` | 已有 |
| **UI 表单** | `ScheduledTaskForm.tsx` | **缺，本次补** |

所以经 UI 建的定时任务 `executor_model` 恒为 NULL，实际跑的是 `app.config.json` 里 `providers.<engine>.defaultModel`。本次改动**纯前端，后端零改动**。

删优先级是安全的：定时任务的展示层完全不读它 —— `ScheduledTasksView.tsx`（卡片 `55-76`、表格 `96-140`）、`SidebarScheduledEntry.tsx`、`utils/scheduleLabel.ts` 均无 `priority` 引用。后端 `priority` / `label` 列与 `'P2'` / `'other'` 默认值保留，老行数据不丢，`scheduler.service.ts:113-114` 的 dispatch 透传也不动。

## 1. 共享 hook + 纯函数

**新增 `web/src/components/tasks/useProviderModels.ts`**（与 `useTaskEngineAvailability.ts` 同目录 —— `tasks/` 下没有 hooks 子目录，跟随现有风格）。

```ts
export function useProviderModels(
  engine: TaskEngine,
  active: boolean,
): { models: ProviderModelOption[]; loadedEngine: TaskEngine | null }
```

- `active === false` 不发请求（弹窗关闭时不拉）。
- `engine` 或 `active` 变化时重新拉 `/api/providers/${engine}/models`，沿用 `CreateTaskDialog.tsx:126-128` 的 `requestId` stale-response 守卫，丢弃过期响应。
- 非 200 / 解析失败 / 网络错误 → `models = []`，`loadedEngine = engine`（仍标记已加载，让调用方走空列表兜底，而不是永远停在「加载中」）。

**hook 只负责拉取，不碰选中值。** 选中策略留在各调用方，因为两个场景本来就不同：新建任务弹窗每次打开都要重置到第一项，而定时任务编辑老数据时要保持 NULL。把策略塞进 hook 需要一个回调参数，反而更绕。

同文件导出两个纯函数（**web 测试是 `node:test` + `renderToStaticMarkup`，没有 DOM，effect 不跑**，策略必须抽成纯函数才可测 —— 见 `CreateTaskDialog.test.tsx:1-6`）：

```ts
export function modelOptionsFor(models: ProviderModelOption[], current: string): ChipSelectOption[]
export function nextModelOnLoad(input: {
  mode: 'create' | 'edit';
  engineSwitched: boolean;
  models: ProviderModelOption[];
  current: string;
}): string
```

`modelOptionsFor` 的规则 —— 顺序固定为 **`默认模型` → （可选）`不在当前引擎列表` → 引擎模型列表**：

- **「默认模型」（值 `''`）常驻第一项**，与 `models` 是否为空、`current` 是否为空无关。它是合法选择（跟随 provider 默认槽位），也是编辑老任务（`executor_model` 为 NULL）时**唯一能表达当前值的项**——`ChipSelect.tsx:55` 渲染的是 `current?.label ?? label`，列表非空时若没有值为 `''` 的项，芯片会退化成裸的「模型」二字。对齐 `TaskDetail.tsx:724` 的 `<option value="">默认模型 (default)</option>`。
- `models` 为空（还没加载 / 拉取失败）→ 只给这一项，不追加别的：没有「列表」可言，标「不在当前引擎列表」没有意义。
- `current` 非空且不在 `models` 里 → 在「默认模型」**之后**、列表**之前**插一项 `{ value: current, label: `${current}（不在当前引擎列表）` }`。对齐 `TaskDetail.tsx:725-727` 的既有做法。没有这一条，芯片会显示空白，用户随手一保存就把模型静默改成了 NULL。

> 这一条是 2026-09-21 修正的：spec 初稿把「默认模型」写成「仅列表为空时兜底」，那样在「列表非空 + `current === ''`」时无项可匹配，编辑 NULL 老任务会显示裸的「模型」二字，与本文档「NULL → 显示「默认模型」」的要求自相矛盾。缺陷由 Task 4 实现时发现。

`nextModelOnLoad` 的规则：

| mode | engineSwitched | 返回 |
|---|---|---|
| create | 任意 | `models[0]?.value ?? ''` |
| edit | false | `current`（保持库里值；NULL → `''` → 显示「默认模型」） |
| edit | true | `models[0]?.value ?? ''`（旧模型不属于新引擎） |

**`CreateTaskDialog.tsx` 改用这个 hook**，行为保持不变（每次打开、每次切引擎都重置到第一项），约减 20 行。`TaskDetail.tsx` / `ConvertToTaskDialog.tsx` 不动 —— 它们是原生 `<select>`、语义不同（含显式「默认模型 (default)」项），不在本次范围。

## 2. ScheduledTaskForm 改动

### 2.1 类型与默认值

```ts
export type ScheduledTaskDraft = {
  // ... 其余不变
  executorProvider: TaskEngine;
  executorModel: string;   // 新增
  // priority / label 删除
};
```

`EMPTY_DRAFT.executorModel = ''`。`toDraft()`（`145` 行起）把 `initial.executor_model ?? ''` 填进去，删掉 `priority` / `label` 两行（`162-163`）。

`''` 在语义上是「未指定 → 用 provider 默认槽位」，与后端 `executorModel: string ? value : null`（`scheduler.service.ts:251`）一致。

### 2.2 选中值策略的落地

组件内两个 ref：

```ts
const initialEngineRef = useRef(draft.executorProvider);  // 挂载时的引擎
const modelPickedRef = useRef(false);                      // 用户是否手动选过模型
```

两个 ref 的生命周期由调用方保证：`ScheduledTasksPanel.tsx:29/32` 每次 `openNew` / `openEdit` 都 `setFormKey(k => k + 1)`，表单上的 `key={formKey}`（`90` 行）让组件**每次打开都重新挂载**，`useState(() => toDraft(initial))` 与这两个 ref 一起重置。所以不需要额外的「open 时重置」逻辑。

模型列表加载完成后：

```ts
useEffect(() => {
  if (loadedEngine !== draft.executorProvider) return;      // 列表还没跟上当前引擎
  const engineSwitched = loadedEngine !== initialEngineRef.current;
  if (modelPickedRef.current && !engineSwitched) return;    // 用户选过，别覆盖
  const next = nextModelOnLoad({ mode: initial ? 'edit' : 'create', engineSwitched, models, current: draft.executorModel });
  if (next !== draft.executorModel) set('executorModel', next);
}, [loadedEngine, models, draft.executorProvider, draft.executorModel]);
```

- 引擎 chip 的 `onChange`（`361` 行）里置 `modelPickedRef.current = false`，让新引擎的第一项能覆盖旧模型。
- 模型 chip 的 `onChange` 里置 `modelPickedRef.current = true`。
- `engineSwitched` 也覆盖**自动纠正**的情况：`267-273` 行有一段「可用性结算后，若当前引擎不在可用列表里就自动切到 `options[0]`」。自动切换同样会让 `loadedEngine !== initialEngineRef.current` 成立，模型随之重置到新引擎第一项 —— 这是对的，旧模型本来就不属于新引擎。

### 2.3 chip 工具条

`344-378` 行的 chip 行改为：名称 / 项目 / 引擎 / **模型**。

```tsx
<ChipSelect
  ariaLabel="模型"
  label="模型"
  options={modelOptionsFor(models, draft.executorModel)}
  value={draft.executorModel}
  disabled={models.length === 0}
  isMobile={isMobile}
  onChange={(v) => { modelPickedRef.current = true; set('executorModel', v); }}
/>
```

`disabled={models.length === 0}` 是为了避免用户在「只有一个兜底项」时点开一个空弹层 —— 与引擎 chip 用 `engineAvailability.status !== 'ready'` 控制可点性（`359` 行）同构。

**助手项目（`is_operator`）与普通项目一视同仁**：模型可选、也写库。这与 `CreateTaskDialog.tsx:307-315`（助手模式下模型 chip 置灰、提交 `executorModel: null`）**不同**，是有意为之 —— 定时巡检/提醒类任务可以用便宜模型。`backend/server/index.js:623` 的 `startTaskRun` 对 operator 任务同样透传 `task.executor_model`，链路支持。

### 2.4 toApiBody

`103-118` 行：删 `priority`（`110`）、`label`（`111`），加 `executorModel: d.executorModel || null`。

因为不再发送这两个字段，`PATCH` 的 keyMap（`scheduler.service.ts:286-301`）不会命中它们，**已有行的 `priority` / `label` 原值保留**，不会被打回默认值。

## 3. 边界情况

| 情况 | 行为 |
|---|---|
| 库里的模型已从 provider 列表消失 | chip 保留原值并标注「不在当前引擎列表」，不静默变 NULL |
| 模型列表拉取失败 | 兜底「默认模型」空项，chip 置灰，提交 `null` |
| 编辑老任务（`executor_model` 为 NULL）、不碰引擎直接保存 | 仍存 NULL |
| 编辑时用户切了引擎 | 模型重置为新引擎第一项 |
| 用户手动选过模型后，同引擎列表重新加载 | 不覆盖用户的选择 |
| 引擎被 `267-273` 行的可用性逻辑自动纠正 | 同「用户切了引擎」 |
| 项目从普通项目切到「Lovdex 助手」 | 引擎可用性重算 → 可能触发自动切引擎 → 模型跟着重置；否则保持 |

## 4. 明确不改的部分

- **后端零改动**：`schema.ts:208`、`scheduler.service.ts:112/251/291`、`tasks.db.ts:110`、`index.js:623`、`headless-task-run.service.ts:107`、`claude-sdk.js:296` 全部已就绪。
- 后端 `priority` / `label` 列与默认值保留；`scheduler.service.ts:113-114`、`168`（补跑提醒任务硬编码 `'P2'`）不动。
- `TaskDetail.tsx` / `ConvertToTaskDialog.tsx` 的模型选择不动。
- 助手工具 `create_scheduled_task`（`operator.tools.ts:495` 已有 `executorModel`）与 `update_scheduled_task`（`529-552`，schema 里没有该字段）**本次不动** —— 后者缺 `executorModel` 是个独立的缺口，不顺手改，避免范围蔓延。
- 定时任务列表/卡片**不展示模型** —— 本次只改表单。

## 5. 测试与验收

web 测试跑 `node:test` + `renderToStaticMarkup`，无 DOM，effect 与交互都不执行。因此：

**新增 `web/src/components/tasks/useProviderModels.test.ts`** —— 纯函数全覆盖：
- `modelOptionsFor`：空列表只给兜底项；「默认模型」在列表非空时**也**常驻第一项（含 `current === ''`，这是编辑 NULL 老任务的显示路径）；`current` 在列表内；`current` 不在列表（在「默认模型」之后、列表之前插标注项）；空 label 回退成 value。
- `nextModelOnLoad`：create → 第一项；create + 空列表 → `''`；edit + 未切引擎 → 保持 `current`（含 `''`）；edit + 切了引擎 → 第一项。

**改 `web/src/components/tasks/ScheduledTaskForm.test.tsx`**：
- fixture（`47` 行附近）去掉 `priority`。
- 静态标记断言：渲染结果**不再出现**「优先级」「标签」，**出现**「模型」。
- `toApiBody`（`103` 行已 export）直接断言：产出含 `executorModel`，不含 `priority` / `label`；`executorModel: ''` → `null`。
- `toDraft`（`145` 行，**当前未 export，需补 `export`**）：编辑模式下 `executor_model` 为 NULL → `''`；有值 → 原值。

现有测试文件已经 stub 了 `document.body` 让 portal 能渲染（`ScheduledTaskForm.test.tsx:8-15`），静态标记断言在打开态下成立。

**回归护栏**：`CreateTaskDialog.test.tsx` 必须保持全绿（hook 抽取动到了它）。

**验收**：`npm run typecheck` 与 `npm run lint` 零新增（先跑一遍记下 baseline 数字，仓库 baseline 本就不干净）。

**手工验收**（浏览器 E2E，走 `:5188` → 后端 `:3188` 的 live dev server）：
1. 新建定时任务 → 模型 chip 显示当前引擎第一个模型；保存后 `scheduled_tasks.executor_model` 落库。
2. 编辑一个 `executor_model` 为 NULL 的老任务 → 显示「默认模型」，直接保存后仍为 NULL。
3. 编辑时切引擎 → 模型跳到新引擎第一项。
4. 项目选「Lovdex 助手」→ 模型 chip **仍可点**（与新建任务弹窗不同）。
