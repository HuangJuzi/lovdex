# 新建任务弹窗改版（Composer 输入框式 + 移动端适配 + 压缩方式）设计

日期：2026-09-16
状态：已确认，待写实现计划

## 0. 背景与目标

参考 sophclaw-client 已上线的「新建任务」方案 F（输入框式 Composer），把 lovdex web 现有的新建任务弹窗从「11 个字段竖排全展开」改成「大提示词输入框 + 底部芯片栏 + 更多弹层」的形态；同时补齐 web 移动端（<640px）适配；顺带补上 spec 2026-09-14 里定义过但未实现的「压缩方式」（摘要/原文）字段及其后端链路。

sophclaw 选定 F 的核心理由同样适用 lovdex：它不是发明新交互，而是把仓库已有、用户已长期使用的大输入框 + 底部小选项栏形态搬过来，学习成本为零。优先级/标签留在常显栏，因为它们决定列表里的彩色标签，选错要回列表才被发现。

## 1. 组件结构

**新建 `web/src/components/tasks/CreateTaskDialog.tsx`**，把现在内联在 `TaskBoard.tsx`（488–641 行）里的新建任务 `<Dialog>` 整体抽出。`TaskBoard` 保留 `creating` 状态，挂载：

```tsx
<CreateTaskDialog open={creating} onClose={closeCreateForm} onCreated={handleCreated} />
```

- `handleCreated`：关闭弹窗 + `refresh()` + 被当前筛选排除时设置 `hiddenCreated`（现有逻辑保留在 TaskBoard）。
- 表单状态（`newPrompt`/`newName`/`newProjectPath`/`newEngine`/`newPriority`/`newDeadline`/`newLabel`/`newRemark`/`newSourceSessionId`/`newModel` 等）随组件迁入 `CreateTaskDialog`。

**复用现有原语**（`web/src/shared/view/ui/`）：`Dialog`、`Input`、`Button`。

**新增 3 个小原语**（放 `web/src/components/tasks/`，不放进全局 ui，目前只有这里用）：

1. `AnchorPopover` — 底层定位层：`createPortal` + `position: fixed` + `getBoundingClientRect()` 算坐标。桌面 = 贴芯片的定位弹层；手机(<640) = 底部抽屉。处理外点关闭 / Esc / 滚动关闭。
   - **为什么必须 portal+fixed**：现有 `DialogContent` 带 `-translate-x/y-1/2` 变换 + `animate-dialog-content-show` 动画，普通 `absolute` 弹层会被裁剪或困在含变换的容器里（sophclaw 的 `task-chip-menu` 正是为此用 Teleport+fixed）。
2. `ChipSelect` — 基于 `AnchorPopover` 的单选列表弹层，用于 项目/标签/优先级/引擎/模型。
3. `ChipPanel` — 基于 `AnchorPopover` 的表单面板，用于「更多…」。

## 2. 字段映射与交互

```
┌ 新建任务（副标题：说清楚要做什么就行，其余都可以之后再补）┐
│  ┌────────────────────────────────────────────┐ │
│  │ [大提示词 textarea，autoFocus，桌面 min-h≈240px] │ │
│  │                                             │ │
│  │ 项目▾ 标签▾        优先级▾ 截止▾ 引擎▾ 模型▾ 更多…   ↑ │ ← 芯片栏(flex-wrap)
│  └────────────────────────────────────────────┘ │
│  提示文案（手机显示 Enter 创建 / 换行提示）   [重置]      │
└───────────────────────────────────────────────────┘
```

| 字段 | 位置 | 控件 | 默认 | 备注 |
|---|---|---|---|---|
| 提示词 | 主角 | textarea | 空 | `trim()` 非空才可提交；留空时 `↑` 禁用 |
| 项目 | 芯片 | ChipSelect | 列表第一项 | 含「🤖Lovdex助手」哨兵（`ASSISTANT_OPTION_VALUE`）+ 远端主机徽标；切换时清空上下文来源 |
| 标签 | 芯片 | ChipSelect | other | 决定列表彩色标签 |
| 优先级 | 芯片 | ChipSelect | P2 | 决定列表彩色标签 |
| 截止日期 | 芯片 | 原生 `input[type=date]` 包成胶囊 | 空 | 用原生日期选择器 |
| 引擎 | 芯片 | ChipSelect | claude | 按项目主机可用性禁用（`useTaskEngineAvailability`）；助手选中时锁死 |
| 模型 | 芯片 | ChipSelect | 该引擎首个 | 随引擎重载（stale 响应由 `modelsRequestRef` 守卫）；助手选中时锁死 |
| 更多… | 芯片 | ChipPanel | — | 右下对齐；有已填项时显示数量角标 |
| · 名称 | 更多内 | Input | 空 | 留空本地 `deriveTaskName` 提炼 |
| · 上下文来源 | 更多内 | ChipSelect | （无）白纸开始 | 选中后出现压缩方式 |
| · 压缩方式 | 更多内 | 摘要/原文 | 摘要 | **仅来源非「无」时出现**（新字段） |
| · 备注 | 更多内 | Input | 空 | |

- **助手锁定**：项目 = 🤖Lovdex助手 时，引擎/模型芯片置灰禁用，显示「固定使用 Claude + 默认模型」提示（复用现有 `isAssistant` 判断与 `ASSISTANT_OPTION_VALUE` 逻辑）。
- **提交**：`api.tasks.create` 多带 `contextMode`（来源空 = 不传，来源非空 = `summary`/`raw`）。成功后关窗 + 清空 + `refresh()`；被筛选排除 → 保留现有 `hiddenCreated` 提示条。失败 → 错误显示在表单内，不关窗、不丢输入。
- **重置**：底部左下角「重置」按钮恢复所有默认值。

## 3. 移动端适配（<640px）

沿用现有约定 `useDeviceSettings({ mobileBreakpoint: 640 })`（TaskBoard 已用）：

1. **芯片栏**：`flex-wrap` 自动换行；圆形 `↑` 保持右下角；胶囊高度 ≥36px（向 `.mobile-touch-target` 44px 靠拢）。
2. **「更多…」及所有 ChipSelect**：统一变**底部抽屉**（portal 全宽、从底部滑入、含 `env(safe-area-inset-bottom)`），不做小弹层——手机上小弹层易溢出/难点。
3. **弹窗本身**：`DialogContent` 手机上已近全宽（`max-w-lg`），继续用；副标题/提示文案保留但精简。
4. **日期**：原生 date input 手机走系统选择器，无需额外适配。

## 4. 数据模型

### 4.1 前端 `web/src/types/app.ts` 的 `Task`

新增 4 字段（`context_summary` 已存在）：

```ts
context_source_session_id: string | null;
context_mode: 'none' | 'summary' | 'raw';
context_status: 'pending' | 'ready' | 'failed' | null;
context_raw: string | null;
```

### 4.2 后端 `tasks` 表新增 4 列（`context_summary` 已有）

```
context_source_session_id TEXT
context_mode TEXT NOT NULL DEFAULT 'none' CHECK (context_mode IN ('none','summary','raw'))
context_status TEXT CHECK (context_status IS NULL OR context_status IN ('pending','ready','failed'))
context_raw TEXT
```

迁移：
- `schema.ts` 的 `TASKS_TABLE_SCHEMA_SQL` 加这 4 列（新库直接有）。
- `migrations.ts` 的 `migrateTasksTable` **末尾**用现有 `addColumnToTableIfNotExists`（幂等、重取 PRAGMA 快照）补老库。不碰那些 legacy 重建门的 INSERT 列清单——那些门只在极老库触发，重建成的新表自带这 4 列默认值，无需回填（历史本就没有 context 数据）。

## 5. 后端改动

1. **`shared/types.ts` `TaskRow`**：加 `context_source_session_id` / `context_mode` / `context_status` / `context_raw` 4 字段。
2. **`tasks.db.ts`**：
   - `createTask` 写入 `context_source_session_id` / `context_mode` / `context_status`（初始 `pending`，none 时为 NULL）。
   - 新增 `writeContextResult(taskId, { status, summary?, raw? })`，写 `context_status` + `context_summary`/`context_raw` + `updated_at`。
3. **`tasks.service.ts`**：
   - `CreateTaskInput`（57–77 行）加 `contextMode?: 'none' | 'summary' | 'raw'`。
   - `createTask` 校验：`contextMode` 非法 → `INVALID_CONTEXT_MODE` 400；`mode==='none'` → 忽略来源、5 个 context 列全 NULL；`mode!=='none'` → 来源必填（沿用现有来源存在性 + 项目归属校验）。
   - **向后兼容**：只传 `sourceSessionId` 不传 `contextMode` → 默认 `'summary'`（保持 ConvertToTaskDialog / 定时任务现有行为）。
   - `onContextSourceProvided`（127 行）回调签名加 `mode`：`(taskId, sourceSessionId, mode) => void`。
   - 新增 `setTaskContextResult(taskId, result)`（写列 + 广播 `task_upserted`），替换现有只写 summary 的 `setTaskContextSummary`（现有测试 892/904 行同步调整）。
4. **`task-context.service.ts`**：`runTaskContextCompression` 按 mode 分支——
   - 共用预处理 `compactTranscriptToText`；
   - `summary`：截 60000 字符 → LLM → `writeResult({ status:'ready', summary })`；
   - `raw`：截 `MAX_RAW_CHARS`(200k) → 不调 LLM → `writeResult({ status:'ready', raw })`；
   - 任一步失败 → `writeResult({ status:'failed' })`（不再静默吞掉，但仍 fire-and-forget、不阻塞建任务）。
   - 注入的 `writeBack` 改名为 `writeResult`，签名改为 `(taskId, result) => void`。
5. **`tasks.routes.ts`**：POST body 加 `contextMode` 透传。
6. **`index.js`**：`onContextSourceProvided`（471–484 行）透传 `mode`，`writeResult` 接到 `tasksService.setTaskContextResult`。

## 6. 错误处理 & 测试

- **错误处理**：后端压缩失败只置 `context_status='failed'` + 打日志，绝不影响任务创建（沿用 fire-and-forget + 吞错兜底）。前端提交失败在表单内显示错误、不关窗、不丢输入。
- **测试**：
  - 后端：`tasks.service.test.ts`（contextMode 校验 / 持久化 / 向后兼容默认 summary）、`task-context.service.test.ts`（raw 分支 + status 流转 + 失败写 failed）、`tasks.db` 的 `writeContextResult`。
  - 前端：`CreateTaskDialog.test.tsx`（芯片渲染、压缩方式仅来源非空时出现、助手锁死引擎/模型、mobile 底部抽屉分支）；现有 `TaskBoard` 相关测试随抽取调整。

## 7. 明确不做（YAGNI）

- 不做「上下文产物展示」（spec 2026-09-14 §7.2 的 badge/tooltip/详情弹层）——本次只产出入库，消费端另起需求。
- 不做 `context_status` 的轮询（spec §6.5 的 5s/15s/30s 兜底）——列表刷新已能带出最新状态。
- 不把 6 个芯片全做成逐字复刻 sophclaw 的自定义弹层动画；用统一的 `AnchorPopover` 一套机制覆盖所有芯片，避免重复实现。
