# 定时任务间隔颗粒度细化 + Cron 快捷模式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把定时任务表单「调度」区块里的「间隔」从 4 个写死的预设改成「数字 + 单位（秒/分钟/小时/天/星期）」，把「Cron」从裸表达式输入框改成「模式 chip + 时间/星期/日期控件」，认不出的表达式原样落到「自定义」。

**Architecture:** 两个新的纯逻辑模块 `interval.ts` / `cronPreset.ts` 各自拥有「单位换算」与「cron 预设解析/构建」的单一事实来源；`scheduleLabel.ts` 的列表显示改为复用 `interval.ts` 的分解规则，保证表单与列表永远一致；`ScheduledTaskDraft` 把有损的 `intervalSeconds: string` 换成 `intervalAmount` + `intervalUnit`，并为 cron 增加模式参数。**后端零改动。**

**Tech Stack:** TypeScript / React 18 / Tailwind / node:test + `renderToStaticMarkup`（前端，无 DOM 环境）

**Spec:** `docs/superpowers/specs/2026-09-18-schedule-interval-and-cron-preset-design.md`

---

## 测试命令（实测可用，务必照抄）

```bash
# 前端测试：必须 env -u，否则会被全局 TSX_TSCONFIG_PATH 劫持到后端 tsconfig
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/interval.test.ts

# typecheck
cd web && npm run typecheck
```

基线（改动前实测）：web typecheck **0 错误**；前端全量测试 **468 pass / 0 fail**。

**验收标准是「零新增失败」。**

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/utils/interval.ts` | 新建 | 间隔单位表 + 秒数 ↔ (数字, 单位) 的精确换算 + 取值边界 |
| `web/src/utils/cronPreset.ts` | 新建 | cron 快捷模式的解析 / 构建 / 唯一事实来源 `resolveCronExpr` |
| `web/src/utils/scheduleLabel.ts` | 修改 | `intervalLabel` 改用共享分解；`cronLabel` 补「工作日」分支 |
| `web/src/utils/scheduleLabel.test.ts` | 修改 | 同步既有断言（`0 9 * * 1-5` 不再原样显示）+ 补新断言 |
| `web/src/utils/interval.test.ts` | 新建 | `interval.ts` 的单测 |
| `web/src/utils/cronPreset.test.ts` | 新建 | `cronPreset.ts` 的单测 |
| `web/src/components/tasks/ScheduledTaskForm.tsx` | 修改 | draft 换字段；调度区块的 interval / cron 分支重做；校验 |
| `web/src/components/tasks/ScheduledTaskForm.test.tsx` | 修改 | 同步 `toApiBody` 断言 + 补 UI 渲染断言 |

**改动顺序的约束**：Task 4（间隔）与 Task 5（Cron）**刻意分开**，各自都是可独立交付的不破坏状态 —— Task 4 只动 interval 相关字段与分支，`cronExpr` 仍是裸字符串；Task 5 才引入 `cronMode` 系列字段。反过来（一次性全改）会让 `toApiBody` 在中间态里用 `resolveCronExpr` 而表单还在渲染裸输入框，Cron 分支会静默失效。

---

## Task 1: 新增 `interval.ts`

**Files:**
- Create: `web/src/utils/interval.ts`
- Test: `web/src/utils/interval.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/utils/interval.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERVAL_MAX_SECONDS,
  INTERVAL_MIN_SECONDS,
  decomposeInterval,
  intervalSecondsOf,
  intervalUnitLabel,
} from './interval';

test('decomposeInterval picks the largest unit that divides exactly', () => {
  assert.deepEqual(decomposeInterval(60), { amount: 1, unit: 'minute' });
  assert.deepEqual(decomposeInterval(3600), { amount: 1, unit: 'hour' });
  assert.deepEqual(decomposeInterval(5400), { amount: 90, unit: 'minute' });
  assert.deepEqual(decomposeInterval(86400), { amount: 1, unit: 'day' });
  assert.deepEqual(decomposeInterval(604800), { amount: 1, unit: 'week' });
  // 非整分钟的值如实落到「秒」，不做四舍五入 —— 近似会撒谎成「每 2 分钟」
  assert.deepEqual(decomposeInterval(90), { amount: 90, unit: 'second' });
  assert.deepEqual(decomposeInterval(45), { amount: 45, unit: 'second' });
});

test('decomposeInterval never approximates: the round trip is exact', () => {
  for (const s of [45, 60, 90, 1800, 3600, 5400, 86400, 172800, 604800, 1209600]) {
    const { amount, unit } = decomposeInterval(s);
    assert.equal(intervalSecondsOf(amount, unit), s, `round trip failed for ${s}`);
  }
});

test('intervalUnitLabel reads the label off the shared unit table', () => {
  assert.equal(intervalUnitLabel('second'), '秒');
  assert.equal(intervalUnitLabel('week'), '星期');
});

test('the bounds bracket exactly one minute and one year', () => {
  assert.equal(INTERVAL_MIN_SECONDS, 60);
  assert.equal(INTERVAL_MAX_SECONDS, 365 * 86400);
  // 调度器 15 秒一跳，下限必须 ≥ 15 秒，否则用户设的值会被静默降级
  assert.ok(INTERVAL_MIN_SECONDS >= 15);
  // 上限正好是一整年，用户选「365 天」时卡在边界上而不是越界
  assert.equal(INTERVAL_MAX_SECONDS % 86400, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/interval.test.ts`
Expected: FAIL —— 模块不存在，`Cannot find module './interval'`。

- [ ] **Step 3: 实现**

创建 `web/src/utils/interval.ts`：

```ts
/**
 * 定时任务「间隔」的单位表与秒数换算。
 *
 * 单一事实来源：表单的数字框/单位 chip 与列表的 intervalLabel 都从这里取，
 * 保证「表单里选的」和「列表里显示的」永远是同一个值。
 */

export type IntervalUnit = 'second' | 'minute' | 'hour' | 'day' | 'week';

export const INTERVAL_UNITS: { value: IntervalUnit; label: string; seconds: number }[] = [
  { value: 'second', label: '秒', seconds: 1 },
  { value: 'minute', label: '分钟', seconds: 60 },
  { value: 'hour', label: '小时', seconds: 3600 },
  { value: 'day', label: '天', seconds: 86400 },
  { value: 'week', label: '星期', seconds: 604800 },
];

/** 调度器是 15 秒一跳（setInterval(tick, 15_000)），更小的间隔根本触发不到；上限取一整年。 */
export const INTERVAL_MIN_SECONDS = 60;
export const INTERVAL_MAX_SECONDS = 365 * 86400;

const DESC = [...INTERVAL_UNITS].sort((a, b) => b.seconds - a.seconds);

/**
 * 秒 → (数字, 单位)：取「能整除的最大单位」，保证 amount × unit.seconds === seconds 精确成立。
 *
 * 单位表里有「秒」，任何整数秒都能整除，所以这是**全函数** —— 不会出现「90 秒显示成
 * 2 分钟」这种近似。近似在这里是有害的：用户会以为任务真的每 2 分钟触发一次。
 *
 * 要求 `seconds` 是 ≥ 1 的有限数；非法输入的兜底由调用方负责（见 ScheduledTaskForm.toDraft）。
 */
export function decomposeInterval(seconds: number): { amount: number; unit: IntervalUnit } {
  for (const u of DESC) {
    if (seconds % u.seconds === 0) return { amount: seconds / u.seconds, unit: u.value };
  }
  // 不可达：'second' 的 seconds 是 1，任何整数都能整除。保留以满足返回类型。
  return { amount: seconds, unit: 'second' };
}

export function intervalSecondsOf(amount: number, unit: IntervalUnit): number {
  const u = INTERVAL_UNITS.find((x) => x.value === unit);
  return u ? amount * u.seconds : 0;
}

/** 单位 → 中文标签。从 INTERVAL_UNITS 派生，避免单位表存在两份。 */
export function intervalUnitLabel(unit: IntervalUnit): string {
  return INTERVAL_UNITS.find((x) => x.value === unit)?.label ?? unit;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/interval.test.ts`
Expected: 4 条全部 pass。

- [ ] **Step 5: typecheck**

Run: `cd web && npm run typecheck 2>&1 | tail -5`
Expected: 0 错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/utils/interval.ts web/src/utils/interval.test.ts
git commit -m "feat(tasks): add exact interval unit decomposition"
```

---

## Task 2: 新增 `cronPreset.ts`

**Files:**
- Create: `web/src/utils/cronPreset.ts`
- Test: `web/src/utils/cronPreset.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/utils/cronPreset.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOM_OPTIONS,
  DOW_OPTIONS,
  buildCronPreset,
  parseCronPreset,
  resolveCronExpr,
  type CronPreset,
} from './cronPreset';

test('parseCronPreset recognises the four preset shapes', () => {
  assert.deepEqual(parseCronPreset('0 8 * * *'), { mode: 'daily', time: '08:00', dow: '1', dom: '1' });
  assert.deepEqual(parseCronPreset('30 6 * * 0'), { mode: 'weekly', time: '06:30', dow: '0', dom: '1' });
  assert.deepEqual(parseCronPreset('0 9 * * 1-5'), { mode: 'weekday', time: '09:00', dow: '1', dom: '1' });
  assert.deepEqual(parseCronPreset('0 10 15 * *'), { mode: 'monthly', time: '10:00', dow: '1', dom: '15' });
});

test('parseCronPreset returns null for anything it cannot represent exactly', () => {
  // 多值 / 列表 / 步进 / 段数不对 / 越界 / dom 与 dow 同时非 * —— 一律落到「自定义」，
  // 原始表达式一个字符都不改。
  for (const expr of ['0 9,17 * * *', '0 9 * * 1,3', '*/5 * * * *', '0 9 * *', '0 9 * * * * *', '99 9 * * *', '0 24 * * *', '0 9 15 * 1', '0 9 * 3 *']) {
    assert.equal(parseCronPreset(expr), null, `expected null for ${expr}`);
  }
});

test('parse and build round-trip exactly', () => {
  const cases: CronPreset[] = [
    { mode: 'daily', time: '08:00', dow: '1', dom: '1' },
    { mode: 'weekly', time: '06:30', dow: '0', dom: '1' },
    { mode: 'weekly', time: '23:59', dow: '6', dom: '1' },
    { mode: 'weekday', time: '09:00', dow: '1', dom: '1' },
    { mode: 'monthly', time: '10:00', dow: '1', dom: '15' },
  ];
  for (const c of cases) {
    assert.deepEqual(parseCronPreset(buildCronPreset(c)), c, `round trip failed for ${JSON.stringify(c)}`);
  }
});

test('buildCronPreset returns an empty string for an invalid time', () => {
  for (const time of ['', '9', '25:00', '09:60', 'ab:cd']) {
    assert.equal(buildCronPreset({ mode: 'daily', time, dow: '1', dom: '1' }), '', `expected '' for ${time}`);
  }
});

test('resolveCronExpr: custom passes the raw expression through untouched', () => {
  assert.equal(
    resolveCronExpr({ cronMode: 'custom', cronExpr: '0 9,17 * * *', cronTime: '09:00', cronDow: '1', cronDom: '1' }),
    '0 9,17 * * *',
  );
});

test('resolveCronExpr: preset modes ignore cronExpr and rebuild from the parameters', () => {
  assert.equal(
    resolveCronExpr({ cronMode: 'daily', cronExpr: '0 9,17 * * *', cronTime: '08:00', cronDow: '1', cronDom: '1' }),
    '0 8 * * *',
  );
  assert.equal(
    resolveCronExpr({ cronMode: 'weekday', cronExpr: '', cronTime: '09:30', cronDow: '1', cronDom: '1' }),
    '30 9 * * 1-5',
  );
  assert.equal(
    resolveCronExpr({ cronMode: 'weekly', cronExpr: '', cronTime: '06:00', cronDow: '3', cronDom: '1' }),
    '0 6 * * 3',
  );
  assert.equal(
    resolveCronExpr({ cronMode: 'monthly', cronExpr: '', cronTime: '10:00', cronDow: '1', cronDom: '15' }),
    '0 10 15 * *',
  );
});

test('the option tables cover every weekday and day-of-month', () => {
  assert.equal(DOW_OPTIONS.length, 7);
  assert.deepEqual(DOW_OPTIONS.map((o) => o.value), ['0', '1', '2', '3', '4', '5', '6']);
  assert.equal(DOM_OPTIONS.length, 31);
  assert.equal(DOM_OPTIONS[0].value, '1');
  assert.equal(DOM_OPTIONS[30].value, '31');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/cronPreset.test.ts`
Expected: FAIL —— `Cannot find module './cronPreset'`。

- [ ] **Step 3: 实现**

创建 `web/src/utils/cronPreset.ts`：

```ts
/**
 * 定时任务 Cron 的「快捷模式」模型：把常见表达式结构化成可点的控件。
 *
 * 只认本模块 buildCronPreset 能生成的四种形态 —— **刻意不做通用 cron 解析**。
 * 解析得越宽，「保存后表达式被悄悄改写」的风险越大；认不出的一律原样透传。
 */

export type CronPresetMode = 'daily' | 'weekly' | 'weekday' | 'monthly';
export type CronMode = CronPresetMode | 'custom';

export type CronPreset = { mode: CronPresetMode; time: string; dow: string; dom: string };

export const CRON_MODES: { value: CronMode; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'weekday', label: '工作日' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义' },
];

/** 值直接就是 cron 的 dow 字段（0 = 周日），不需要再做映射。 */
export const DOW_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: '周日' },
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
];

export const DOM_OPTIONS: { value: string; label: string }[] = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: `${i + 1} 日`,
}));

/**
 * 认得出的表达式 → 结构化预设；认不出的返回 null（调用方落到「自定义」并原样保留）。
 *
 * 识别顺序有讲究：`weekday`（`1-5`）必须在 `weekly`（`/^[0-6]$/`）之前。`'1-5'` 是三个
 * 字符、不会被那个单字符正则匹配，所以顺序上其实等价 —— 但显式排在前面能让意图一眼可见。
 */
export function parseCronPreset(expr: string): CronPreset | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  // 月份非 * 的表达式（如季度任务）不在这四种形态里
  if (month !== '*') return null;

  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const base = { time, dow: '1', dom: '1' };

  if (dom === '*' && dow === '*') return { mode: 'daily', ...base };
  if (dom === '*' && dow === '1-5') return { mode: 'weekday', ...base };
  if (dom === '*' && /^[0-6]$/.test(dow)) return { mode: 'weekly', ...base, dow };
  if (/^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31 && dow === '*') {
    return { mode: 'monthly', ...base, dom };
  }
  return null;
}

/** (模式, 参数) → cron 表达式。`time` 非法（空 / 缺冒号 / 越界）时返回空串。 */
export function buildCronPreset(preset: CronPreset): string {
  const [h, m] = preset.time.split(':');
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return '';
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return '';
  const head = `${mm} ${hh}`;
  switch (preset.mode) {
    case 'daily':
      return `${head} * * *`;
    case 'weekday':
      return `${head} * * 1-5`;
    case 'weekly':
      return `${head} * * ${preset.dow}`;
    case 'monthly':
      return `${head} ${preset.dom} * *`;
    default:
      return '';
  }
}

/**
 * cron 分支的**唯一事实来源**：自定义模式用原始表达式，其余模式按参数拼。
 *
 * `cronExpr` 只承载「自定义」模式的内容。让它继续当唯一来源的话，UI 就得「改时间 →
 * 回写表达式」，而用户在自定义框里逐字敲 `0 9 * * *` 时，中途会被识别成 daily、
 * 控件突然换掉。反过来让本函数当来源，就不存在双源同步问题。
 */
export function resolveCronExpr(draft: {
  cronMode: CronMode;
  cronExpr: string;
  cronTime: string;
  cronDow: string;
  cronDom: string;
}): string {
  if (draft.cronMode === 'custom') return draft.cronExpr;
  return buildCronPreset({
    mode: draft.cronMode,
    time: draft.cronTime,
    dow: draft.cronDow,
    dom: draft.cronDom,
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/cronPreset.test.ts`
Expected: 7 条全部 pass。

- [ ] **Step 5: typecheck**

Run: `cd web && npm run typecheck 2>&1 | tail -5`
Expected: 0 错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/utils/cronPreset.ts web/src/utils/cronPreset.test.ts
git commit -m "feat(tasks): add cron preset parse/build with exact round-trip"
```

---

## Task 3: `scheduleLabel.ts` 与共享规则对齐

`intervalLabel` 现在**四舍五入**（`Math.round(seconds / 60)`），会把 5401 秒显示成「每 90 分钟」—— 一个谎。改用 `decomposeInterval` 后与表单永远一致。同时 `cronLabel` 补「工作日」分支。

**Files:**
- Modify: `web/src/utils/scheduleLabel.ts`
- Test: `web/src/utils/scheduleLabel.test.ts`

- [ ] **Step 1: 改既有测试 + 写新断言（失败）**

`web/src/utils/scheduleLabel.test.ts` 有三处改动。

**(a)** 顶部 import 补 `intervalLabel` 已经在用了，无需改。

**(b)** `cronLabel humanizes common patterns and falls back to raw` 这条**保持不变**（它没测 `1-5`），但**追加**两条：

```ts
test('cronLabel humanizes weekdays', () => {
  assert.equal(cronLabel('0 9 * * 1-5'), '工作日 09:00');
});

test('cronLabel falls back to raw for expressions the preset parser rejects', () => {
  // 复用 parseCronPreset 之后 cronLabel 变严了：越界的表达式不再被硬凑成中文
  // （以前 '99 9 * * *' 会输出「每天 09:99」这种明显坏掉的结果）
  assert.equal(cronLabel('99 9 * * *'), '99 9 * * *');
  assert.equal(cronLabel('0 9 * 3 *'), '0 9 * 3 *');
  assert.equal(cronLabel('0 9 * * 1,3'), '0 9 * * 1,3');
});
```

**(c)** `scheduleLabel dispatches by schedule_type` 里那条 `cron_expr: '0 9 * * 1-5'` 现在会返回「工作日 09:00」而不是原样。把它改成：

```ts
test('scheduleLabel dispatches by schedule_type', () => {
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' })), '一次性');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'interval', interval_seconds: 86400 })), '每 1 天');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'cron', cron_expr: '0 9 * * 1-5' })), '工作日 09:00');
  // humanize 不了的表达式仍然原样显示
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'cron', cron_expr: '0 9,17 * * *' })), '0 9,17 * * *');
});
```

**(d)** `intervalLabel converts seconds to readable units` 的 4 条断言**保持不变**（已验证改用精确分解后仍成立），并追加：

```ts
test('intervalLabel uses the same exact decomposition as the form', () => {
  // 与表单的单位表对齐：一周不再显示成「每 7 天」
  assert.equal(intervalLabel(604800), '每 1 星期');
  // 非整除值如实显示，不再四舍五入撒谎成「每 90 分钟」
  assert.equal(intervalLabel(5401), '每 5401 秒');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/scheduleLabel.test.ts`
Expected: FAIL 三条 —— `工作日 09:00` 得到 `0 9 * * 1-5`、`每 1 星期` 得到 `每 7 天`、`每 5401 秒` 得到 `每 90 分钟`。

- [ ] **Step 3: 实现**

`web/src/utils/scheduleLabel.ts` 顶部 import 追加：

```ts
import { decomposeInterval, intervalUnitLabel } from './interval';
```

把 `intervalLabel` 整个替换为：

```ts
/**
 * interval_seconds → 可读中文。
 *
 * 与表单共用 interval.ts 的精确分解，保证「表单里选的」和「列表里显示的」是同一个值。
 * 这里**不做四舍五入**：把 5401 秒显示成「每 90 分钟」会让用户以为任务真的每 90 分钟
 * 触发一次，而实际是 90 分 1 秒。
 */
export function intervalLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return `每 ${seconds} 秒`;
  const { amount, unit } = decomposeInterval(seconds);
  return `每 ${amount} ${intervalUnitLabel(unit)}`;
}
```

把 `cronLabel` **整个替换**为（不再自己手写一套「切分 → 校验 → 匹配形态」的逻辑，改为复用 `cronPreset.ts` 的识别规则 —— 否则同一套规则会在 `parseCronPreset` 和 `cronLabel` 里各存一份）：

```ts
/** 常见 cron 表达式 → 中文；无法 humanize 时原样返回。 */
export function cronLabel(expr: string): string {
  const preset = parseCronPreset(expr);
  if (!preset) return expr;
  switch (preset.mode) {
    case 'daily':
      return `每天 ${preset.time}`;
    case 'weekday':
      return `工作日 ${preset.time}`;
    case 'weekly':
      return `每周${DOW_LABELS[Number(preset.dow)]} ${preset.time}`;
    case 'monthly':
      return `每月 ${Number(preset.dom)} 日 ${preset.time}`;
    default:
      return expr;
  }
}
```

顶部 import 追加：

```ts
import { parseCronPreset } from './cronPreset';
```

`DOW_LABELS` 保留（`weekly` 分支仍在用）。

**副作用（有意的）**：`cronLabel` 因此变**严**了 —— 越界的表达式不再被硬凑成中文。例如 `99 9 * * *` 以前会输出「每天 09:99」（明显是坏的），现在原样返回。这是行为改进，由 Task 3 自己的测试覆盖。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/utils/scheduleLabel.test.ts`
Expected: 全部 pass。

- [ ] **Step 5: 跑一次全量前端测试，确认没连累别人**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | tr '\n' ' ') 2>&1 | tail -6`
Expected: 与基线一致（468 + 新增的 interval/cronPreset 用例数），0 fail。

- [ ] **Step 6: Commit**

```bash
git add web/src/utils/scheduleLabel.ts web/src/utils/scheduleLabel.test.ts
git commit -m "refactor(tasks): share the exact interval decomposition with the list label"
```

---

## Task 4: 间隔 —— draft 换字段 + 数字框/单位 chip

只动 interval 相关部分。`cronExpr` 在这一步仍是裸字符串（Task 5 才改）。

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 写失败的测试**

`web/src/components/tasks/ScheduledTaskForm.test.tsx` 有两处准备改动。

**(a) 给 `renderWithOptions` 加一个 `initial` 参数** —— 表单默认停在「单次」，不传 `initial` 就渲染不到 interval / cron 分支：

```ts
function renderWithOptions(projectOptions: unknown[], initial: unknown = null) {
  return renderToStaticMarkup(
    React.createElement(ScheduledTaskForm, {
      open: true,
      initial: initial as never,
      projectOptions: projectOptions as never,
      submitting: false,
      error: null,
      onClose,
      onSubmit,
    }),
  );
}
```

**(b) 加一个构造既有定时任务的辅助函数**（放在 `renderWithOptions` 之后）：

```ts
function mkScheduledTask(over: Record<string, unknown>) {
  return {
    schedule_id: 's1', title: 't', description: 'd', project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, schedule_type: 'interval', cron_expr: null,
    interval_seconds: 5400, run_at: null, timezone: 'local',
    next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
    enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}
```

**(c) 追加测试**：

```ts
test('toApiBody: the interval seconds are amount × unit', () => {
  const twoDays = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'interval', intervalAmount: '2', intervalUnit: 'day' });
  assert.equal(twoDays.intervalSeconds, 172800);

  const ninetyMin = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'interval', intervalAmount: '90', intervalUnit: 'minute' });
  assert.equal(ninetyMin.intervalSeconds, 5400);
});

test('an interval schedule renders a number box plus a unit chip', () => {
  // 5400 秒 → 分解成 (90, 分钟)，回填的应是分解后的值而不是别的预设
  const html = renderWithOptions([], mkScheduledTask({ interval_seconds: 5400 }));
  const numberBox = /<input[^>]*aria-label="间隔数量"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(numberBox.length > 0, 'interval number box must render');
  assert.ok(numberBox.includes('type="number"'), 'it must be a number input');
  assert.ok(numberBox.includes('value="90"'), 'the amount must be the decomposed value');
  assert.ok(/<button[^>]*aria-label="间隔单位"[^>]*>/.test(html), 'the unit chip must render');
  assert.ok(html.includes('分钟'), 'the unit chip must show the decomposed unit');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: FAIL —— `intervalAmount` / `intervalUnit` 不是 `ScheduledTaskDraft` 的字段（TS 报错），`intervalSeconds` 会拿到 `NaN`。

- [ ] **Step 3: 实现**

`web/src/components/tasks/ScheduledTaskForm.tsx` 的改动：

**(a) import 追加：**

```ts
import {
  INTERVAL_MAX_SECONDS,
  INTERVAL_MIN_SECONDS,
  INTERVAL_UNITS,
  decomposeInterval,
  intervalSecondsOf,
  type IntervalUnit,
} from '../../utils/interval';
```

**(b) `ScheduledTaskDraft`** 里 `intervalSeconds: string;` 换成两行：

```ts
  intervalAmount: string;
  intervalUnit: IntervalUnit;
```

**(c) `EMPTY_DRAFT`** 里 `intervalSeconds: '3600',` 换成两行（等价于原来的 3600 秒）：

```ts
  intervalAmount: '1',
  intervalUnit: 'hour',
```

**(d) `toApiBody`** 里 `intervalSeconds` 那行换成：

```ts
    intervalSeconds: d.scheduleType === 'interval' ? intervalSecondsOf(Number(d.intervalAmount), d.intervalUnit) : null,
```

**(e) 删掉 `INTERVAL_PRESETS`** 整个常量（`:80-85`），以及组件体里的 `intervalOptions` 计算（`:242-248`）。新模型下不存在预设，也就不存在「库里存的自定义值不在预设里」的补项。

**(f) `toDraft`** 里 `intervalSeconds: String(initial.interval_seconds ?? 3600),` 换成：

```ts
    intervalAmount: String(intervalAmount),
    intervalUnit: intervalUnit,
```

并在 `return {` 之前插入：

```ts
  // 非法值（null / NaN / < 1）兜底到 1 小时；能整除的最大单位由 decomposeInterval 决定。
  const rawSeconds = Number(initial.interval_seconds);
  const safeSeconds = Number.isFinite(rawSeconds) && rawSeconds >= 1 ? rawSeconds : 3600;
  const { amount: intervalAmount, unit: intervalUnit } = decomposeInterval(safeSeconds);
```

**(g) `submit`** 里这条：

```ts
    if (draft.scheduleType === 'interval' && !(Number(draft.intervalSeconds) > 0)) {
      setLocalError('间隔必须大于 0 秒');
      return;
    }
```

换成：

```ts
    if (draft.scheduleType === 'interval') {
      const seconds = intervalSecondsOf(Number(draft.intervalAmount), draft.intervalUnit);
      if (!(seconds >= INTERVAL_MIN_SECONDS && seconds <= INTERVAL_MAX_SECONDS)) {
        setLocalError('间隔需在 1 分钟到 365 天之间');
        return;
      }
    }
```

**(h) render 的 interval 分支**（`:363-372`）换成：

```tsx
              {draft.scheduleType === 'interval' && (
                <>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    aria-label="间隔数量"
                    className="h-9 w-24"
                    value={draft.intervalAmount}
                    onChange={(e) => set('intervalAmount', e.target.value)}
                  />
                  <ChipSelect
                    ariaLabel="间隔单位"
                    label="间隔单位"
                    options={INTERVAL_UNITS.map((u) => ({ value: u.value, label: u.label }))}
                    value={draft.intervalUnit}
                    isMobile={isMobile}
                    onChange={(v) => set('intervalUnit', v as IntervalUnit)}
                  />
                </>
              )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: 全部 pass。

- [ ] **Step 5: typecheck**

Run: `cd web && npm run typecheck 2>&1 | tail -5`
Expected: 0 错误（若 `ScheduledTasksPanel.tsx` 因为 `intervalSeconds` 报错，说明有残留引用，需一并清掉 —— 但 panel 只用 `toApiBody(draft)`，不直接读该字段，正常不会有错）。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(tasks): make the interval schedule a number box plus a unit chip"
```

---

## Task 5: Cron —— draft 加模式字段 + 模式 chip

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`

- [ ] **Step 1: 改既有断言 + 写新断言（失败）**

**(a)** `toApiBody: only the field matching the schedule type is populated` 里那条 cron 用例，现在必须显式传 `cronMode: 'custom'` —— 否则 `EMPTY_DRAFT.cronMode` 是 `'daily'`，`resolveCronExpr` 会用**模式参数**拼出 `0 9 * * *` 而忽略传入的 `cronExpr`，断言虽然碰巧仍成立，但测的已经不是「自定义表达式原样透传」了：

```ts
  const cron = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'custom', cronExpr: '0 9 * * *' });
  assert.equal(cron.cronExpr, '0 9 * * *');
  assert.equal(cron.runAt, null);
```

**(b)** 追加：

```ts
test('toApiBody: a preset cron mode is rebuilt from the parameters, ignoring cronExpr', () => {
  const daily = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'daily', cronTime: '08:00', cronExpr: '0 9,17 * * *' });
  assert.equal(daily.cronExpr, '0 8 * * *');

  const weekday = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'weekday', cronTime: '09:30' });
  assert.equal(weekday.cronExpr, '30 9 * * 1-5');

  const monthly = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'monthly', cronTime: '10:00', cronDom: '15' });
  assert.equal(monthly.cronExpr, '0 10 15 * *');
});

test('a new scheduled task defaults to a daily 09:00 cron', () => {
  // EMPTY_DRAFT 的默认值应当拼出一个合法的表达式，而不是空串
  assert.equal(EMPTY_DRAFT.cronMode, 'daily');
  assert.equal(EMPTY_DRAFT.cronTime, '09:00');
  assert.equal(toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron' }).cronExpr, '0 9 * * *');
});

test('a recognised cron expression renders the preset controls with back-filled values', () => {
  // 用 Task 4 里加的 mkScheduledTask 辅助函数
  const html = renderWithOptions([], mkScheduledTask({ schedule_type: 'cron', cron_expr: '0 8 * * *', interval_seconds: null }));
  assert.ok(/<button[^>]*aria-label="Cron 模式"[^>]*>/.test(html), 'the mode chip must render');
  const timeBox = /<input[^>]*aria-label="触发时间"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(timeBox.length > 0, 'the time box must render for a preset mode');
  assert.ok(timeBox.includes('value="08:00"'), 'the time must be back-filled from the expression');
  assert.ok(html.includes('每天'), 'the mode chip must show the recognised mode');
});

test('an unrecognised cron expression falls back to custom mode with the raw box', () => {
  const html = renderWithOptions([], mkScheduledTask({ schedule_type: 'cron', cron_expr: '0 9,17 * * *', interval_seconds: null }));
  const raw = /<input[^>]*aria-label="cron 表达式"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(raw.length > 0, 'custom mode must render the raw expression box');
  assert.ok(raw.includes('value="0 9,17 * * *"'), 'the raw expression must be preserved verbatim');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: FAIL —— `cronMode` / `cronTime` 不是 `ScheduledTaskDraft` 的字段。

- [ ] **Step 3: 实现**

**(a) import 追加：**

```ts
import {
  CRON_MODES,
  DOM_OPTIONS,
  DOW_OPTIONS,
  parseCronPreset,
  resolveCronExpr,
  type CronMode,
} from '../../utils/cronPreset';
```

**(b) `ScheduledTaskDraft`** 的 `cronExpr: string;` 之后加四行：

```ts
  cronMode: CronMode;
  cronTime: string;
  cronDow: string;
  cronDom: string;
```

**(c) `EMPTY_DRAFT`** 的 `cronExpr: '',` 之后加四行（默认「每天 09:00」，与原来输入框的 placeholder `0 9 * * *` 一致）：

```ts
  cronMode: 'daily',
  cronTime: '09:00',
  cronDow: '1',
  cronDom: '1',
```

**(d) `toApiBody`** 的 cron 那行换成：

```ts
    cronExpr: d.scheduleType === 'cron' ? resolveCronExpr(d) : null,
```

**(e) `toDraft`** 里 `cronExpr: initial.cron_expr ?? '',` 换成：

```ts
    cronExpr: initial.cron_expr ?? '',
    cronMode: preset?.mode ?? 'custom',
    cronTime: preset?.time ?? EMPTY_DRAFT.cronTime,
    cronDow: preset?.dow ?? EMPTY_DRAFT.cronDow,
    cronDom: preset?.dom ?? EMPTY_DRAFT.cronDom,
```

并在 `return {` 之前插入（Task 4 已经在那个位置放了 interval 的两行兜底，把这两行加在它们**后面**）：

```ts
  // 认得出就结构化回填；认不出则自定义模式 + 原始表达式原样保留。
  const preset = parseCronPreset(initial.cron_expr ?? '');
```

**(f) `submit`** 里这条：

```ts
    if (draft.scheduleType === 'cron' && !draft.cronExpr.trim()) {
      setLocalError('请填写 cron 表达式');
      return;
    }
```

换成：

```ts
    if (draft.scheduleType === 'cron' && !resolveCronExpr(draft).trim()) {
      setLocalError('请填写 cron 表达式');
      return;
    }
```

**(g) render 的 cron 分支**（`:373-380`）换成：

```tsx
              {draft.scheduleType === 'cron' && (
                <>
                  <ChipSelect
                    ariaLabel="Cron 模式"
                    label="Cron 模式"
                    options={CRON_MODES}
                    value={draft.cronMode}
                    isMobile={isMobile}
                    onChange={(v) => set('cronMode', v as CronMode)}
                  />
                  {draft.cronMode === 'custom' ? (
                    <Input
                      className="h-9 w-auto"
                      placeholder="0 9 * * *"
                      aria-label="cron 表达式"
                      value={draft.cronExpr}
                      onChange={(e) => set('cronExpr', e.target.value)}
                    />
                  ) : (
                    <>
                      {draft.cronMode === 'weekly' && (
                        <ChipSelect
                          ariaLabel="星期"
                          label="星期"
                          options={DOW_OPTIONS}
                          value={draft.cronDow}
                          isMobile={isMobile}
                          onChange={(v) => set('cronDow', v)}
                        />
                      )}
                      {draft.cronMode === 'monthly' && (
                        <ChipSelect
                          ariaLabel="日期"
                          label="日期"
                          options={DOM_OPTIONS}
                          value={draft.cronDom}
                          isMobile={isMobile}
                          onChange={(v) => set('cronDom', v)}
                        />
                      )}
                      <Input
                        type="time"
                        aria-label="触发时间"
                        className="h-9 w-auto"
                        value={draft.cronTime}
                        onChange={(e) => set('cronTime', e.target.value)}
                      />
                    </>
                  )}
                </>
              )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: 全部 pass。

- [ ] **Step 5: 跑全量前端测试 + typecheck**

```bash
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | tr '\n' ' ') 2>&1 | tail -6
cd web && npm run typecheck 2>&1 | tail -5
```
Expected: 0 fail、0 错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(tasks): replace the raw cron box with preset modes"
```

---

## Task 6: 端到端手工验收

自动化测试覆盖不到「控件长什么样、选完真的存对了」，这一步用真实运行的应用补上。

**注意**：重启后端前必须先问用户（同一后端跑着别的项目，见 memory `lovdex-backend-restart-requires-confirm`）。**本次是纯前端改动，vite 会热加载，不需要重启后端。**

- [ ] **Step 1: 打开页面**

用 `http://<本机IP>:5188`（不是 localhost）打开，进 `/tasks?view=scheduled`，点右上「新建任务」。

- [ ] **Step 2: 逐项验收**

**间隔**：
1. 调度切到「间隔」→ 出现**数字框 + 单位 chip**（不是原来的下拉）
2. 数字框填 `30`、单位选「分钟」→ 保存成功；列表里显示「每 30 分钟」
3. 数字框填 `2`、单位选「天」→ 列表显示「每 2 天」
4. 数字框填 `1`、单位选「星期」→ 列表显示「每 1 星期」（不是「每 7 天」）
5. 数字框填 `30`、单位选「秒」→ 提交被拦，红字「间隔需在 1 分钟到 365 天之间」
6. 数字框填 `365`、单位选「天」→ 保存成功（边界值合法）
7. 编辑刚才任一条 → 数字框与单位 chip **回填正确**

**Cron**：
8. 调度切到「Cron」→ 出现**模式 chip**（每天/每周/工作日/每月/自定义）+ 时间控件
9. 默认「每天」+ `09:00` → 保存；列表显示「每天 09:00」
10. 选「每周」→ 多出星期 chip；选「周三」+ `06:30` → 列表显示「每周三 06:30」
11. 选「工作日」+ `09:30` → 列表显示「工作日 09:30」
12. 选「每月」→ 多出日期 chip；选 `15` 日 + `10:00` → 列表显示「每月 15 日 10:00」
13. 选「自定义」→ 出现裸表达式输入框；填 `0 9,17 * * *` → 保存；列表**原样显示** `0 9,17 * * *`
14. 编辑第 13 条 → 模式 chip 停在「自定义」、输入框里是原表达式（**没有被改写**）

- [ ] **Step 3: 清理测试数据**

把第 2-14 步建出来的定时任务删掉，确认列表回到验收前的条数。

- [ ] **Step 4: 记录结果**

不符合预期的写回 spec 或直接修；全部符合则本计划完成。

---

## 自查记录

**Spec 覆盖**：§1 `interval.ts` → Task 1；§2 `cronPreset.ts` → Task 2；§3 draft 换字段 → Task 4（interval 部分）+ Task 5（cron 部分）；§4 表单 UI 与校验 → Task 4/5；§5 列表显示 → Task 3；§6 测试计划 → 各 Task 内；§7 不在范围内 → 未安排任务（正确）；§8 影响面（两个历史值边界）→ Task 4 的 `toDraft` 兜底 + Task 4 Step 1 的断言。

**类型一致性**：`IntervalUnit` / `INTERVAL_UNITS` / `decomposeInterval` / `intervalSecondsOf` / `intervalUnitLabel` / `INTERVAL_MIN_SECONDS` / `INTERVAL_MAX_SECONDS` 在 Task 1 定义，Task 3（`decomposeInterval` + `intervalUnitLabel`）、Task 4（其余）使用，命名一致。`CronMode` / `CronPreset` / `CRON_MODES` / `DOW_OPTIONS` / `DOM_OPTIONS` / `parseCronPreset` / `buildCronPreset` / `resolveCronExpr` 在 Task 2 定义，Task 5 使用。`ScheduledTaskDraft` 的新字段名（`intervalAmount` / `intervalUnit` / `cronMode` / `cronTime` / `cronDow` / `cronDom`）在 Task 4/5 与测试里写法一致。

**测试基座对齐**：前端测试一律 `env -u TSX_TSCONFIG_PATH`；表单测试用既有的 `renderToStaticMarkup` + `renderWithOptions` 辅助函数（无 DOM 环境），纯函数测试直接 import。

**已知取舍**：`intervalLabel` 不再四舍五入（604800 → 「每 1 星期」、5401 → 「每 5401 秒」），这是 spec §5 明确的有意行为变化；`cronLabel('0 9 * * 1-5')` 从原样显示变「工作日 09:00」，对应的既有断言在 Task 3 同步更新。
