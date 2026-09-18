# 手机端会话权限模式标签可见性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机（`<640px`）会话输入栏的模式按钮显示可读文字，而不只是一个无语义的彩色圆点。

**Architecture:** 纯前端。把 `ChatComposer.tsx` 模式按钮里那个 `hidden sm:inline` 的标签 span 拆成两个互斥 span（`whitespace-nowrap sm:hidden` 短标签 / `hidden whitespace-nowrap sm:inline` 完整标签），断点由 CSS 决定，零 JS 分支。标签的 i18n key 由一个纯函数 `getPermissionModeLabelKeys()` 提供，放在独立小文件里以便单测（web 测试无 DOM 环境）。

**Tech Stack:** React + TypeScript + Tailwind（`sm` = 640px）+ i18next + `node:test` / `node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-09-18-mobile-permission-mode-label-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `web/src/components/chat/view/subcomponents/permissionModeLabels.ts` | 模式 → i18n key 的映射。纯数据 + 纯函数，无 React 依赖 | 新建 |
| `web/src/components/chat/view/subcomponents/permissionModeLabels.test.ts` | 上述映射的单测 | 新建 |
| `web/src/i18n/locales/en/chat.json` | 新增 `codex.modesShort.*` 与 `input.currentMode` | 修改 |
| `web/src/components/chat/view/subcomponents/ChatComposer.tsx` | 消费上述两者：双 span + `aria-label` | 修改 |

仓库当前只 bundle 了 `en` 一份 locale（`web/src/i18n/config.js`），`fallbackLng: 'en'`，所以只改 `en/chat.json`。

---

## Task 0: 记录 baseline（不提交任何东西）

改动前先量一遍，否则 §Task 4 的"零回归 / 折行高度"没有对照物。

**Files:** 无

- [ ] **Step 1: 记录 lint / typecheck baseline**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

把两边的错误/警告条数抄下来。验收标准是**零新增**，不是零错误 —— 仓库 baseline 本就不干净。

- [ ] **Step 2: 写浏览器探针脚本**

创建 `/tmp/lovdex-mobile-mode-e2e.cjs`：

```js
/**
 * 探针：会话输入栏的模式标签在各宽度下显示什么。
 * 前置：:5188 前端 / :3188 后端已在跑（纯前端改动走 vite HMR，不重启后端）。
 * 运行：node /tmp/lovdex-mobile-mode-e2e.cjs
 */
const puppeteer = require('puppeteer-core');

const CHROME = '/home/zhijuhuang/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';
const BASE = 'http://127.0.0.1:5188';
const API = 'http://127.0.0.1:3188';
const EMAIL = 'zhiju.huang@sophgo.com';
const CODE = '888888';

const SHORT_LABELS = new Set(['Default', 'Auto', 'Edits', 'Bypass', 'Plan']);
const FULL_LABELS = new Set(['Default Mode', 'Auto Mode', 'Accept Edits', 'Bypass Permissions', 'Plan Mode']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模式按钮 = footer 里 title 以 "Click to change permission mode" 开头的按钮。
// 只报「可见」的 span —— 被 sm: 断点关掉的那个 span 文字仍然在 textContent 里，
// 必须用 computed display 过滤，否则两个 span 的文字会一起被读到。
const READ_MODE = `(() => {
  const footer = document.querySelector('[data-slot="prompt-input-footer"]');
  if (!footer) return { found: false, reason: 'no composer footer' };
  const btn = [...footer.querySelectorAll('button')].find(
    (b) => (b.getAttribute('title') || '').startsWith('Click to change permission mode')
  );
  if (!btn) {
    return {
      found: false,
      reason: 'no mode button',
      seenTitles: [...footer.querySelectorAll('button')].map((b) => b.getAttribute('title')),
    };
  }
  const spans = [...btn.querySelectorAll('span')].map((s) => ({
    text: s.textContent.trim(),
    display: getComputedStyle(s).display,
  }));
  const visible = spans.filter((s) => s.display !== 'none' && s.text !== '');
  return {
    found: true,
    ariaLabel: btn.getAttribute('aria-label'),
    visibleText: visible.length ? visible[visible.length - 1].text : null,
    visibleCount: visible.length,
    spans,
    footerHeight: Math.round(footer.getBoundingClientRect().height),
  };
})()`;

const CLICK_MODE = `(() => {
  const footer = document.querySelector('[data-slot="prompt-input-footer"]');
  if (!footer) return false;
  const btn = [...footer.querySelectorAll('button')].find(
    (b) => (b.getAttribute('title') || '').startsWith('Click to change permission mode')
  );
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const classify = (text) =>
  SHORT_LABELS.has(text) ? 'short' : FULL_LABELS.has(text) ? 'full' : 'unknown';

async function readMode(page) {
  const state = await page.evaluate(READ_MODE);
  if (state.found) state.kind = classify(state.visibleText);
  return state;
}

async function probeAt(page, width, label) {
  await page.setViewport({ width, height: 812 });
  await sleep(400);
  const states = [];
  for (let i = 0; i < 6; i++) {
    const state = await readMode(page);
    states.push(state);
    if (!state.found) break;
    await page.evaluate(CLICK_MODE);
    await sleep(150);
  }
  const found = states.filter((s) => s.found);
  const labels = [...new Set(found.map((s) => s.visibleText))];
  const kinds = [...new Set(found.map((s) => s.kind))];
  console.log(`\n=== ${label} (${width}px) ===`);
  console.log('  footer 高度        :', found[0] ? found[0].footerHeight : 'n/a');
  console.log('  见过的标签         :', JSON.stringify(labels));
  console.log('  标签种类           :', JSON.stringify(kinds));
  console.log('  aria-label 示例    :', found[0] ? found[0].ariaLabel : 'n/a');
  console.log('  每个模式的两个 span :', JSON.stringify(found[0] ? found[0].spans : null));
  if (found.some((s) => s.visibleCount !== 1)) {
    console.log('  !! 可见 span 数不为 1 :', JSON.stringify(found.map((s) => s.visibleCount)));
  }
  if (found.length === 0) console.log('  !! 探针失败:', JSON.stringify(states[0]));
  return { labels, kinds, footerHeight: found[0] ? found[0].footerHeight : null, found: found.length > 0 };
}

(async () => {
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, code: CODE }),
  });
  const login = await loginRes.json();
  if (!login.token) {
    console.error('登录失败，检查 auth.config.json 里的 email / code:', login);
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.evaluateOnNewDocument((token) => {
    localStorage.setItem('auth-token', token);
  }, login.token);

  await page.setViewport({ width: 375, height: 812 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });

  // 落地页可能是「选一个 provider」空态，此时没有 composer —— 点侧边栏第一个会话。
  if (!(await page.$('[data-slot="prompt-input-footer"]'))) {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('aside button, nav button')].find(
        (b) => b.textContent.trim().length > 0
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log('未直接拿到 composer，尝试点侧边栏会话:', clicked);
    if (clicked) await sleep(2500);
  }
  try {
    await page.waitForSelector('[data-slot="prompt-input-footer"]', { timeout: 20000 });
  } catch {
    console.error('拿不到 composer。当前页面上的 button title 一览：');
    console.error(await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.getAttribute('title'))));
    await browser.close();
    process.exit(3);
  }

  const mobile = await probeAt(page, 375, '手机');
  const sm = await probeAt(page, 640, 'sm 断点');
  const desktop = await probeAt(page, 1280, '桌面');

  // 深色模式再量一次 375
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await probeAt(page, 375, '手机 · 深色');

  await browser.close();

  console.log('\n=== 判定 ===');
  console.log('375px 全是短标签 :', mobile.kinds.every((k) => k === 'short'), JSON.stringify(mobile.kinds));
  console.log('640px 全是完整标签:', sm.kinds.every((k) => k === 'full'), JSON.stringify(sm.kinds));
  console.log('1280px 全是完整标签:', desktop.kinds.every((k) => k === 'full'), JSON.stringify(desktop.kinds));
  console.log('375px footer 高度 :', mobile.footerHeight);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: 跑一遍，记录改动前基线**

```bash
cd /tmp && node /tmp/lovdex-mobile-mode-e2e.cjs
```

改动前的**预期**（这就是要复现的 bug）：

```
375px 全是短标签 : false    ← 此刻 visibleText 全是 null，因为文字被 hidden 藏了
640px 全是完整标签: true
1280px 全是完整标签: true
375px footer 高度 : 记下这个数字，Task 4 要拿它做对比
```

改动前 375px 那一档探针还会打一条 `!! 可见 span 数不为 1`，且 `标签种类` 是 `["unknown"]` —— 这是**预期内的**，正是要修的 bug，不是探针坏了。

判断探针本身是否正常，看 640px / 1280px 两行：它们此刻必须是 `true`。如果 375px 那行此刻就是 `true`，说明探针没抓到真实状态，先排查探针再往下走。

---

## Task 1: 标签映射纯函数（TDD）

**Files:**
- Create: `web/src/components/chat/view/subcomponents/permissionModeLabels.ts`
- Test: `web/src/components/chat/view/subcomponents/permissionModeLabels.test.ts`

- [ ] **Step 1: 先写失败的测试**

创建 `web/src/components/chat/view/subcomponents/permissionModeLabels.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { LABEL_KEYS, getPermissionModeLabelKeys } from './permissionModeLabels';
import type { PermissionMode } from '../../types/types';

// 与 PermissionMode 联合类型保持同步的运行时清单。
// 注意：真正拦住「往联合类型里加了 mode 却忘了补标签」的是 permissionModeLabels.ts
// 里那个 Record<PermissionMode, …> —— 少一个键 typecheck 就红。本清单只保证
// 这份测试自己不会漏测。
const ALL_MODES: PermissionMode[] = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'];

test('every permission mode maps to a short key and a full key', () => {
  for (const mode of ALL_MODES) {
    const { shortKey, fullKey } = getPermissionModeLabelKeys(mode);
    assert.match(shortKey, /^codex\.modesShort\./, `${mode} shortKey`);
    assert.match(fullKey, /^codex\.modes\./, `${mode} fullKey`);
  }
});

test('short keys are distinct from each other and from the full keys', () => {
  const shorts = ALL_MODES.map((m) => getPermissionModeLabelKeys(m).shortKey);
  assert.equal(new Set(shorts).size, ALL_MODES.length, 'short keys must not collide');

  for (const mode of ALL_MODES) {
    const { shortKey, fullKey } = getPermissionModeLabelKeys(mode);
    assert.notEqual(shortKey, fullKey, `${mode} short/full must differ`);
  }
});

test('unknown values fall back to default instead of throwing or returning undefined', () => {
  assert.deepEqual(getPermissionModeLabelKeys('garbage'), LABEL_KEYS.default);
  assert.deepEqual(getPermissionModeLabelKeys(''), LABEL_KEYS.default);
  // 组件 prop 的类型是 PermissionMode | string，所以未知值不是异常路径而是常态。
});

test('LABEL_KEYS covers exactly the modes listed above', () => {
  assert.deepEqual(Object.keys(LABEL_KEYS).sort(), [...ALL_MODES].sort());
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/chat/view/subcomponents/permissionModeLabels.test.ts
```

预期：FAIL，报 `Cannot find module './permissionModeLabels'`。

（`unset TSX_TSCONFIG_PATH` 是必须的 —— 该环境变量全局指向 `server/tsconfig.json`，会劫持 `npx tsx`。）

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/chat/view/subcomponents/permissionModeLabels.ts`：

```ts
import type { PermissionMode } from '../../types/types';

export interface PermissionModeLabelKeys {
  /** i18n key for the narrow-screen (< sm / 640px) label. */
  shortKey: string;
  /** i18n key for the desktop label — unchanged from the pre-existing rendering. */
  fullKey: string;
}

/**
 * `Record<PermissionMode, …>` is deliberate: adding a mode to the union turns a
 * missing entry into a typecheck error, which is the real guard here.
 */
export const LABEL_KEYS: Record<PermissionMode, PermissionModeLabelKeys> = {
  default: { shortKey: 'codex.modesShort.default', fullKey: 'codex.modes.default' },
  auto: { shortKey: 'codex.modesShort.auto', fullKey: 'codex.modes.auto' },
  acceptEdits: { shortKey: 'codex.modesShort.acceptEdits', fullKey: 'codex.modes.acceptEdits' },
  bypassPermissions: {
    shortKey: 'codex.modesShort.bypassPermissions',
    fullKey: 'codex.modes.bypassPermissions',
  },
  plan: { shortKey: 'codex.modesShort.plan', fullKey: 'codex.modes.plan' },
};

/**
 * The composer's `permissionMode` prop is typed `PermissionMode | string` — it can
 * hold a value restored from localStorage before provider capabilities load — so
 * unknown input is an expected path, not an error path. Falling back to `default`
 * guarantees the button always renders a readable label; the previous inline
 * `{mode === 'x' && t(…)}` chain rendered nothing at all for unknown values.
 */
export function getPermissionModeLabelKeys(mode: PermissionMode | string): PermissionModeLabelKeys {
  return LABEL_KEYS[mode as PermissionMode] ?? LABEL_KEYS.default;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/chat/view/subcomponents/permissionModeLabels.test.ts
```

预期：`# pass 4` / `# fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/permissionModeLabels.ts \
        web/src/components/chat/view/subcomponents/permissionModeLabels.test.ts
git commit -m "feat(chat): add permission-mode label key lookup

Pure mapping from PermissionMode to its i18n label keys, with a default
fallback for the unknown values the composer prop can carry. Kept free of
React so it is unit-testable (web tests run without a DOM)."
```

---

## Task 2: i18n 文案

**Files:**
- Modify: `web/src/i18n/locales/en/chat.json`

- [ ] **Step 1: 新增 `codex.modesShort`**

在 `web/src/i18n/locales/en/chat.json` 中，把

```json
      "plan": "Plan Mode"
    },
    "descriptions": {
```

改成

```json
      "plan": "Plan Mode"
    },
    "modesShort": {
      "default": "Default",
      "auto": "Auto",
      "acceptEdits": "Edits",
      "bypassPermissions": "Bypass",
      "plan": "Plan"
    },
    "descriptions": {
```

短标签最长 7 字符（`Default` / `Bypass`），手机上一行放得下。完整文案一个字都不动。

- [ ] **Step 2: 新增 `input.currentMode`**

把

```json
    "clickToChangeMode": "Click to change permission mode (or press Tab in input)",
    "showAllCommands": "Show all commands",
```

改成

```json
    "clickToChangeMode": "Click to change permission mode (or press Tab in input)",
    "currentMode": "Permission mode: {{mode}}",
    "showAllCommands": "Show all commands",
```

`title` 在触屏上不触发，所以模式按钮需要一个 `aria-label` 来兜住可访问性（Task 3 Step 2 接上）。

- [ ] **Step 3: 确认 JSON 合法且 key 齐全**

```bash
cd /mnt/b/workdir/github/lovdex/web
python3 -c "
import json
d = json.load(open('src/i18n/locales/en/chat.json'))
assert set(d['codex']['modesShort']) == {'default','auto','acceptEdits','bypassPermissions','plan'}, d['codex']['modesShort']
assert set(d['codex']['modes']) == set(d['codex']['modesShort'])
assert d['input']['currentMode'] == 'Permission mode: {{mode}}'
print('ok:', d['codex']['modesShort'])
"
```

预期：`ok: {'default': 'Default', 'auto': 'Auto', 'acceptEdits': 'Edits', 'bypassPermissions': 'Bypass', 'plan': 'Plan'}`

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/i18n/locales/en/chat.json
git commit -m "feat(chat): add short permission-mode labels and mode aria-label copy

Narrow screens get short labels (Default / Auto / Edits / Bypass / Plan)
so the composer footer does not wrap; desktop keeps the existing full
copy verbatim."
```

---

## Task 3: ChatComposer 接线

**Files:**
- Modify: `web/src/components/chat/view/subcomponents/ChatComposer.tsx`

> 下面给的行号都取自**未改动的**文件。每做完一步行号会往后移，所以定位一律以给出的**代码内容**为准，不要死认行号。

- [ ] **Step 1: 加 import**

在 `ChatComposer.tsx:37`（`import QueuedMessageCard from './QueuedMessageCard';`）之后加一行：

```tsx
import { getPermissionModeLabelKeys } from './permissionModeLabels';
```

- [ ] **Step 2: 在组件体里算一次标签 key**

在 `ChatComposer.tsx:304`（`      : t('input.send');`）之后、`:306` 的 `return (` 之前插入：

```tsx
  const modeLabels = getPermissionModeLabelKeys(permissionMode);
```

- [ ] **Step 3: 给按钮补 `aria-label`**

把 `ChatComposer.tsx:487` 的

```tsx
              title={t('input.clickToChangeMode')}
```

改成

```tsx
              title={t('input.clickToChangeMode')}
              aria-label={t('input.currentMode', {
                defaultValue: 'Permission mode: {{mode}}',
                mode: t(modeLabels.fullKey),
              })}
```

`title` 保留不动。

- [ ] **Step 4: 拆 span**

把 `ChatComposer.tsx:503-509` 的

```tsx
                <span className="hidden whitespace-nowrap sm:inline">
                  {permissionMode === 'default' && t('codex.modes.default')}
                  {permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
                  {permissionMode === 'auto' && t('codex.modes.auto')}
                  {permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
                  {permissionMode === 'plan' && t('codex.modes.plan')}
                </span>
```

改成

```tsx
                <span className="whitespace-nowrap sm:hidden">{t(modeLabels.shortKey)}</span>
                <span className="hidden whitespace-nowrap sm:inline">{t(modeLabels.fullKey)}</span>
```

**Tailwind 类序说明**：`hidden` 与 `sm:inline` 都作用于 `display`，变体类在样式表中排在基础类之后，所以 `≥640px` 时 `sm:inline` 生效、`<640px` 时 `hidden` 生效 —— 这正是原代码已在用的行为。新加的短标签 span 没有基础 `display` 类，span 默认 `inline`，`<640px` 可见、`≥640px` 被 `sm:hidden` 关掉。

**不要动**：`:477-501` 那段颜色嵌套三元；圆点尺寸 `h-2.5 w-2.5 sm:h-1.5 sm:w-1.5`；`onClick={onModeSwitch}` 的循环切换。

- [ ] **Step 5: typecheck / lint 对比 Task 0 基线**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

预期：与 Task 0 Step 1 记录的条数**完全一致**（零新增）。若新增，多半是 import 顺序（`eslint import-x/order`）—— 把新 import 放到本地组件 import 那一组的末尾即可。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/ChatComposer.tsx
git commit -m "fix(chat): show permission-mode label on narrow screens

The mode button rendered only a bare colored dot below the sm breakpoint
because the label span was hidden there, and the title tooltip never
fires on touch. Split it into mutually exclusive short/full spans so the
mode name is always readable, and add an aria-label carrying the full
name since title is not reachable by touch or keyboard focus alone."
```

---

## Task 4: 浏览器验证

纯 CSS 断点行为，`node:test` 无 DOM 无排版引擎，证明不了实际显隐 —— 必须目视确认。

**Files:** 无（只跑探针；若发现折行超标，回到 Task 3 缩短文案）

- [ ] **Step 1: 重跑探针**

```bash
cd /tmp && node /tmp/lovdex-mobile-mode-e2e.cjs
```

- [ ] **Step 2: 逐条核对**

| 检查 | 期望 |
|---|---|
| `375px 全是短标签` | `true`，且见过的标签 ⊆ {Default, Auto, Edits, Bypass, Plan} |
| `640px 全是完整标签` | `true`，且见过的标签 ⊆ {Default Mode, Auto Mode, Accept Edits, Bypass Permissions, Plan Mode} |
| `1280px 全是完整标签` | `true`（**防回归主断言**：桌面端必须逐字与改动前一致） |
| `可见 span 数` | 每个宽度、每个模式下都恰好 1（探针会在不为 1 时打 `!!`） |
| `aria-label 示例` | 形如 `Permission mode: Default Mode` |
| 深色模式 | 探针能跑完，5 种模式的文字都读得到 |
| 循环切换 | 6 次点击见到的标签**种类数 ≥ 2**（当前 provider 支持几种就几种；claude 5 种、codex 3 种、opencode/qoder 4 种），证明文字跟着模式变 |

- [ ] **Step 3: 核对 footer 折行高度**

对比 Task 0 Step 3 记下的改动前 375px footer 高度：

- 若**未折行**（高度不变）→ 通过。
- 若**折成两行**，高度增长应 **≤ 32px**（一行 `h-8` 按钮的高度）。
- 超过 32px → 短标签还是太长，按顺序试这两招，改完重跑本 Task：
  1. 先缩 `modesShort` 文案（`bypassPermissions` 的 `Bypass` 已是最短候选，其余可试 `Edit` / `Plan` 单数形式），注意同步改 Task 1 的 `LABEL_KEYS` 不受影响、只需改 `en/chat.json` 与探针里的 `SHORT_LABELS`；
  2. 文案已无可缩仍超标，才动布局：把圆点从 `h-2.5 w-2.5 sm:h-1.5 sm:w-1.5` 统一成 `h-1.5 w-1.5`（窄屏少 4px），或给模式按钮加 `max-w-[7rem] truncate`。

- [ ] **Step 4: 目视截图存档**

```bash
cd /tmp && node -e "
const p = require('puppeteer-core');
(async () => {
  const login = await (await fetch('http://127.0.0.1:3188/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'zhiju.huang@sophgo.com', code: '888888' }),
  })).json();
  const b = await p.launch({ executablePath: '/home/zhijuhuang/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await b.newPage();
  await page.evaluateOnNewDocument((t) => localStorage.setItem('auth-token', t), login.token);
  await page.setViewport({ width: 375, height: 812 });
  await page.goto('http://127.0.0.1:5188/', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: '/tmp/mode-label-375.png' });
  await page.setViewport({ width: 1280, height: 900 });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: '/tmp/mode-label-1280.png' });
  await b.close();
  console.log('saved /tmp/mode-label-375.png and /tmp/mode-label-1280.png');
})();
"
```

用 Read 工具看这两张图，确认 375px 下模式按钮上确实有文字、1280px 下与改动前无异。

若截图里是「选一个 provider」空态（没有输入栏），说明落地页没自动进会话 —— 先在浏览器里点一个会话，或直接用 Task 0 探针脚本里的侧边栏兜底逻辑，再重截。

- [ ] **Step 5: 汇报**

把探针输出的「判定」四行 + 两张截图结论贴给用户。此 Task 不产生提交（改动已在 Task 1-3 提交完）。

---

## 完成标准

- [ ] `permissionModeLabels.test.ts` 4 条用例全绿
- [ ] `npm run typecheck` / `npm run lint` 零新增（对比 Task 0 基线）
- [ ] 375px 下模式按钮显示短标签文字，5 种模式各自可辨
- [ ] 640px / 1280px 下显示完整文案，与改动前逐字一致
- [ ] footer 折行高度增长 ≤ 32px
- [ ] 无后端改动，未重启后端
