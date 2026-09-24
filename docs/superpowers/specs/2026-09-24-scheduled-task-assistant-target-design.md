# 定时任务：项目选择器支持「Lovdex 助手」 设计

日期：2026-09-24
状态：已设计（用户确认采用方案 A，待实现）

## 背景与问题

用户报告：**新建定时任务时，项目下拉里没有「Lovdex 助手」这一项**。

真实诉求：每天定时任务跑出来的会话太多（本机实测 654 个会话、近 14 天 2–81 个/天，其中 76 个来自定时任务 run；`~/.claude/projects` 下 1653 个 jsonl、871 MB），需要用 Lovdex 助手按定时任务去清理。

## 现状（探索结论）

### 1. 前端确实缺这一项，而且表现比「缺项」更隐蔽

- `CreateTaskDialog.tsx:199` 给项目下拉**前置**了 `{ value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' }`；
  `ScheduledTaskForm.tsx:359` 只做 `toProjectChipOptions(projectOptions)`，而 `projectOptions` 已经过 `taskFormProjects()`（`projectOptions.ts:13-22`，把助手工作区过滤掉了）——助手那一项**不在弹层里**。
- `EMPTY_DRAFT.projectPath` 的默认值就是 `ASSISTANT_OPTION_VALUE`（`ScheduledTaskForm.tsx:62`），`ChipSelect.tsx:55` 用 `current?.label ?? label` 兜底，找不到匹配项就显示回退文案「项目」。
- 净效果：新建弹窗其实**已经指向助手**，但用户看不到；而且一旦选了别的项目，就再也切不回来。

### 2. 后端早已支持「定时任务用助手执行」

链路是通的，不需要后端改动：

1. 保存时 `project_path` 为 NULL → `is_operator = 1`（`scheduled-tasks.db.ts:69`，`input.projectPath ? 0 : 1`）；
2. 派发时 `projectPath` 回退到助手工作区（`scheduler.service.ts:160`），并传 `isOperator: schedule.is_operator === 1`（`:172`）；
3. `startExecution` 用该 provider + `is_operator` 建会话（`tasks.service.ts:750`）；
4. headless run 走 `claude-sdk.js:706` 的 operator 分支：`tools: []` + 换上封闭的 `lovdex-operator` MCP 工具集（无 Bash/Edit/Write），cwd 固定为助手工作区。

### 3. 清理原语已就位

- `delete_session`（已提交 `14067a5`）：物理删 DB 行 + transcript 文件；守卫 = 拒绝助手会话、拒绝运行中/in_progress、挂任务时需 `cascade=true`。
- `delete_task`：物理删任务并连带其会话；运行中拒绝。
- `list_sessions`（**未提交，并发会话 WIP**）：只读枚举，支持 `lastActiveBefore` / `projectPath` / `isOperator` 等过滤。
- 启动时一次性清理：`cleanOperatorWorkspaceLegacySessions()`（`operator-cleanup.service.ts:23`），清助手工作区内 `is_operator=0` 的历史残留（仅服务启动时跑一次）。
- 列表与详情页的展示已经对：`projectLabel.ts:15` 对 `is_operator === 1` 或 `project_path` 为空统一渲染「🤖 Lovdex助手」（`ScheduledTasksView.tsx:168`、`ScheduledTaskDetail.tsx:77`）。

## 设计

纯前端改动，三处。

### 1. 新增 `taskFormProjectChipOptions`，助手选项置顶

`projectOptions.ts`（新函数，`TaskProjectOption` 与 `ChipSelectOption` 以 type-only import 引入）：

```ts
export function taskFormProjectChipOptions(projectOptions: TaskProjectOption[]): ChipSelectOption[] {
  return [
    { value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' },
    ...projectOptions.map((o) => ({ value: o.value, label: o.label, hint: o.remoteHostName ?? undefined })),
  ];
}
```

- 文案与排序照抄 `CreateTaskDialog.tsx:199`，两处入口的词汇保持一致。
- 放在 `projectOptions.ts` 而不是 `ScheduledTaskForm.tsx`：`ASSISTANT_OPTION_VALUE` 本来就住在这个模块，放一起才不用反向 import；且该模块是纯 `.ts` 工具文件，不触发 `react-refresh/only-export-components`（表单文件已有 6 条该警告）。
- 助手选项固定排第一，与 `ProjectMultiSelect.tsx:29` 的排序一致。
- 表单里原来的 `toProjectChipOptions` 随之删除，调用点改为 `taskFormProjectChipOptions(projectOptions)`。

### 2. `toApiBody` 在助手模式下归一化引擎与模型

`ScheduledTaskForm.tsx:106`：

```ts
const isAssistant = isAssistantTarget(d.projectPath);   // projectOptions.ts
// ...
projectPath: isAssistant ? null : d.projectPath,
executorProvider: isAssistant ? 'claude' : d.executorProvider,
executorModel: isAssistant ? null : d.executorModel || null,
```

**为什么必须做**：`tasks.service.ts:484-486` 对「`isOperator` 且 provider 非 claude」抛 `INVALID_EXECUTOR` 400。派发路径上这个错误被 `tick` 的 `catch` 吞掉（`scheduler.service.ts:204`），而 `next_run_at` 的推进写在这段 try/catch **之后**（`:186-193`）——于是任务每 15 秒重试一次、永远不执行，日志里只有一行 `[scheduler] tick dispatch failed`。用户视角是「定时任务莫名其妙不跑」。

写法照抄 `CreateTaskDialog.tsx:169-170`（同一处归一化，同一处语义）。
### 3. 助手模式下置灰引擎/模型 chip，并给一行提示

在 composer 工具条下方加一行说明文案，照 `CreateTaskDialog.tsx:337`：

> 🤖 Lovdex助手任务固定使用 Claude + 默认模型，以上引擎/模型设置将被忽略。

引擎与模型 chip 在助手模式下**置灰**（`disabled={isAssistant || …}`），对齐 `CreateTaskDialog.tsx:284,293` 的既有实现 —— 它同样禁用这两个 chip、只留提示文案。两处入口的交互保持一致，比 spec 初稿设想的「保持可点 + 提示」更贴合已有代码。

判据抽成 `isAssistantTarget(projectPath)` 放进 `projectOptions.ts`：`ScheduledTaskForm.tsx` 里 `toApiBody`、chip 的 `disabled`、提示行的条件、以及 `useTaskEngineAvailability` 的第三个实参共四处消费它，重复写四遍 `=== ASSISTANT_OPTION_VALUE || !…` 迟早会漂移。

## 数据流与错误处理

- 无后端改动，无新接口。
- 编辑已有助手定时任务：`toDraft` 已把 `project_path === null` 映射回 `ASSISTANT_OPTION_VALUE`（`ScheduledTaskForm.tsx:163`），无需改动；归一化在 `toApiBody` 里做，编辑保存同样生效。
- 引擎可用性探测已处理助手分支：`useTaskEngineAvailability(..., isAssistantTarget(draft.projectPath))`（`:288-293`）返回 `{ status: 'assistant' }`，两个 chip 因此保持基线已有的禁用态。

## 测试

`projectOptions.test.ts` 补四条、`ScheduledTaskForm.test.tsx` 补四条：

1. `isAssistantTarget`：哨兵值与空串都为真、真实路径为假。
2. `taskFormProjectChipOptions`：助手选项恒排第一（入参为空时也出现）；项目项原样保留（含远端 hint）；哨兵值不与真实路径形态冲突。
3. `toApiBody`：「助手 + `qoder` + 指定模型」→ `claude` + `null`；真实项目不被归一化；空串路径按助手处理。
4. 提示行的正反两向静态渲染断言（反向用 `mkScheduledTask({ project_path: '/p/app' })` 构造普通项目态）。

**chip 置灰不做静态渲染断言**：`renderToStaticMarkup` 不执行 effect，两个 chip 在基线版本里就因「加载中 / 模型列表为空」而已是 `disabled=""`，断言它等于没测。判据由 `isAssistantTarget` 覆盖，接线只做代码评审。

跑法：`cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `web/src/components/tasks/projectOptions.ts` | 新增 `isAssistantTarget`、`taskFormProjectChipOptions` |
| `web/src/components/tasks/ScheduledTaskForm.tsx` | 删 `toProjectChipOptions`、改调新函数；`toApiBody` 归一化引擎/模型；两个 chip 置灰；助手模式提示行 |
| `web/src/components/tasks/projectOptions.test.ts` | 新增四条断言 |
| `web/src/components/tasks/ScheduledTaskForm.test.tsx` | 新增四条断言（含一条改名替换） |

## 非目标

- 不改后端 `scheduled-tasks` 的 create/update 校验（UI 侧归一化后已构造不出非法行；API 直连仍可构造，见「残留风险」）。
- 不改 operator 的 system prompt。
- 不改 `ChipSelect.tsx` / `AnchorPopover.tsx`（后者的并发改动与本方案无关）。
- 不做表单里的清理规则描述模板。
- 不做保留策略（TTL / 保留天数）、不做单轮删除上限、不做归档两阶段 —— 用户明确选择「助手自主判断 + 不加额外护栏」，靠 `delete_session` 已有的三道守卫。

## 残留风险

**本次只解决「建得出来」，「删得掉」未经验证。**

`claude-sdk.js:736` 那份 operator 能力枚举（`list_tasks/get_task/.../send_notification 等`）里**没有** `list_sessions` / `delete_session` / `delete_task`；工具本身是注册进去的（该分支不传 `exclude`，与 `:1392` 的 verdict 路径不同），但模型未必意识到它们存在。同时 `list_sessions` 目前仍是并发会话未提交的 WIP，助手无法按「N 天未活动」筛选。

因此：建一条助手定时任务跑一次，如果助手没有删除任何会话，**第一个要看的就是这里** —— 要么把会话工具补进能力枚举，要么在定时任务描述里显式点名工具。

另：API 直连仍可创建「助手 + 非 claude」的定时任务，会退化成上面描述的 15 秒静默重试。本次不做后端校验，故保留。
