# 定时任务「间隔」颗粒度细化 + Cron 快捷模式 设计

日期：2026-09-18
状态：已确认，待写实现计划

## 0. 背景与目标

定时任务表单的「调度」区块有三种类型：单次 / 间隔 / Cron。后两种的可用性都很差：

- **间隔**：只有 4 个写死的预设（`INTERVAL_PRESETS`，`ScheduledTaskForm.tsx:80-85`：每小时 / 6 小时 / 每天 / 每周）。用户想要「每 30 分钟」「每 2 天」都做不到。
- **Cron**：一个裸的文本输入框，除了 placeholder `0 9 * * *` 没有任何提示（`ScheduledTaskForm.tsx` 的 cron 分支）。不知道 cron 语法的人写不出「每天 8 点」这种最常见的需求 —— 尽管列表侧 `cronLabel` 已经能把常见模式翻译成中文。

本次把两者都改成**常用模式可点、数值可调**：

1. 间隔 → 「数字框 + 单位 chip（秒/分钟/小时/天/星期）」，范围 1 分钟 ~ 365 天。
2. Cron → 「模式 chip（每天/每周/工作日/每月/自定义）+ 时间与星期/日期的条件控件」，认不出的表达式原样落到「自定义」。

**后端零改动**：`interval_seconds` 是任意数字、`cron_expr` 是任意字符串，`scheduler.service` 的 `computeNext` / `initialNextRun` 对二者都只做透传与算术，没有取值范围的校验。

## 1. 新增 `web/src/utils/interval.ts`

单一事实来源：有哪些单位、秒数 ↔ (数字, 单位) 怎么换算。

```ts
export type IntervalUnit = 'second' | 'minute' | 'hour' | 'day' | 'week';

export const INTERVAL_UNITS: { value: IntervalUnit; label: string; seconds: number }[] = [
  { value: 'second', label: '秒',   seconds: 1 },
  { value: 'minute', label: '分钟', seconds: 60 },
  { value: 'hour',   label: '小时', seconds: 3600 },
  { value: 'day',    label: '天',   seconds: 86400 },
  { value: 'week',   label: '星期', seconds: 604800 },
];

export const INTERVAL_MIN_SECONDS = 60;
export const INTERVAL_MAX_SECONDS = 365 * 86400;

/** 秒 → (数字, 单位)：取「能整除的最大单位」，保证 amount * unit === seconds 精确成立。 */
export function decomposeInterval(seconds: number): { amount: number; unit: IntervalUnit };

/** (数字, 单位) → 秒 */
export function intervalSecondsOf(amount: number, unit: IntervalUnit): number;

/** 单位 → 中文标签（从 INTERVAL_UNITS 派生，供 intervalLabel 复用，避免两份标签表）。 */
export function intervalUnitLabel(unit: IntervalUnit): string;
```

**为什么包含「秒」**：集合里有 1 秒这个单位，`decomposeInterval` 就是**全函数** —— 任何整数秒都能精确表示。否则遇到 90 秒这类值，要么显示成「2 分钟」（撒谎，用户会以为真的每 2 分钟触发），要么得引入「不可编辑」的特殊分支。

**分解举例**：`3600 → 1 小时`、`5400 → 90 分钟`、`86400 → 1 天`、`604800 → 1 星期`、`90 → 90 秒`、`60 → 1 分钟`。

**实现要点**：从大到小遍历单位，返回第一个 `seconds % unit.seconds === 0` 的。`'second'` 的 `seconds` 是 1，永远能整除，所以函数必定返回 —— 末尾的兜底 return 不可达，但保留以满足 TS 的返回类型检查。

**边界**：`decomposeInterval` 要求 `seconds` 是 ≥ 1 的有限数；非法输入的兜底由调用方（`toDraft`）负责，见 §3。

## 2. 新增 `web/src/utils/cronPreset.ts`

```ts
export type CronPresetMode = 'daily' | 'weekly' | 'weekday' | 'monthly';
export type CronMode = CronPresetMode | 'custom';

export type CronPreset = { mode: CronPresetMode; time: string; dow: string; dom: string };

/** 模式 chip 的选项（含 custom），供表单直接喂给 ChipSelect。 */
export const CRON_MODES: { value: CronMode; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'weekday', label: '工作日' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义' },
];

/** 星期几 chip 的选项；值直接就是 cron 的 dow 字段。 */
export const DOW_OPTIONS: { value: string; label: string }[]; // '0'~'6' → 周日~周六

/** 认不出来的表达式返回 null（调用方落到「自定义」）。 */
export function parseCronPreset(expr: string): CronPreset | null;

/** (模式, 参数) → cron 表达式。time 非法时返回空串。 */
export function buildCronPreset(preset: CronPreset): string;

/** 自定义模式用原始表达式，其余模式按参数拼。这是 cron 分支的唯一事实来源。 */
export function resolveCronExpr(draft: {
  cronMode: CronMode; cronExpr: string; cronTime: string; cronDow: string; cronDom: string;
}): string;
```

| 模式 | 生成的表达式 |
|---|---|
| `daily` | `M H * * *` |
| `weekly` | `M H * * D`（D = 0~6，0 是周日） |
| `weekday` | `M H * * 1-5` |
| `monthly` | `M H N * *`（N = 1~31） |

### `parseCronPreset` 的识别规则

按顺序：

1. 按空白切分，必须恰好 5 段；`min`/`hour` 必须是 1~2 位数字且分别 ≤ 59 / ≤ 23，否则返回 `null`。
2. `month` 必须是 `*`，否则 `null`。
3. `dom === '*' && dow === '*'` → `daily`
4. `dom === '*' && dow === '1-5'` → `weekday`
5. `dom === '*' && /^[0-6]$/.test(dow)` → `weekly`（`dow` 原样保留）
6. `/^\d{1,2}$/.test(dom) && 1 <= Number(dom) <= 31 && dow === '*'` → `monthly`（`dom` 原样保留）
7. 其余 → `null`

第 4 步必须在第 5 步之前：`'1-5'` 是三个字符，不会被 `/^[0-6]$/` 匹配，但显式排序能让意图更清楚。

`time` 统一归一化成 `HH:mm`（补零），这样回填到 `<input type="time">` 时格式正确。

**为什么「认不出就自定义」**：与间隔的精确分解同源 —— 能精确表示就结构化，不能就原样透传，**绝不改写用户的值**。用户通过 API 直调写入的 `0 9,17 * * *` 打开编辑时，会原样出现在自定义输入框里，保存后一个字符都不变。

## 3. `ScheduledTaskDraft` 换字段

```ts
// 改
intervalSeconds: string;   →   intervalAmount: string;    // 数字框里的值
                               intervalUnit: IntervalUnit; // 单位 chip
// 保留但收窄语义
cronExpr: string;          //   仅「自定义」模式使用
// 新增
cronMode: CronMode;
cronTime: string;          //   'HH:mm'
cronDow: string;           //   '0'~'6'
cronDom: string;           //   '1'~'31'
```

`EMPTY_DRAFT`：

```ts
intervalAmount: '1', intervalUnit: 'hour',      // 等价于原来的 3600
cronMode: 'daily', cronTime: '09:00', cronDow: '1', cronDom: '1', cronExpr: '',
```

（新建任务默认 cron 是「每天 09:00」= `0 9 * * *`，与原来输入框的 placeholder 一致。）

**为什么把 `cronExpr` 降级为「仅自定义模式」**：如果让它继续当唯一事实来源，UI 就必须「改时间 → 回写表达式」，而用户在自定义输入框里逐字敲 `0 9 * * *` 时，中途会被识别成 daily 模式、控件突然换掉。反过来让 `resolveCronExpr(draft)` 当唯一事实来源，就不存在双源同步问题。

### `toDraft(initial)` 的回填

```ts
// 间隔：非法值（null / NaN / < 1）兜底到 3600（1 小时）
const s = Number(initial.interval_seconds);
const safeSeconds = Number.isFinite(s) && s >= 1 ? s : 3600;
const { amount, unit } = decomposeInterval(safeSeconds);

// cron：认得出就结构化，认不出就自定义 + 原始表达式
const preset = parseCronPreset(initial.cron_expr ?? '');
```

`parseCronPreset` 返回 `null` 时：`cronMode: 'custom'`、`cronExpr: initial.cron_expr ?? ''`，其余预设字段用 `EMPTY_DRAFT` 的默认值（切回预设模式时有个合理的起点）。

### `toApiBody` 的改动

```ts
intervalSeconds: d.scheduleType === 'interval' ? intervalSecondsOf(Number(d.intervalAmount), d.intervalUnit) : null,
cronExpr: d.scheduleType === 'cron' ? resolveCronExpr(d) : null,
```

其余字段不变。`toApiBody` 仍然是纯函数、仍然对不匹配调度类型的字段发 `null`（后端 `update` 的校验已容忍 `null`，见 `222d79b`）。

## 4. 表单 UI（都在「调度」区块内）

### 间隔分支

`<Input type="number" min={1} step={1} className="h-9 w-24">` 数字框，紧跟一个 `ChipSelect`（选项来自 `INTERVAL_UNITS` 的 `label`）。**数字在前、单位在后**，符合「前面的数字也可以调」的诉求。

数字框不限死取值范围（选「秒」时填 30 也能输进去），越界走提交时的内联报错 —— 与 cron / 触发时间 / 既有间隔校验的风格一致。

### Cron 分支

`ChipSelect`（每天 / 每周 / 工作日 / 每月 / 自定义）+ 条件控件：

| 模式 | 条件控件 |
|---|---|
| 每天 | `<Input type="time">` |
| 每周 | 星期几 `ChipSelect`（周日~周六，值 `'0'`~`'6'`）+ 时间 |
| 工作日 | `<Input type="time">` |
| 每月 | 日期 `ChipSelect`（`1`~`31`）+ 时间 |
| 自定义 | 现有的裸表达式 `Input`（placeholder `0 9 * * *`） |

`<Input type="time">` 与 `once` 分支用的 `<Input type="datetime-local">` 同源，都是原生控件，不引入新的日期库。

### 校验

`submit()` 里两条：

```ts
// 间隔
const secs = intervalSecondsOf(Number(draft.intervalAmount), draft.intervalUnit);
if (draft.scheduleType === 'interval' && !(secs >= INTERVAL_MIN_SECONDS && secs <= INTERVAL_MAX_SECONDS)) {
  setLocalError('间隔需在 1 分钟到 365 天之间');
  return;
}
// cron
if (draft.scheduleType === 'cron' && !resolveCronExpr(draft).trim()) {
  setLocalError('请填写 cron 表达式');
  return;
}
```

`canSubmitScheduledTask` **不变** —— 仍然只卡「描述非空 + 非在途」，调度字段的缺失走提交时的内联报错（这是既有设计，见 `docs/superpowers/specs/2026-09-18-scheduled-task-form-unify-design.md` §3）。

## 5. 列表显示（`web/src/utils/scheduleLabel.ts`）

### `intervalLabel` 改用 `decomposeInterval`

```ts
export function intervalLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return `每 ${seconds} 秒`;
  const { amount, unit } = decomposeInterval(seconds);
  return `每 ${amount} ${intervalUnitLabel(unit)}`;
}
```

（标签从 `interval.ts` 的 `intervalUnitLabel` 取，不在这里再维护一份单位表。）

效果：与表单**永远一致**（604800 从「每 7 天」变成「每 1 周」）。

**副作用（有意为之）**：现在的实现是**四舍五入**的（`Math.round(seconds/60)`），会把 5401 秒显示成「每 90 分钟」—— 一个谎。改用精确分解后，这类非整除值会如实显示「每 5401 秒」。既有测试覆盖的 3600 / 21600 / 86400 / 1800 全部仍成立。

### `cronLabel` 补「工作日」分支

在 `/^[0-6]$/.test(dow)` 那条**之前**插入：

```ts
if (dom === '*' && month === '*' && dow === '1-5') return `工作日 ${hhmm}`;
```

否则 `0 9 * * 1-5` 会掉进最后的 `return expr` 原样显示（`scheduleLabel.test.ts` 现在正是这么断言的，该断言需同步更新）。

## 6. 测试计划

### 新模块单测

- `web/src/utils/interval.test.ts`
  - `decomposeInterval`：60 / 3600 / 5400 / 86400 / 604800 / 90 / 45 各自的分解结果
  - 精确性：对一组秒数断言 `intervalSecondsOf(decomposeInterval(s)) === s`（往返恒等）
  - `INTERVAL_MIN_SECONDS` / `INTERVAL_MAX_SECONDS` 的边界值恰好合法、越界一档不合法
- `web/src/utils/cronPreset.test.ts`
  - `parseCronPreset` 五种模式的识别（含 `0 8 * * *` → daily 08:00、`0 9 * * 1-5` → weekday、`30 6 * * 0` → weekly dow=0、`0 10 15 * *` → monthly dom=15）
  - 认不出的返回 `null`：`0 9,17 * * *`、`0 9 * * 1,3`、4 段/6 段、`99 9 * * *`、`0 9 15 * 1`（dom 与 dow 同时非 `*`）
  - **往返恒等**：对每种模式 `parseCronPreset(buildCronPreset(p))` 回到同一个 `p`
  - `resolveCronExpr`：custom 模式原样返回 `cronExpr`，其余模式忽略 `cronExpr` 用参数拼
  - `buildCronPreset` 在 `time` 非法（空串 / 缺冒号）时返回空串

### 既有测试的改动

- `web/src/utils/scheduleLabel.test.ts`
  - `intervalLabel` 4 条断言**保持不变**（已验证仍成立）
  - 新增：`intervalLabel(604800) === '每 1 星期'`、`intervalLabel(5401) === '每 5401 秒'`
  - **改**：`cronLabel('0 9 * * 1-5')` 现在返回「工作日 09:00」；把 `scheduleLabel` 那条 `cron_expr: '0 9 * * 1-5'` 的断言从「原样」改成「工作日 09:00」，并另找一个仍然 humanize 不了的表达式（如 `0 9,17 * * *`）保留「原样返回」的覆盖
- `web/src/components/tasks/ScheduledTaskForm.test.tsx`
  - **改**：`toApiBody: only the field matching the schedule type is populated` 里那条 `toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronExpr: '0 9 * * *' })` —— 新模型下 `EMPTY_DRAFT.cronMode` 是 `'daily'`，`resolveCronExpr` 会用**模式参数**拼出 `0 9 * * *` 而**忽略**传入的 `cronExpr`，断言虽然碰巧仍成立，但测的已经不是原意。改成显式传 `cronMode: 'custom'` 才是在测「自定义表达式原样透传」。
  - 其余 `toApiBody` 断言用 `{ ...EMPTY_DRAFT, ... }` 展开，会自动带上新字段，无需改动。
  - 新增：`toApiBody` 在 `interval` 模式下 `intervalSeconds === amount × unit`（例如 amount `'2'` + unit `'day'` → `172800`）。
  - 新增：间隔分支渲染出数字框 + 单位 chip；切到 Cron 渲染出模式 chip；选「自定义」渲染出裸表达式输入框。

## 7. 不在范围内

- **后端**：`scheduler.service` 的 `computeNext` 对 interval 用的是 `while (next <= now) next += stepMs` 循环追补（`scheduler.service.ts:34`）。间隔越小、停机越久迭代越多 —— 60 秒间隔停机一年约 52 万次。下限取 1 分钟已经把最坏情况压住，本次**不改**这个循环。
- 时区：cron 分支不提供时区选择，沿用 `timezone: 'local'`。
- 秒级精度：最小 1 分钟。调度器是 15 秒一跳（`setInterval(tick, 15_000)`），更小的间隔本来也触发不到。

## 8. 影响面与风险

- **`ScheduledTaskDraft` 是 `toApiBody` 的入参**，改字段会波及 `ScheduledTasksPanel.tsx`（它 import 了 `toApiBody` 和 `type ScheduledTaskDraft`）—— 但 panel 只做转发，不改逻辑。
- **历史值的两个边界情况**（都在 §3 的兜底里处理，但需在测试里钉住）：
  1. `interval_seconds` 为 `null` / `NaN` / `< 1` → 兜底到 3600（1 小时）。
  2. `interval_seconds` 落在 `[1, 59]`（只能通过 API 直调产生，旧预设全是 3600 起）→ 回填成「N 秒」，此时提交会被 §4 的校验拦住，要求用户上调到 1 分钟以上。**这是有意的**：15 秒一跳的调度器上，亚分钟间隔是假的。
- **`cronLabel` 的 `1-5` 分支位置**：必须在 `/^[0-6]$/` 判断之前，否则 `工作日` 永远不会命中。
