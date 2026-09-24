# 定时任务：项目选择器支持「Lovdex 助手」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「新建/编辑定时任务」的项目下拉里出现「🤖 Lovdex助手」，并在选中助手时把引擎/模型归一化成 claude + 默认模型、把两个 chip 置灰。

**Architecture:** 纯前端，两个文件。助手选项常量 `ASSISTANT_OPTION_VALUE` 本来就住在 `projectOptions.ts`（`CreateTaskDialog` 从那儿导入），本方案把「助手判据」和「项目 chip 选项映射」也放进同一个模块，成为**表单里项目相关纯映射的唯一出处**。表单据此渲染；`toApiBody` 据此归一化引擎/模型。后端链路早就通了（`project_path=NULL → is_operator=1 → 派发到助手工作区 → claude-sdk 的 operator 分支换封闭工具集`），本次不动后端。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind。测试是 `node:test` + `node:assert/strict`，组件用 `react-dom/server` 的 `renderToStaticMarkup` 做静态标记冒烟——**没有 DOM**，effect 与交互都不执行，所以所有逻辑都要抽成纯函数才能测。

**Spec:** `docs/superpowers/specs/2026-09-24-scheduled-task-assistant-target-design.md`

---

## 环境准备（每个任务开始前都要做）

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH          # 全局 export 的 server/tsconfig.json 会让 npx tsx 读错配置
```

**基线数字（2026-09-24 实测，改动前）：**

| 检查 | 基线 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 个错误（web 侧是干净的） |
| `npx eslint src/components/tasks/ScheduledTaskForm.tsx` | **6 problems**（0 errors, 6 warnings） |
| `npx eslint src/components/tasks/ScheduledTaskForm.test.tsx` | **1 problem**（0 errors, 1 warning） |
| `npx eslint src/components/tasks/projectOptions.ts` | **0 problems** |
| `npx eslint src/components/tasks/projectOptions.test.ts` | **0 problems** |
| `npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx` | **43 tests / 43 pass / 0 fail** |
| `npx tsx --test src/components/tasks/projectOptions.test.ts` | **9 tests / 9 pass / 0 fail** |

**读数字要看 eslint 的汇总行，别用 `grep -c` 数行** —— 末尾的「✖ N problems」和「0 errors and 1 warning potentially fixable」也含 `warning` 字样，会把 6 数成 8：

```bash
npx eslint <file> 2>&1 | grep -E '^✖'
```

**验收判据是「这几个文件的数字不增加」，不是「仓库总数为 0」** —— 仓库里有另一个 session 在并发改文件（当前工作区就有 `sessions.db.ts` / `operator.tools.ts` / `AnchorPopover.tsx` 等未提交改动），总数每次跑都不一样。

**预期数字变化（实测警告来源见下）**：`ScheduledTaskForm.tsx` 那 6 条**全是** `react-refresh/only-export-components`，分别落在 `EMPTY_DRAFT`(:59)、`canSubmitScheduledTask`(:88)、`toApiBody`(:106)、`toProjectChipOptions`(:133)、`toDraft`(:148)、`switchCronMode`(:190)。Task 2 删掉 `toProjectChipOptions` 会**少一条**（6 → 5），这是预期的，不是「变干净了」。

```bash
npx eslint src/components/tasks/ScheduledTaskForm.tsx 2>&1 | grep -E "warning|error"
```

`projectOptions.ts` 是纯 `.ts` 工具文件（零组件导出），不触发该规则——它现在导出 7 个非组件值仍是 0 警告，新增两个纯函数后**仍是 0**。

**并发会话警告**：另一个 session 正在改 `web/src/components/tasks/AnchorPopover.tsx`（本方案不碰）。`ChipSelect.tsx` 依赖 `AnchorPopover`，**本方案也不碰**——所有断言都基于现有 DOM 结构。

---

## 文件结构

| 文件 | 职责 | 本方案改动 |
|---|---|---|
| `web/src/components/tasks/projectOptions.ts` | 任务表单的项目候选/标签/选项的**纯函数**集合。调用方（`CreateTaskDialog` / `ScheduledTasksPage` / `ProjectMultiSelect` / `taskFilter`）都从这里取。 | 新增 `isAssistantTarget()` 与 `taskFormProjectChipOptions()` |
| `web/src/components/tasks/ScheduledTaskForm.tsx` | 定时任务表单：draft 状态、chip 工具条、`toApiBody` 请求体构造。 | 删本地 `toProjectChipOptions`、`toApiBody` 归一化、两个 chip 置灰、加提示行 |
| `web/src/components/tasks/ScheduledTaskForm.test.tsx` | 表单的静态渲染 + 纯函数断言。 | 新增 4 条断言 |
| `web/src/components/tasks/projectOptions.test.ts` | `projectOptions.ts` 的纯函数断言。 | 新增 4 条断言 |

**为什么把判据也放进 `projectOptions.ts`**：`ASSISTANT_OPTION_VALUE` 是「项目路径」这个字段的哨兵值，判断它、把它映射成选项，是同一件事的三个面，分开住就要反向 import。放一起还有两个好处：`ScheduledTaskForm.tsx` 不用再多导出一个纯函数（该文件的 `react-refresh/only-export-components` 警告已有 6 条，别再加），而 `projectOptions.test.ts` 是纯 node 环境、断言最省事。

---

### Task 1: `projectOptions.ts` 新增 `isAssistantTarget` 与 `taskFormProjectChipOptions`

**Files:**
- Modify: `web/src/components/tasks/projectOptions.ts`（import 块在第 1 行；新函数追加到文件末尾）
- Test: `web/src/components/tasks/projectOptions.test.ts`

- [ ] **Step 1: 写失败测试**

`projectOptions.test.ts` 的 import 行改为：

```ts
import { ASSISTANT_OPTION_VALUE, isAssistantTarget, projectPathOf, taskFormProjectChipOptions, taskFormProjects, taskProjectLabel, toProjectOption } from './projectOptions';
```

文件末尾追加：

```ts
test('isAssistantTarget: the sentinel and an empty path both mean the assistant', () => {
  // 与 CreateTaskDialog.tsx:64 的 isAssistant 判据逐字一致：哨兵值或空串。
  // 空串这一支不是多余的 —— 后端把助手目标的 project_path 存成 NULL，
  // toDraft 回填哨兵值，但任何一条漏了回填的路径传进来都是空串。
  assert.equal(isAssistantTarget(ASSISTANT_OPTION_VALUE), true);
  assert.equal(isAssistantTarget(''), true);
  assert.equal(isAssistantTarget('/p/app'), false);
});

test('taskFormProjectChipOptions: the assistant option comes first and is always present', () => {
  // 这是用户报告的那个 bug 的回归点：定时任务表单的项目 chip 里没有助手那一项，
  // 而 EMPTY_DRAFT.projectPath 默认就是助手哨兵值 —— chip 找不到匹配项，
  // 回退显示裸的「项目」二字，用户既看不出来、也切不回来。
  const options = taskFormProjectChipOptions([]);
  assert.deepEqual(options, [{ value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' }]);
});

test('taskFormProjectChipOptions: projects follow, with the remote host as a hint', () => {
  const options = taskFormProjectChipOptions([
    { value: '/r/app', label: 'MyApp', remoteHostId: 'h1', remoteHostName: 'dev-01' },
    { value: '/l/app', label: 'LocalApp' },
  ]);
  assert.equal(options[0].value, ASSISTANT_OPTION_VALUE);
  assert.deepEqual(options[1], { value: '/r/app', label: 'MyApp', hint: 'dev-01' });
  assert.deepEqual(options[2], { value: '/l/app', label: 'LocalApp', hint: undefined });
});

test('taskFormProjectChipOptions: the assistant value never collides with a real project path', () => {
  // 哨兵值一旦撞上真实路径，ChipSelect 的 current?.label 会选中错误项。
  // 断言它是「不像路径」的形态，而不是硬编码字面量（字面量在别处改过名字）。
  assert.ok(!ASSISTANT_OPTION_VALUE.startsWith('/'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/projectOptions.test.ts
```

Expected: FAIL —— `The requested module './projectOptions' does not provide an export named 'isAssistantTarget'`。

- [ ] **Step 3: 实现**

`projectOptions.ts` 第 1 行改为：

```ts
import type { Project } from '../../types/app';
import type { ChipSelectOption } from './ChipSelect';
import type { TaskProjectOption } from './TaskCard';
```

文件末尾追加：

```ts
/**
 * 该「项目路径」是否指向 Lovdex 助手（而非某个真实项目目录）。
 *
 * 判据与 `CreateTaskDialog.tsx:64` 逐字一致：哨兵值或空串。空串这一支是必要的
 * ——后端把助手目标的 `project_path` 存成 NULL，`toDraft` 会回填哨兵值，但任何
 * 漏了回填的路径传进来都是空串，两种写法都得当助手处理。
 *
 * 抽成纯函数是为了能在无 DOM 环境下直接断言：组件里两处消费（chip 置灰、提示行）
 * 依赖它，而静态渲染下两个 chip 本来就因「加载中」而 disabled，断言不出这个改动。
 */
export function isAssistantTarget(projectPath: string): boolean {
  return projectPath === ASSISTANT_OPTION_VALUE || !projectPath;
}

/**
 * 定时任务表单「项目」chip 的选项：助手选项**恒排第一**，其后是项目列表。
 *
 * 助手那一项不在 `projectOptions` 里 —— 调用方传进来的已经过 `taskFormProjects()`
 * 过滤（助手工作区被排除）。少了这一项，`EMPTY_DRAFT.projectPath` 的助手哨兵值
 * 就找不到匹配项，ChipSelect 会回退显示裸的「项目」二字：用户既看不出新建的表单
 * 其实指向助手，一旦选了别的项目也切不回来。
 *
 * 文案与排序对齐 `CreateTaskDialog.tsx:199` 的同名选项（🤖 前缀 + 置顶）。
 */
export function taskFormProjectChipOptions(projectOptions: TaskProjectOption[]): ChipSelectOption[] {
  return [
    { value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' },
    ...projectOptions.map((o) => ({
      value: o.value,
      label: o.label,
      hint: o.remoteHostName ?? undefined,
    })),
  ];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/projectOptions.test.ts
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/tasks/projectOptions.ts 2>&1 | grep -E '^✖'
```

Expected: `# tests 13 / # pass 13 / # fail 0`；typecheck 无输出；eslint `projectOptions.ts` **0 problems**（纯 `.ts` 工具文件，不触发 `react-refresh` 规则，新增纯函数不改变这个数字）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/projectOptions.ts web/src/components/tasks/projectOptions.test.ts
git commit -m "feat(scheduled-tasks): add the assistant option to the project chip options"
```

---

### Task 2: 表单改用新函数，删掉旧的 `toProjectChipOptions`

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx:27`（import）、`:129-139`（删函数）、`:359`（调用点）
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 更新既有测试**

`ScheduledTaskForm.test.tsx:25` 的解构里去掉 `toProjectChipOptions`：

```ts
const { ScheduledTaskForm, ScheduledTaskFormBody, EMPTY_DRAFT, canSubmitScheduledTask, switchCronMode, toApiBody, toDraft } = await import('./ScheduledTaskForm');
```

第 26 行补上新函数：

```ts
const { ASSISTANT_OPTION_VALUE, taskFormProjectChipOptions } = await import('./projectOptions');
```

`:102-110` 那条测试整体替换为（换名 + 补「助手项不在入参里也会出现」的断言）：

```ts
test('taskFormProjectChipOptions: the assistant option is prepended to the remote-aware project list', () => {
  const options = taskFormProjectChipOptions([
    { value: '/r/app', label: 'MyApp', remoteHostId: 'h1', remoteHostName: 'dev-01' },
    { value: '/l/app', label: 'LocalApp' },
  ]);
  // 入参里没有助手项（taskFormProjects 把它过滤掉了），但它必须出现在结果首位。
  assert.deepEqual(options[0], { value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' });
  assert.deepEqual(options[1], { value: '/r/app', label: 'MyApp', hint: 'dev-01' });
  assert.deepEqual(options[2], { value: '/l/app', label: 'LocalApp', hint: undefined });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: FAIL —— `The requested module './ScheduledTaskForm' does not provide an export named 'toProjectChipOptions'`。

- [ ] **Step 3: 实现**

`ScheduledTaskForm.tsx:27` 的 import 改为：

```ts
import { ASSISTANT_OPTION_VALUE, taskFormProjectChipOptions } from './projectOptions';
```

（`isAssistantTarget` 到 Task 4 才接进来，这里先不导 —— 本仓库 `tsconfig.json` 没开 `noUnusedLocals`、eslint 的 `no-unused-vars` 也是关的，未使用的 import **不会报错**，所以别指望工具拦住。）

删掉 `:129-139` 整块（`toProjectChipOptions` 及其 JSDoc 注释，从 `/**\n * 项目 chip 的选项` 到函数结束的 `}`）。

`:359` 的调用点改为：

```ts
  const projectChipOptions = taskFormProjectChipOptions(projectOptions);
```

**保留** `:29` 的 `import type { TaskProjectOption } from './TaskCard';` —— `ScheduledTaskFormBodyProps.projectOptions` 还在用它。

**本任务不动** `:62`、`:163`、`:292` 三处对 `ASSISTANT_OPTION_VALUE` 的引用，留给 Task 4 统一换成 `isAssistantTarget`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/tasks/ScheduledTaskForm.tsx 2>&1 | grep -E '^✖'
npx eslint src/components/tasks/ScheduledTaskForm.test.tsx 2>&1 | grep -E '^✖'
```

Expected: `# tests 43 / # pass 43 / # fail 0`；typecheck 无输出；表单 **5 problems**（删掉 `toProjectChipOptions` 少一条 `react-refresh` 警告，预期变化）、测试 **1 problem**（不变）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "refactor(scheduled-tasks): move the project chip options into projectOptions"
```

---

### Task 3: `toApiBody` 在助手模式下归一化引擎与模型

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx:100-121`（`toApiBody`）
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `ScheduledTaskForm.test.tsx` 里 `toApiBody: the assistant project is sent as a null projectPath` 那条之后追加：

```ts
test('toApiBody: the assistant target pins the engine to claude and drops the model', () => {
  // 后端对「isOperator 且 provider 非 claude」抛 INVALID_EXECUTOR 400
  // (tasks.service.ts:484-486)。派发路径上这个错误被 scheduler 的 tick catch
  // 吞掉，而 next_run_at 的推进写在那段 try/catch 之后 —— 于是任务每 15 秒重试
  // 一次、永远不执行，用户只看到「定时任务莫名其妙不跑」。
  const body = toApiBody({
    ...EMPTY_DRAFT,
    projectPath: ASSISTANT_OPTION_VALUE,
    executorProvider: 'qoder',
    executorModel: 'gpt-5',
  });
  assert.equal(body.executorProvider, 'claude');
  assert.equal(body.executorModel, null);
});

test('toApiBody: a real project keeps the picked engine and model', () => {
  // 归一化只作用于助手模式，别把普通项目的选择一起吞掉。
  const body = toApiBody({ ...EMPTY_DRAFT, projectPath: '/p/app', executorProvider: 'qoder', executorModel: 'gpt-5' });
  assert.equal(body.projectPath, '/p/app');
  assert.equal(body.executorProvider, 'qoder');
  assert.equal(body.executorModel, 'gpt-5');
});

test('toApiBody: an empty projectPath is treated as the assistant target', () => {
  const body = toApiBody({ ...EMPTY_DRAFT, projectPath: '', executorProvider: 'qoder' });
  assert.equal(body.projectPath, null);
  assert.equal(body.executorProvider, 'claude');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: FAIL —— `Expected values to be strictly equal: 'qoder' !== 'claude'`。

- [ ] **Step 3: 实现**

`toApiBody`（`:100-121`）整体改为：

```ts
/**
 * draft → POST/PATCH /api/scheduled-tasks 的请求体。
 *
 * `title` 原样透传，**不做任何本地兜底**：空串是「让后端用 LLM 从描述取名」的信号，
 * 前端一旦在这里填了名字，后端的取名分支就永远不会进入（同 CreateTaskDialog）。
 *
 * 助手目标（`isAssistantTarget`）的引擎/模型在这里**强制归一化**：后端对
 * 「isOperator 且 provider 非 claude」抛 INVALID_EXECUTOR 400
 * （tasks.service.ts:484-486），而派发路径上这个错误被 scheduler 的 tick catch
 * 吞掉、`next_run_at` 的推进又写在那段 try/catch 之后（scheduler.service.ts:186-193）
 * —— 不归一化的话，一个「助手 + qoder」的定时任务会每 15 秒静默重试一次、永不执行。
 * 放在出口而不是 UI 上：编辑老任务保存时同样生效，也不依赖用户有没有动过那两个 chip。
 */
export function toApiBody(d: ScheduledTaskDraft) {
  const isAssistant = isAssistantTarget(d.projectPath);
  return {
    title: d.title,
    description: d.description || null,
    projectPath: isAssistant ? null : d.projectPath,
    executorProvider: isAssistant ? 'claude' : d.executorProvider,
    executorModel: isAssistant ? null : d.executorModel || null,
    autoRun: d.autoRun ? 1 : 0,
    permissionMode: d.permissionMode,
    scheduleType: d.scheduleType,
    cronExpr: d.scheduleType === 'cron' ? resolveCronExpr(d) : null,
    intervalSeconds: d.scheduleType === 'interval' ? draftIntervalSeconds(d) : null,
    runAt: d.scheduleType === 'once' ? (d.runAt ? new Date(d.runAt).toISOString() : null) : null,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/tasks/ScheduledTaskForm.tsx 2>&1 | grep -E '^✖'
```

Expected: `# tests 46 / # pass 46 / # fail 0`；typecheck 无输出；eslint **5 problems**（不变）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "fix(scheduled-tasks): pin the assistant target to claude in the request body"
```

---

### Task 4: 助手模式下置灰引擎/模型 chip，并加提示行

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx:288-293`、`:385-408`（两个 chip）、`:428` 附近（提示行）
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

**为什么是置灰而不是「保持可点 + 提示」**：`CreateTaskDialog.tsx:284,293` 对助手模式是**禁用**两个 chip（`disabled={isAssistant || ...}` / `disabled={isAssistant}`），只留提示文案。spec 里写的「保持可点」与既有实现不符——本任务按既有实现对齐，两处入口的交互保持一致。

- [ ] **Step 1: 写失败测试**

在 `ScheduledTaskForm.test.tsx` 的 `engine chip is disabled while availability resolves (loading)` 之后追加：

```ts
test('the assistant target shows the fixed-engine hint', () => {
  // EMPTY_DRAFT.projectPath 默认就是助手哨兵值，静态渲染即可命中。
  const html = renderWithOptions([]);
  assert.ok(html.includes('🤖 Lovdex助手任务固定使用 Claude + 默认模型，以上引擎/模型设置将被忽略。'));
});

test('a real project does not show the fixed-engine hint', () => {
  // 反向断言走 `initial` 而不是「切项目」：renderWithOptions 的第二参是已有的
  // ScheduledTask，toDraft 会把它还原成 draft —— project_path 非空即普通项目，
  // 静态渲染也能构造出这个态（mkScheduledTask 就在本文件里）。
  const html = renderWithOptions([], mkScheduledTask({ project_path: '/p/app', is_operator: 0 }));
  assert.ok(!html.includes('🤖 Lovdex助手任务固定使用 Claude + 默认模型'));
});
```

**chip 置灰为什么不加测试**：`renderToStaticMarkup` 不执行 effect，引擎 chip 因 `engineAvailability.status === 'loading'`、模型 chip 因 `models.length === 0`，在**基线版本里就已是** `disabled=""`，断言它等于没测（既有那条 `engine chip is disabled while availability resolves (loading)` 恰好证明了这一点）。判据由 Task 1 的 `isAssistantTarget` 纯函数断言覆盖，接线（`disabled={isAssistant || ...}`）只做代码评审。**不要**为此引入 DOM 测试环境。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: FAIL —— `The expression evaluated to a falsy value` （提示行文案不在 HTML 里）。

- [ ] **Step 3: 实现**

`ScheduledTaskFormBody` 里，把 `:292` 那处内联判据换成共享纯函数（行为等价，去掉重复的三处 `=== ASSISTANT_OPTION_VALUE || !...` 写法）：

```ts
  const engineAvailability = useTaskEngineAvailability(
    selectedProjectOption
      ? { value: selectedProjectOption.value, remoteHostId: selectedProjectOption.remoteHostId ?? null }
      : null,
    isAssistantTarget(draft.projectPath),
  );
```

在 `const canSubmit = canSubmitScheduledTask(draft.description, submitting);`（`:360`）之前加：

```ts
  const isAssistant = isAssistantTarget(draft.projectPath);
```

引擎 chip（`:385-396`）的 `disabled` 改为：

```tsx
            disabled={isAssistant || engineAvailability.status !== 'ready'}
```

模型 chip（`:397-408`）的 `disabled` 改为：

```tsx
            disabled={isAssistant || models.length === 0}
```

在 `{engineHint && <p className="mt-2 text-xs text-muted-foreground">{engineHint}</p>}`（`:428`）之后、调度分组 `<div className="mt-3 flex flex-col gap-3 rounded-xl border border-border p-3">`（`:430`）之前插入：

```tsx
      {isAssistant && (
        <p className="mt-2 text-xs text-muted-foreground">🤖 Lovdex助手任务固定使用 Claude + 默认模型，以上引擎/模型设置将被忽略。</p>
      )}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
npx tsx --test src/components/tasks/projectOptions.test.ts
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/tasks/ScheduledTaskForm.tsx 2>&1 | grep -E '^✖'
npx eslint src/components/tasks/ScheduledTaskForm.test.tsx 2>&1 | grep -E '^✖'
```

Expected: 表单测试 `# tests 48 / # pass 48 / # fail 0`；`projectOptions.test.ts` `# tests 13 / # pass 13 / # fail 0`；typecheck 无输出；表单 **5 problems**、测试 **1 problem**（均不变）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(scheduled-tasks): disable the engine chips for the assistant target"
```

---

## 全量回归（全部任务完成后跑一次）

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npx tsc --noEmit -p tsconfig.json
for f in src/components/tasks/projectOptions.test.ts \
         src/components/tasks/ScheduledTaskForm.test.tsx \
         src/components/tasks/ScheduledTaskDetail.test.tsx \
         src/components/tasks/ScheduledTasksView.test.tsx \
         src/components/tasks/CreateTaskDialog.test.tsx; do
  echo "--- $f"; npx tsx --test "$f" 2>&1 | grep -E '^# (tests|pass|fail)'
done
```

Expected：typecheck 无输出；每个文件 `# fail 0`。**特别关注 `CreateTaskDialog.test.tsx`** —— Task 1 改了 `projectOptions.ts` 的 import 块，它是 `ASSISTANT_OPTION_VALUE` 的另一个消费方（`CreateTaskDialog.tsx:11`），必须仍然通过。

## 手工验证（可选，需要跑起前后端）

1. 打开「定时任务」页 → 新建定时任务 → 点「项目」chip：弹层首行是「🤖 Lovdex助手」。
2. 选中一个真实项目，再切回「🤖 Lovdex助手」：引擎/模型 chip 变灰，提示行出现。
3. 描述填「列出所有会话」→ 保存：列表「项目」列显示「🤖 Lovdex助手」（`projectLabel.ts:15`）。
4. 点「立即触发」→ 打开生成的会话：应当是助手会话（有 lovdex-operator 工具、无 Bash/Edit/Write）。

第 4 步是 spec 里记的**残留风险的验证点**：`claude-sdk.js:736` 的能力枚举里没有 `list_sessions` / `delete_session`，助手可能不知道自己能清理会话。若触发后什么都没发生，先查那里——**这不在本方案范围内**。

---

## 非目标（照 spec）

- 不改后端 `scheduled-tasks` 的 create/update 校验（API 直连仍可构造「助手 + 非 claude」的非法行，退化成上面描述的 15 秒静默重试，已知且接受）。
- 不改 operator 的 system prompt。
- 不做表单里的清理规则描述模板。
- 不做保留策略（TTL / 保留天数）、单轮删除上限、归档两阶段。
- 不碰 `AnchorPopover.tsx` / `ChipSelect.tsx`（另一个 session 正在改前者）。
