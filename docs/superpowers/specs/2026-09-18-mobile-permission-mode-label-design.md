# 手机端会话权限模式标签可见性设计

- 日期：2026-09-18
- 状态：待实现
- 起因：手机（`<640px`）上会话输入栏的模式按钮**只剩一个纯色圆点**，文字被响应式隐藏，用户无法分辨当前是 Default / Auto / Accept Edits / Bypass / Plan 中的哪一个

## 0. 目的与读者

让窄屏下的会话输入栏能**直接读出**当前权限模式。读者是实现者（人或 agent）。

本文只覆盖**模式标签的可见性**这一件事。不覆盖模式的取值、切换、持久化逻辑（`useChatProviderState.ts` 一行不改），也不覆盖"显示值可能与实际生效值不符"的问题（见 §5）。

## 1. 现状

### 1.1 根因

`web/src/components/chat/view/subcomponents/ChatComposer.tsx:503`：

```tsx
<span className="hidden whitespace-nowrap sm:inline">
  {permissionMode === 'default' && t('codex.modes.default')}
  …
</span>
```

`<640px`（`sm` 断点）时这段文字 `display:none`，按钮里只剩 `:490-502` 的圆点。颜色映射：灰 = default、绿 = acceptEdits、蓝 = auto、橙 = bypassPermissions、主色 = plan。

按钮唯一的补充线索是 `title={t('input.clickToChangeMode')}`（`:487`），而 **`title` 在触屏上不触发**，等于完全没有可读信息。

### 1.2 相关事实

| 项 | 现状 |
|---|---|
| 模式来源 | **请求级**。`sessions` 表无此列（`backend/server/modules/database/schema.ts:127-152`），前端靠 `localStorage` 的 `permissionMode-<sessionId>` / `permissionMode-last-<provider>` 记住（`useChatProviderState.ts:605,611,646,648`） |
| 切换方式 | **点击循环**（`onModeSwitch` → `cyclePermissionMode`），Tab 键同效 |
| 可选值 | 按 provider 不同：claude 5 种（含 auto）、codex 3 种（无 plan）、opencode / qoder 4 种（无 auto），权威定义在 `provider-capabilities.service.ts:14-68` |
| 文案 | 只有 `en` 一份 locale（`web/src/i18n/config.js`），`fallbackLng: 'en'`，缺失 key 会原样返回 key |
| 布局 | `PromptInputTools` 是 `flex flex-wrap`（`web/src/shared/view/ui/PromptInput.tsx:129`），补文字**不会裁切**，但可能折成两行 |

### 1.3 为什么只有模式按钮出问题

同一排里其它被 `sm:` 隐藏的元素都还留着可读的值：

- Effort 按钮（`:541`）藏的是标签词 `"Effort"`，**值本身**（`High` 等）仍显示；
- 清除输入按钮（`:611`）`hidden sm:flex`，是纯图标按钮，与信息无关。

模式按钮是唯一"藏掉之后只剩一个无语义色块"的。

## 2. 目标行为

窄屏（`<640px`）下模式按钮显示 **圆点 + 短标签**；桌面端（`≥640px`）显示 **圆点 + 现有完整文案**，与今天完全一致。

## 3. 方案取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（采用）** | 纯 CSS：一个 span 拆成 `sm:hidden` / `hidden sm:inline` 两个 | 零 JS、零额外重渲染，沿用仓库既有的 `sm:` 约定（模型按钮 `max-w-24 sm:max-w-32`、Effort 按钮同套路） |
| B | 用 `useDeviceSettings` 的 `isMobile` 做 JS 分支 | 该 hook 默认断点 **768**，与现有 `sm:` 640 不一致，得手动传参；为切一句文案引入 resize 监听重渲染，收益不抵复杂度 |
| C | 缩小字号硬塞（`text-[10px]`） | 10px 在手机上近乎不可读，且不解决"最长 17 字符"的根本问题 |

## 4. 设计

### 4.1 组件改动

`ChatComposer.tsx` 模式按钮内，把 `:503-509` 的单个 span 换成两个，并把那 5 行 `{permissionMode === 'x' && t(…)}` 链式渲染收敛为一次查表：

```tsx
<span className="whitespace-nowrap sm:hidden">{t(labels.shortKey)}</span>
<span className="hidden whitespace-nowrap sm:inline">{t(labels.fullKey)}</span>
```

**Tailwind 类序说明**：`hidden` 与 `sm:inline` 都作用于 `display`，变体类在样式表中排在基础类之后，所以 `≥640px` 时 `sm:inline` 生效、`<640px` 时 `hidden` 生效 —— 这正是现有代码已在用的行为。`whitespace-nowrap sm:hidden` 一侧没有基础 `display` 类，span 默认 `inline`，`<640px` 可见、`≥640px` 被 `sm:hidden` 关掉。

同时给按钮补 `aria-label`（包含当前模式），因为 `title` 在触屏上不触发：

```tsx
aria-label={t('input.currentMode', { defaultValue: 'Permission mode: {{mode}}', mode: t(labels.fullKey) })}
```

`title` 保留不动。

**明确不动的**：`:477-501` 那段颜色嵌套三元不重构；圆点尺寸 `h-2.5 w-2.5 sm:h-1.5 sm:w-1.5` 保持现状；`onClick={onModeSwitch}` 循环切换保留。

### 4.2 标签映射（新增纯函数）

新增 `web/src/components/chat/view/subcomponents/permissionModeLabels.ts`，与同目录 `convertToTaskPayload.ts` + `.test.ts` 的既有惯例一致：

```ts
import type { PermissionMode } from '../../types/types';

export type PermissionModeLabelKeys = { shortKey: string; fullKey: string };

const LABEL_KEYS: Record<PermissionMode, PermissionModeLabelKeys> = {
  default:           { shortKey: 'codex.modesShort.default',           fullKey: 'codex.modes.default' },
  auto:              { shortKey: 'codex.modesShort.auto',              fullKey: 'codex.modes.auto' },
  acceptEdits:       { shortKey: 'codex.modesShort.acceptEdits',       fullKey: 'codex.modes.acceptEdits' },
  bypassPermissions: { shortKey: 'codex.modesShort.bypassPermissions', fullKey: 'codex.modes.bypassPermissions' },
  plan:              { shortKey: 'codex.modesShort.plan',              fullKey: 'codex.modes.plan' },
};

/** 未知值兜底到 default —— 与 ChatComposer 现有渲染的「全部不匹配则什么都不显示」相比，
 *  这里保证按钮在任何输入下都有可读文字。 */
export function getPermissionModeLabelKeys(mode: PermissionMode | string): PermissionModeLabelKeys {
  return LABEL_KEYS[mode as PermissionMode] ?? LABEL_KEYS.default;
}
```

抽成纯函数的原因：**web 测试无 DOM 环境**（`node:test` + `renderToStaticMarkup`），只有纯逻辑才测得干净。

### 4.3 i18n

`web/src/i18n/locales/en/chat.json` 的 `codex` 下新增 `modesShort`：

| mode | 完整（桌面，沿用现有） | 短（窄屏，新增） |
|---|---|---|
| default | `Default Mode` | `Default` |
| auto | `Auto Mode` | `Auto` |
| acceptEdits | `Accept Edits` | `Edits` |
| bypassPermissions | `Bypass Permissions` | `Bypass` |
| plan | `Plan Mode` | `Plan` |

短标签最长 7 字符（`Default` / `Bypass`），手机上一行放得下。

另新增 `input.currentMode`（供 `aria-label` 用）。

`web/src/i18n/locales/en/settings.json:413` 的 `settings.codex.modes` 是设置页静态文案，**不动**。

## 5. 不做

| 项 | 说明 |
|---|---|
| 加模式选择抽屉 / 下拉 | 用户在方案选择中明确选了"按钮上直接补文字"，不是抽屉。循环切换保留 |
| 修「显示值 ≠ 实际生效值」 | 后端会在两条路径改写模式：`backend/server/claude-sdk.js:258` 在 `skipPermissions` 时强制 `bypassPermissions`，`:694` operator 会话强制 bypass。本次只解决"看不见"，不解决"显示的可能不是实际生效的"。要修需新增接口复刻这段归一化逻辑，属独立议题 |
| 让模式持久化到后端 | 现状是 `localStorage` 单端记忆，换设备丢失。不在本次范围 |
| 动其它 `sm:` 隐藏项 | Effort 标签词、清除输入按钮（见 §1.3）行为合理，不改 |
| 加 zh 等其它 locale | 仓库当前只 bundle 了 `en`（`config.js`），新增 `modesShort` 只需落在 `en` |
| 统一 codex/opencode/qoder 缺失的 mode | `auto` 只在 claude 有、codex 无 `plan`，是后端能力矩阵的事，前端已由 `resolvePermissionModeForProvider` 静默归一 |

## 6. 验收

### 6.1 自动化

web 包没有 `npm test`；跑之前必须 `unset TSX_TSCONFIG_PATH`（该变量会劫持 tsx）。

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test \
  src/components/chat/view/subcomponents/permissionModeLabels.test.ts
npm run typecheck && npm run lint
```

`permissionModeLabels.test.ts` 用例：

1. 5 种合法模式各自返回正确的 `shortKey` / `fullKey`，且两个 key 分属 `codex.modesShort.*` 与 `codex.modes.*`；
2. `getPermissionModeLabelKeys('garbage')` 兜底到 default 而非抛错 / 返回 `undefined`；
3. `LABEL_KEYS` 的键集与 `PermissionMode` 联合类型完全一致（防漏：新增 mode 时忘了补标签）。

typecheck / lint **零新增**（仓库 baseline 本就不干净，见 memory `lovdex-backend-baseline-not-clean`）。

**测试写明的局限**：`node:test` + 无 DOM 无排版引擎，本单测只覆盖映射表，**证明不了** `sm:hidden` / `hidden sm:inline` 在浏览器里的实际显隐 —— 那部分由 §6.2 目视确认。

### 6.2 浏览器

:5188 前端 / :3188 后端已在跑，纯前端改动走 vite HMR，**不重启后端**。用 headless Chrome（`~/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome`）连 live dev server，深链进一个会话：

1. 视口 375px：模式按钮内出现短标签文字（如 `Default`），**不是**只有圆点；
2. 依次把模式切到 5 种（点按钮循环），375px 下文字随之变化且各自可辨；
3. 量 `[data-slot="prompt-input-footer"]` 的高度。**先测改动前的 baseline**（`git stash` 后测，或直接读改动前一次构建的值），再测改动后：375px 下若折成两行，高度增长应 ≤ 一行按钮高度（`h-8` = 32px）。超过 32px 说明标签还是太长，需要回去缩短短标签文案；
4. 视口 640px 与 1280px：显示的是**完整文案**（`Default Mode` 等），与改动前逐字一致 —— 这条是防回归的主断言；
5. 深色模式下 5 种颜色的圆点 + 文字都可辨；
6. 按钮 `aria-label` 含当前模式名。

## 7. 影响文件

| 文件 | 改动 |
|---|---|
| `web/src/components/chat/view/subcomponents/ChatComposer.tsx` | 模式按钮：单 span 拆双 span、5 行链式渲染收敛为查表、补 `aria-label` |
| `web/src/components/chat/view/subcomponents/permissionModeLabels.ts` | 新增：`LABEL_KEYS` + `getPermissionModeLabelKeys` |
| `web/src/components/chat/view/subcomponents/permissionModeLabels.test.ts` | 新增：§6.1 三条用例 |
| `web/src/i18n/locales/en/chat.json` | 新增 `codex.modesShort.*`（5 条）与 `input.currentMode` |
