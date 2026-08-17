# 转为任务弹窗补充字段 — Design

> Date: 2026-08-13
> 仓库：`lovdex-cli`（前端改动）；后端零改动。
> 关联：`docs/superpowers/plans/2026-08-10-session-to-task-convert.md`（本功能最初落地）。

## 背景

「转为任务」弹窗（`ConvertToTaskDialog.tsx`）目前只有 4 个字段：**标题 / 描述 / 执行引擎 / 状态**。但 Task 模型还支持更多元数据（优先级、标签、截止时间、备注），后端 `POST /api/tasks` 已接受这些字段，任务详情页（`TaskDetail.tsx`）也能编辑——唯独转换弹窗没法在创建时填写。

需求：转换时补上 **优先级 / 标签 / 截止时间 / 备注** 四个可编辑字段。**执行引擎 / 执行模型** 都由会话决定（provider / 当前模型），不做成可编辑字段，创建任务时静默带上（延续会话配置，不退回默认）。

## 目标

- 转换弹窗新增 4 个可编辑字段：优先级、标签、截止时间、备注。
- 创建任务时静默写入 `executor_provider = 会话 provider`、`executor_model = 会话当前 provider 的已存模型`（弹窗均不显示）。
- 后端不改；字段默认值与 `TaskDetail` 一致。

## 设计

### 1. `convertToTaskPayload.ts`（纯函数模块）

`SessionToTaskPayload` 新增 5 个字段（4 个可编辑 + 1 个静默带出）：

| 字段 | 类型 | 默认值 | 弹窗显示 | 说明 |
|---|---|---|---|---|
| `priority` | `TaskPriority` | `'P2'` | ✅ | 与 TaskDetail 默认一致 |
| `label` | `TaskLabel` | `'other'` | ✅ | 与 TaskDetail 默认一致 |
| `deadline` | `string` | `''` | ✅ | 空 = 无截止 |
| `remark` | `string` | `''` | ✅ | 空 = 无备注 |
| `executorModel` | `string` | `resolveProviderModelDefault(session.provider)` | ❌ | 静默带出 |

模块内新增本地小助手（与现有 `isTaskEngine` 同风格，保持模块自包含，不牵连 `useChatProviderState.ts`）：

```ts
const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
  sophcode: 'opencode/deepseek-v4-flash-free',
};

function resolveProviderModelDefault(provider: LLMProvider | undefined | null): string {
  if (!provider) return '';
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(`${provider}-model`);
  return stored || FALLBACK_DEFAULT_MODEL[provider] || '';
}
```

> 说明：`localStorage` 用 `typeof` 判空，保证 `node:test`（无 jsdom）环境下可单测。

### 2. `ConvertToTaskDialog.tsx`

新增 4 个状态 + 表单控件，轻量分组布局（`max-w-lg` 不变）。**执行引擎/执行模型不渲染**，随会话静默带出：

```
基本信息   标题[input] / 描述[textarea]
元数据     状态[select] | 优先级[select]
           标签[select] | 截止时间[date input]
           备注[input]
```

- `优先级` select 用 `PRIORITY_ORDER` / `PRIORITY_META`（复用 `taskStatus.ts`）。
- `标签` select 用 `LABEL_ORDER` / `LABEL_META`。
- `截止时间` 用 `<input type="date">`（后端约定 `YYYY-MM-DD`，与 TaskDetail 一致）。
- `备注` 用 `Input`。

`api.tasks.create` body 透传（`executorProvider` / `executorModel` 为静默值，来自 payload）：

```ts
{
  ...,
  executorProvider,                    // 静默，来自会话 provider
  executorModel: executorModel.trim() || null,   // 静默，来自会话当前模型
  priority,
  label,
  deadline: deadline || null,          // 空 → null
  remark: remark.trim() || null,       // 空 → null
}
```

### 3. 后端

**零改动。** `POST /api/tasks` 已支持 `priority / label / deadline / remark / executorModel` 校验与落库。

### 4. 错误处理

不变。现有 409 `SESSION_ALREADY_LINKED` 处理保留；新字段不引入新错误路径（优先级/标签由 select 约束，后端本就校验）。

### 5. 测试

扩展 `convertToTaskPayload.test.ts`：

- 新字段默认值：`priority === 'P2'`、`label === 'other'`、`deadline === ''`、`remark === ''`。
- `executorModel` 解析：claude → `'default'`、codex → `'gpt-5.4'`、无 provider → `''`（`localStorage` 在 node:test 下为 undefined，走兜底）。

## 改动文件清单

**前端（lovdex-cli/）**
- 修改 `src/components/chat/view/subcomponents/convertToTaskPayload.ts` — 扩展类型 + 默认值 + 模型解析助手。
- 修改 `src/components/chat/view/subcomponents/convertToTaskPayload.test.ts` — 新增字段测试。
- 修改 `src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx` — 新增 4 个控件 + body 透传。

## 验证命令

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
npm run typecheck
npm run lint
```

## 验收标准

- [ ] 弹窗新增 优先级 / 标签 / 截止时间 / 备注，默认值 P2 / other / 空 / 空。
- [ ] 创建成功后在任务详情/看板能看到刚填的优先级、标签、截止、备注。
- [ ] 弹窗不出现「执行引擎」/「执行模型」字段，但创建的任务 `executor_provider` 等于会话 provider、`executor_model` 等于会话当前模型。
- [ ] 全部字段留空时创建不报错（转 `null` 落库）。
- [ ] 后端测试套件回归通过（未改动，仅确认无影响）。

## 非目标

- 不改后端接口与 schema。
- 不抽取 TaskDetail 与弹窗共享的元数据控件（留待将来有复用需求再做）。
- 不做两步向导。
