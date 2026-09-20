# Lovdex 设计 Token 统一（冷石墨·一期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web 前端 1720 处裸 Tailwind 调色板用法、579 处 `dark:` 手工配对、111 处硬编码 hex 全部收敛到单一语义 token 体系，消除背景（暖 hue 44）与组件（冷 hue 220）的双色相家族冲突。

**Architecture:** 以 `src/index.css` 的 CSS 变量为唯一色彩来源，`tailwind.config.js` 把语义变量暴露成工具类；新增一个 `node:test` 守卫测试把"不许出现裸色"变成可执行的约束，然后按目录逐个迁移直到守卫全绿。暗色态由 `.dark` 类切换变量，组件内不再需要任何 `dark:` 前缀。

**Tech Stack:** React 18 + TypeScript + Vite 7 + Tailwind 3.4 + PostCSS；测试用 Node 内置 `node:test` + `tsx`（无 DOM，`renderToStaticMarkup`）。

**Spec:** `docs/superpowers/specs/2026-09-20-design-token-unification-design.md`

---

## 0. 环境与基线

所有命令在 `web/` 目录下执行。

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH   # 仓库全局导出了该变量，会导致 tsx 读错 tsconfig
```

| 项目 | 基线（2026-09-20 实测） |
|---|---|
| 裸调色板类名 | 1717 处 |
| `dark:` 裸色配对 | 579 |
| 硬编码 hex（含 `%23` 编码形式） | 108 |
| `rgb()`/`rgba()` 字面量 | 85 |
| 硬编码 `hsl()` 字面量 | 0 |
| `npm run typecheck` | 0 error |
| `npm run lint` | 0 error / 225 warning |
| 测试 | 496 pass / 0 fail（~2.9s） |

> 上表为**守卫测试口径**（排除 `*.test.tsx?` 与两个豁免目录）。按全仓 grep 会略高（1720 / 111），差异来自测试文件与豁免目录，以守卫为准。

**跑测试的命令**（`package.json` 没有 `test` 脚本，必须显式传文件）：

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | tr '\n' ' ')
```

**验收标准**：任务 16 执行后，上表前三项必须为 0，后三项不得劣化。

---

## 全局映射表

每个迁移任务都按此表执行。**按角色而非按色号映射**——同一色号在不同语境可能映射到不同 token。

| 当前写法（亮/暗配对） | 目标 token | 说明 |
|---|---|---|
| `text-gray-900 dark:text-gray-100` | `text-foreground` | 正文主色 |
| `text-gray-800 dark:text-gray-200` | `text-foreground` | 正文主色 |
| `text-gray-700 dark:text-gray-300` | `text-foreground` | 正文主色 |
| `text-gray-400 dark:text-gray-500` | `text-muted-foreground` | 次要文字（112 处 `text-gray-400`） |
| `text-gray-500 dark:text-gray-400` | `text-muted-foreground` | 次要文字 |
| `text-gray-600 dark:text-gray-400` | `text-muted-foreground` | 次要文字 |
| `bg-white dark:bg-gray-900` | `bg-card` | 卡片/浮层表面 |
| `bg-gray-50 dark:bg-gray-800` | `bg-muted` | 次级填充（chip、代码块、hover） |
| `bg-gray-100 dark:bg-gray-700` | `bg-muted` | 次级填充 |
| `bg-gray-800 dark:bg-gray-800` | `bg-card` | 深色面板 |
| `border-gray-200 dark:border-gray-700` | `border-border` | 边框 |
| `border-gray-300 dark:border-gray-600` | `border-border` | 边框 |
| `text-green-*` / `bg-green-*` | `text-success` / `bg-success/10` | 成功态 |
| `text-amber-*` / `text-yellow-*` / `bg-amber-*` | `text-warning` / `bg-warning/10` | 进行中、警告 |
| `text-red-*` / `bg-red-*` | `text-destructive` / `bg-destructive/10` | 失败、删除 |
| `text-blue-*` / `bg-blue-*`（操作色） | `text-primary` / `bg-primary` | 主操作 |
| `text-violet-*` / `text-purple-*` | 逐处判断 | 强调→`text-primary`；分类→`--chart-*` |

**实心状态标签**用 `bg-success text-success-foreground`；**浅底徽章**用 `bg-success/10 text-success`（默认形态）。

**删除规则**：`X dark:Y` 配对在映射后**整体替换为一个 token**，`dark:` 前缀一并删除。若组件里某处只有 `dark:` 变体而没有亮色对应，说明它是补丁——直接删掉该变体，由 token 承担。

**豁免目录**（守卫测试已排除，不要动）：`components/llm-logo-provider`（品牌色）、`components/terminal`（ANSI 色）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/index.css` | 唯一定义色彩变量的地方 | 重写 `:root` / `.dark` 两个 token 块；清理下游 `!important` 补丁 |
| `tailwind.config.js` | 把变量暴露为工具类 | 新增 `success`/`warning`/`info`/`chart` 色组 |
| `src/design/tokenGuard.test.ts` | 守卫：禁止裸色 | 新建 |
| `src/shared/view/ui/*.tsx` | 共享 UI 原语（Button 等） | 迁移 |
| `src/components/**/*.tsx` | 各功能模块 | 逐目录迁移 |
| `src/components/code-editor/utils/editorStyles.ts` | 编辑器独立主题面（注入 CSS 字符串） | 改用 `var(--*)`，删除 `isDarkMode` 分支 |
| `docs/design-html/2026-09-16-task-panel-redesign/index.html` | 旧暖褐路线设计稿 | 加废弃说明 |

---

## Task 1: 守卫测试（驱动全部后续工作）

**Files:**
- Create: `src/design/tokenGuard.test.ts`

- [ ] **Step 1: 写守卫测试**

创建 `src/design/tokenGuard.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the design token migration. See
 * docs/superpowers/specs/2026-09-20-design-token-unification-design.md
 *
 * Colors must come from semantic tokens (bg-card, text-muted-foreground, ...)
 * and never from the raw Tailwind palette (bg-gray-800, text-blue-500, ...).
 */

/** Content colors, not theme colors — see spec §6.2. */
const EXEMPT_DIRS = [
  join('src', 'components', 'llm-logo-provider'),
  join('src', 'components', 'terminal'),
];

const UTILS =
  'bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret';
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const SHADE = '[0-9]{2,3}';

const RAW_CLASS = new RegExp(`\\b(?:${UTILS})-(?:${PALETTE})-${SHADE}\\b`, 'g');
const DARK_PAIR = new RegExp(`dark:(?:${UTILS})-(?:${PALETTE})-${SHADE}`, 'g');
const HARDCODED_HEX = /#[0-9a-fA-F]{6}\b/g;
const RGB_LITERAL = /\brgba?\(\s*[0-9]/g;

/** Tokens that must exist in both `:root` and `.dark`. */
const THEME_TOKENS = [
  '--background', '--foreground',
  '--card', '--card-foreground',
  '--popover', '--popover-foreground',
  '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground',
  '--accent', '--accent-foreground',
  '--destructive', '--destructive-foreground',
  '--success', '--success-foreground',
  '--warning', '--warning-foreground',
  '--info', '--info-foreground',
  '--border', '--input', '--ring',
];

/** Tokens that are mode-independent and live only in `:root`. */
const ROOT_ONLY_TOKENS = [
  '--radius',
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
  '--chart-6', '--chart-7', '--chart-8', '--chart-9', '--chart-10',
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXEMPT_DIRS.includes(path)) continue;
      sourceFiles(path, acc);
    } else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(path);
    }
  }
  return acc;
}

function matches(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of sourceFiles('src')) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const text of source.match(pattern) ?? []) found.push(`${file}: ${text}`);
  }
  return found;
}

function report(found: string[]): string {
  const sample = found.slice(0, 10).join('\n  ');
  return `${found.length} occurrences, first 10:\n  ${sample}`;
}

test('no raw Tailwind palette classes outside exempt dirs', () => {
  const found = matches(RAW_CLASS);
  assert.equal(found.length, 0, report(found));
});

test('no dark: overrides of raw palette colors', () => {
  const found = matches(DARK_PAIR);
  assert.equal(found.length, 0, report(found));
});

test('no hardcoded hex colors outside exempt dirs', () => {
  const found = matches(HARDCODED_HEX);
  assert.equal(found.length, 0, report(found));
});

test('no rgb()/rgba() literals outside exempt dirs', () => {
  const found = matches(RGB_LITERAL);
  assert.equal(found.length, 0, report(found));
});

test('index.css defines every required token', () => {
  const css = readFileSync(join('src', 'index.css'), 'utf8');
  const darkStart = css.indexOf('.dark');
  assert.ok(darkStart > 0, '.dark block not found in index.css');
  const light = css.slice(0, darkStart);
  const dark = css.slice(darkStart);

  const missing: string[] = [];
  for (const token of THEME_TOKENS) {
    if (!light.includes(`${token}:`)) missing.push(`${token} (light)`);
    if (!dark.includes(`${token}:`)) missing.push(`${token} (dark)`);
  }
  for (const token of ROOT_ONLY_TOKENS) {
    if (!light.includes(`${token}:`)) missing.push(`${token} (root)`);
  }
  assert.deepEqual(missing, [], `missing tokens: ${missing.join(', ')}`);
});
```

- [ ] **Step 2: 跑守卫，确认失败**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/tokenGuard.test.ts
```

Expected: **FAIL**，7 个测试中 3 绿 4 红（此代码已实测验证过）：

| 测试 | 期望结果 |
|---|---|
| no raw Tailwind palette classes | ❌ 1717 |
| no dark: overrides | ❌ 579 |
| no hardcoded hex | ❌ 108 |
| no rgb()/rgba() literals | ❌ 85 |
| no hardcoded hsl() literals | ✅ 0 |
| index.css defines every required token | ❌ 缺失 21 个 token |
| semantic and chart tokens meet WCAG contrast | ✅ 0 失败 |

> **本任务的守卫在代码审查后做过两轮修订**（commits `2682514`、`b0aedf9`）。最终版本比上面代码块多：① 文件遍历放宽到 `.js`/`.jsx`；② hex 正则增加 `%23[0-9a-fA-F]{6}`；③ 新增 hardcoded `hsl()` 检查；④ 失败报告带行号；⑤ 新增**对比度实算断言**（解析 token → HSL→sRGB → WCAG 相对亮度 → 对比度）。**以 `b0aedf9` 的文件内容为准。**
>
> 第 7 项是本任务最有价值的一条：它把"对比度"从人工声称变成算术强制。该断言经过**变异测试验证**——把 `--success` 改成浅色后，测试精确报出 `light: --success on --background = 1.34:1 (needs 4.5:1)`，还原后恢复通过，证明它并非空转。

- [ ] **Step 3: 提交**

```bash
git add src/design/tokenGuard.test.ts
git commit -m "test(design): add guard against raw palette and hardcoded colors"
```

---

## Task 2: Token 体系落地（index.css）

**Files:**
- Modify: `src/index.css:20-130`（`:root` 与 `.dark` 块）

- [ ] **Step 1: 替换 `:root` 的 token 块**

把 `:root` 内**从 `--background` 到 `--nav-input-focus-ring`** 的一整段替换为（原文件中 `--radius` 在 token 之后、`--nav-*` 在 `--radius` 之后，一并包含；其后的 safe-area / mobile-nav / header 三组变量保持不动）：

```css
    --background: 220 20% 98%;
    --foreground: 222 47% 11%;
    --card: 0 0% 100%;
    --card-foreground: 222 47% 11%;
    --popover: 0 0% 100%;
    --popover-foreground: 222 47% 11%;
    --primary: 221 83% 53%;
    --primary-foreground: 210 40% 98%;
    --secondary: 220 18% 96%;
    --secondary-foreground: 222 30% 20%;
    --muted: 220 18% 96%;
    --muted-foreground: 220 10% 46%;
    --accent: 220 18% 96%;
    --accent-foreground: 222 30% 20%;
    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 100%;
    --success: 142 72% 29%;
    --success-foreground: 0 0% 100%;
    --warning: 26 90% 37%;
    --warning-foreground: 0 0% 100%;
    --info: 201 96% 32%;
    --info-foreground: 0 0% 100%;
    --border: 220 16% 91%;
    --input: 220 16% 91%;
    --ring: 221 83% 53%;
    --radius: 0.5rem;

    /* Categorical chart palette — content colors, see spec §6.1 */
    --chart-1: 199 89% 40%;
    --chart-2: 160 84% 33%;
    --chart-3: 173 80% 33%;
    --chart-4: 239 84% 67%;
    --chart-5: 84 81% 34%;
    --chart-6: 258 90% 66%;
    --chart-7: 330 81% 60%;
    --chart-8: 0 84% 60%;
    --chart-9: 26 90% 37%;
    --chart-10: 25 95% 45%;

    /* Nav design tokens */
    --nav-glass-bg: 220 20% 98% / 0.7;
    --nav-glass-blur: 20px;
    --nav-glass-saturate: 1.8;
    --nav-tab-glow: 221 83% 53% / 0.18;
    --nav-tab-ring: 221 83% 53% / 0.10;
    --nav-float-shadow: 0 0% 0% / 0.06;
    --nav-float-ring: 220 16% 91% / 0.5;
    --nav-divider-color: 220 16% 91% / 0.5;
    --nav-input-bg: 220 18% 96% / 0.5;
    --nav-input-focus-ring: 221 83% 53% / 0.22;
```

- [ ] **Step 2: 替换 `.dark` 的 token 块**

把 `.dark` 内从 `--background` 到 `--nav-input-focus-ring` 的一段替换为：

```css
    --background: 222 32% 7%;
    --foreground: 220 20% 94%;
    --card: 222 22% 11%;
    --card-foreground: 220 20% 94%;
    --popover: 222 22% 11%;
    --popover-foreground: 220 20% 94%;
    --primary: 217 91% 60%;
    --primary-foreground: 222 47% 8%;
    --secondary: 222 20% 15%;
    --secondary-foreground: 220 20% 94%;
    --muted: 222 20% 15%;
    --muted-foreground: 220 12% 62%;
    --accent: 222 20% 15%;
    --accent-foreground: 220 20% 94%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 84% 10%;
    --success: 142 76% 42%;
    --success-foreground: 142 76% 10%;
    --warning: 43 96% 56%;
    --warning-foreground: 43 96% 10%;
    --info: 199 89% 48%;
    --info-foreground: 199 89% 10%;
    --border: 222 18% 21%;
    --input: 222 18% 21%;
    --ring: 217 91% 60%;

    /* 图表色暗色态取值，见 spec §6.1 */
    --chart-1: 199 89% 62%;
    --chart-2: 160 84% 55%;
    --chart-3: 173 80% 52%;
    --chart-4: 239 84% 74%;
    --chart-5: 84 81% 60%;
    --chart-6: 258 90% 76%;
    --chart-7: 330 81% 70%;
    --chart-8: 0 84% 68%;
    --chart-9: 43 96% 62%;
    --chart-10: 25 95% 63%;

    /* Nav design tokens — dark overrides */
    --nav-glass-bg: 222 22% 11% / 0.55;
    --nav-glass-blur: 24px;
    --nav-glass-saturate: 1.6;
    --nav-tab-glow: 217 91% 60% / 0.25;
    --nav-tab-ring: 217 91% 60% / 0.15;
    --nav-float-shadow: 0 0% 0% / 0.35;
    --nav-float-ring: 222 18% 21% / 0.3;
    --nav-divider-color: 222 18% 21% / 0.5;
    --nav-input-bg: 222 20% 15% / 0.5;
    --nav-input-focus-ring: 217 91% 60% / 0.25;
```

`--radius` 只定义在 `:root`。`--chart-*` 在**两态都要定义**（亮暗取值不同，见 §6.1）。

- [ ] **Step 3: 跑 token 定义测试**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/tokenGuard.test.ts
```

Expected: `index.css defines every required token` **PASS**；其余 4 个仍然 FAIL（组件尚未迁移）。

- [ ] **Step 4: 提交**

```bash
git add src/index.css
git commit -m "feat(design): replace warm theme tokens with cool graphite scale"
```

---

## Task 3: Tailwind 暴露语义色

**Files:**
- Modify: `tailwind.config.js:19-52`（`theme.extend.colors`）

- [ ] **Step 1: 新增语义色与图表色**

在 `theme.extend.colors` 的 `card` 条目之后追加：

```js
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
          6: "hsl(var(--chart-6))",
          7: "hsl(var(--chart-7))",
          8: "hsl(var(--chart-8))",
          9: "hsl(var(--chart-9))",
          10: "hsl(var(--chart-10))",
        },
```

- [ ] **Step 2: 验证构建通过**

```bash
npm run build 2>&1 | tail -5
```

Expected: 构建成功（`✓ built in ...`），无 Tailwind 报错。

- [ ] **Step 3: 提交**

```bash
git add tailwind.config.js
git commit -m "feat(design): expose success/warning/info/chart tokens to Tailwind"
```

---

## Task 4: 清理 index.css 的下游补丁

**背景**：`index.css` 里有一批 `!important` 规则，是当年为压制组件裸色而写的补丁（如 `.dark .bg-gray-800 textarea`）。组件迁移后这些选择器不再匹配，属死代码。

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: 定位所有裸色补丁**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -nE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/index.css
grep -nE 'rgba?\([0-9]' src/index.css
```

- [ ] **Step 2: 逐条处理**

规则：

1. **选择器里含裸色类名的规则**（如 `.dark .bg-gray-800 textarea { ... }`）——**整条规则删除**。它存在的唯一理由是组件用了 `bg-gray-800`；组件迁移后该选择器永不匹配。
2. **`textarea::placeholder { color: rgb(156 163 175) !important }`** ——改为 `color: hsl(var(--muted-foreground))`，去掉 `!important`（token 已是唯一来源，无需强制覆盖）。`.dark` 变体同理，可合并为一条。
3. **触屏 hover 抑制规则**里的 `.hover\:bg-gray-50:hover` 等选择器——组件迁移后这些类名消失，从选择器列表中删除该行；若整个选择器列表因此为空，删除整条规则。
4. **`@apply accent-blue-600`**（约 393 行）——改为 `@apply accent-primary`。
5. **遮罩类 `rgba(...)`**——一律转成 `hsl()`，因为守卫测试把 `rgb(`/`rgba(` 字面量一律视为硬编码。中性遮罩用 `hsl(0 0% 0% / 0.1)`；带色相的（如 `rgba(35,33,41,0.08)`）用 `hsl(var(--foreground) / 0.08)`。
6. **URL 编码的 hex（约 911 / 922 行）**——`url("data:image/svg+xml,...")` 里的下拉箭头描边写成了 `stroke='%239CA3AF'`（gray-400）和 `stroke='%236B7280'`（gray-500）。这是两个硬编码灰，需替换为 token。SVG data URI 内不能直接用 `hsl(var(--x))`，改用 `currentColor` 并让宿主元素设色，或直接内联一个与新灰阶一致的十六进制值**并在注释里注明它对应哪个 token**（这是守卫的豁免例外，需在该行加 `/* token-exempt */` 说明）。

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/tokenGuard.test.ts 2>&1 | grep -E "^# (pass|fail)"
echo -n "index.css 裸色: "; grep -cE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/index.css
echo -n "index.css rgb: "; grep -cE 'rgba?\([0-9]' src/index.css
```

Expected: `index.css` 的裸色与 `rgb(` 计数**均为 0**（第 3、4 个守卫测试的失败数随之下降，但组件尚未迁移故仍 FAIL）。

- [ ] **Step 4: 提交**

```bash
git add src/index.css
git commit -m "refactor(design): drop index.css patches that existed only to mask raw colors"
```

---

## Task 5: 共享 UI 原语 `src/shared/view/ui/`

**Files:**
- Modify: `src/shared/view/ui/Button.tsx`、`ActionMenu.tsx`、`Queue.tsx`、`Tooltip.tsx`（共 16 处裸色 + Button 的 12 处 rgb 阴影）

**这是全站被引用最多的组件，先做它以验证映射方案。**

- [ ] **Step 1: 列出违规**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/shared/view/ui
grep -rnoE 'rgba?\([0-9][^)]*\)' src/shared/view/ui
```

- [ ] **Step 2: 迁移普通类名**

按全局映射表替换 `ActionMenu.tsx`、`Queue.tsx`、`Tooltip.tsx`、`Button.tsx` 中的普通调色板类名。注意 `Button.tsx:22` 的 `bg-gradient-to-b from-white to-slate-100 text-slate-900` 与 `:26` 的 `dark:border-white/10 dark:from-zinc-800 dark:to-zinc-900 dark:text-zinc-100` —— 这对折叠为：

```tsx
'rounded-xl border border-border bg-gradient-to-b from-card to-muted text-foreground transition-all',
```

`:33` 的 `from-[#5b8cff] to-[#2f5fe0]` 改为：

```tsx
'rounded-xl border border-transparent bg-gradient-to-b from-primary/90 to-primary text-primary-foreground transition-all',
```

- [ ] **Step 3: 迁移 Button 的 3D 阴影色**

`Button.tsx:23-29`（default 变体）与 `:34-40`（品牌变体）的阴影用的是硬编码 hex。改为由 token 推导：

```tsx
// default 变体
'shadow-[0_4px_0_hsl(var(--border)),0_10px_20px_hsl(var(--foreground)/0.08)]',
'hover:-translate-y-0.5 hover:shadow-[0_6px_0_hsl(var(--border)),0_14px_26px_hsl(var(--foreground)/0.12)]',
'active:translate-y-[3px] active:shadow-[0_1px_0_hsl(var(--border)),0_3px_8px_hsl(var(--foreground)/0.08)]',
// 品牌变体
'shadow-[0_4px_0_hsl(var(--primary)),0_12px_24px_hsl(var(--primary)/0.28)]',
'hover:-translate-y-0.5 hover:shadow-[0_6px_0_hsl(var(--primary)),0_16px_30px_hsl(var(--primary)/0.4)]',
'active:translate-y-[3px] active:shadow-[0_1px_0_hsl(var(--primary)),0_3px_8px_hsl(var(--primary)/0.25)]',
```

暗色态的 `dark:shadow-[...]` 变体**整行删除**——`--border` / `--primary` 已随 `.dark` 切换，阴影自动跟随。

- [ ] **Step 4: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/tokenGuard.test.ts 2>&1 | grep -E "^# (pass|fail)"
npm run typecheck
npx tsx --test src/shared/view/ui/Button.test.tsx
```

Expected: Button 的 12 处 rgb 与 shared 的 16 处裸色清零；`Button.test.tsx` 继续通过（它用 `renderToStaticMarkup` 断言类名，若测试断言了旧类名需同步更新）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/view/ui
git commit -m "refactor(design): migrate shared UI primitives to semantic tokens"
```

---

## Task 6: 小目录试点（file-preview / main-content / operators / contexts）

**Files:**
- Modify: `src/components/file-preview/`（8 处）、`src/components/main-content/`（9 处）、`src/components/operators/`（1 处）
- Modify: `src/contexts/ThemeContext.jsx`（2 处 hex）

**`ThemeContext.jsx` 是代码审查发现的漏网文件**：它把 `<meta name="theme-color">` 硬编码为 `#141414`（暗）与 `#f6f4ef`（亮），旁边的注释写着 `hsl(0 0% 8%)` 和 `warm cream`——正是旧 token 的镜像。不改的话，迁移后**浏览器地址栏主题色仍是暖调，与应用脱节**。改为读取 token 值（该文件是 `.jsx`，可用 `getComputedStyle(document.documentElement).getPropertyValue('--background')`，或直接写入新的 `hsl()` 字面量并注释对应 token）。

- [ ] **Step 1: 列出违规并迁移**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/components/file-preview src/components/main-content src/components/operators
grep -nE '#[0-9a-fA-F]{6}' src/contexts/ThemeContext.jsx
```

按全局映射表替换。

- [ ] **Step 2: 验证并跑相关测试**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/file-preview/FilePreviewBody.test.tsx src/components/file-preview/filePreviewTypes.test.ts src/components/operators/operatorSession.test.ts
npm run typecheck
```

Expected: 全 PASS。

- [ ] **Step 3: 提交**

```bash
git add src/components/file-preview src/components/main-content src/components/operators src/contexts/ThemeContext.jsx
git commit -m "refactor(design): migrate file-preview, main-content, operators to tokens"
```

---

## Task 7: `git-panel` 与 `settings`

**Files:**
- Modify: `src/components/git-panel/`（102 处）、`src/components/settings/`（58 处）

- [ ] **Step 1: 列出违规**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/components/git-panel src/components/settings
```

- [ ] **Step 2: 按全局映射表迁移**

注意 git 语义：`text-green-*` 表示新增行、`text-red-*` 表示删除行——映射到 `text-success` / `text-destructive`，**不要**改成 `text-primary` 之类。

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/settings/settingsTabs.test.ts src/components/settings/DatabaseSettingsForm.test.tsx src/components/settings/SettingsPage.test.tsx
npm run typecheck
```

Expected: 全 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/components/git-panel src/components/settings
git commit -m "refactor(design): migrate git-panel and settings to tokens"
```

---

## Task 8: `tasks`

**Files:**
- Modify: `src/components/tasks/`（115 处裸色 + 13 处 rgb）

- [ ] **Step 1: 列出违规**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/components/tasks
grep -rnoE 'rgba?\([0-9][^)]*\)' src/components/tasks
```

- [ ] **Step 2: 按全局映射表迁移**

任务状态色是重点，必须收敛到语义色：进行中→`warning`、成功→`success`、失败→`destructive`。`TaskCard.tsx` / `TaskDetail.tsx` 里的 `#1c3fa8`、`#1a2d5c` 品牌蓝改为 `hsl(var(--primary))`。

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/tasks/taskName.test.ts
npm run typecheck
```

Expected: PASS。若 `tasks` 下还有其他 `.test.ts` 一并跑。

- [ ] **Step 4: 提交**

```bash
git add src/components/tasks
git commit -m "refactor(design): migrate task views to semantic status tokens"
```

---

## Task 9: `sidebar`

**Files:**
- Modify: `src/components/sidebar/`（198 处）

- [ ] **Step 1: 列出违规**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/components/sidebar
```

- [ ] **Step 2: 按全局映射表迁移**

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/stores/useSessionStore.merge.test.ts src/stores/sessionRefresh.test.ts
npm run typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/components/sidebar
git commit -m "refactor(design): migrate sidebar to tokens"
```

---

## Task 10: `file-tree`

**Files:**
- Modify: `src/components/file-tree/`（202 处）

- [ ] **Step 1: 列出违规**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/components/file-tree
```

- [ ] **Step 2: 按全局映射表迁移**

目录树用色区分文件类型（如 `.tsx` 蓝、`.css` 紫）属**分类色**——改用 `text-chart-4` 一类的图表 token，**不要**映射到 `primary`，否则整个树会变成一片蓝。

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npm run typecheck
npx tsx --test src/design/tokenGuard.test.ts 2>&1 | grep -E "^# (pass|fail)"
```

- [ ] **Step 4: 提交**

```bash
git add src/components/file-tree
git commit -m "refactor(design): migrate file tree to tokens"
```

---

## Task 11: `project-creation-wizard`

**Files:**
- Modify: `src/components/project-creation-wizard/`（215 处）

- [ ] **Step 1: 列出违规**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/components/project-creation-wizard
```

- [ ] **Step 2: 按全局映射表迁移**

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npm run typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/components/project-creation-wizard
git commit -m "refactor(design): migrate project creation wizard to tokens"
```

---

## Task 12: `chat`（最大单块，652 处）

**Files:**
- Modify: `src/components/chat/view/`（199 处）、`src/components/chat/tools/`（451 处）、`src/components/chat/hooks/`（2 处）

**建议拆成三个提交**：`view/` → `tools/components/` → `tools/configs` + `hooks`。

- [ ] **Step 1: 列出违规（按子目录）**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
for d in src/components/chat/view src/components/chat/tools/components src/components/chat/tools/configs src/components/chat/hooks; do
  echo "$d: $(grep -rhoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" "$d" --include=*.ts --include=*.tsx | wc -l)"
done
```

- [ ] **Step 2: 迁移 `chat/view/`**

工具调用卡片、消息气泡、输入框。`ChatComposer.tsx` 的 textarea 占位符色现在靠 `index.css` 补丁压制（Task 4 已删），此处必须显式补上 `placeholder:text-muted-foreground`。

- [ ] **Step 3: 迁移 `chat/tools/`**

`InteractiveRenderers/`（132 处）与 `ContentRenderers/`（129 处）是工具结果渲染器，含大量状态色——按语义收敛（成功/警告/失败）。终端输出类渲染保留等宽字体但不改色。

- [ ] **Step 4: 验证**

```bash
unset TSX_TSCONFIG_PATH
npm run typecheck
npx tsx --test src/design/tokenGuard.test.ts 2>&1 | grep -E "^# (pass|fail)"
```

- [ ] **Step 5: 提交**

```bash
git add src/components/chat/view
git commit -m "refactor(design): migrate chat view to tokens"
git add src/components/chat/tools src/components/chat/hooks
git commit -m "refactor(design): migrate chat tool renderers to tokens"
```

---

## Task 13: `code-editor` 外壳与 code-editor 主题面

**Files:**
- Modify: `src/components/code-editor/`（130 处）
- Modify: `src/components/code-editor/utils/editorStyles.ts`（6 处 rgb + 20+ 处 hex）

**注意**：该目录的 130 处**全是编辑器外壳**（头部、标签页、边框、背景），**不含语法色**——语法高亮来自第三方 `react-syntax-highlighter` 的 `oneDark`/`oneLight` 主题，不在本项目 CSS 内，不要动。

- [ ] **Step 1: 迁移外壳类名**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
grep -rnoE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src/components/code-editor
```

按全局映射表替换。

- [ ] **Step 2: 改 `editorStyles.ts` 用 CSS 变量**

该文件是注入 CodeMirror 的 CSS 字符串，无法用 Tailwind 类。把所有 `isDarkMode ? '#xxx' : '#yyy'` 三元**替换为单一 `var(--*)`**，并删除 `isDarkMode` 参数与调用处传参。

对照表：

| 旧（亮/暗） | 新 |
|---|---|
| `#ffffff` / `#111827` | `var(--card)` |
| `#f5f5f5` / `#1e1e1e` | `var(--muted)` |
| `#ffffff` / `#1f2937` | `var(--card)` |
| `#e5e7eb` / `#374151` | `var(--border)` |
| `#374151` / `#d1d5db` | `var(--foreground)` |
| `#f3f4f6` / `#374151` | `var(--muted)` |
| `rgba(239,68,68,0.15)` / `rgba(255,235,235,1)` | `hsl(var(--destructive) / 0.15)` |
| `rgb(239,68,68)` | `hsl(var(--destructive))` |
| `rgba(34,197,94,0.15)` / `rgba(230,255,237,1)` | `hsl(var(--success) / 0.15)` |
| `rgb(34,197,94)` | `hsl(var(--success))` |

`editorExtensions.ts:95` 的 `rgba(34, 197, 94, 0.8)` / `rgba(34, 197, 94, 1)` 同样改为 `hsl(var(--success) / 0.8)` / `hsl(var(--success))`，并删除 `isDarkMode` 分支。

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
grep -n "isDarkMode" src/components/code-editor/utils/editorStyles.ts src/components/code-editor/utils/editorExtensions.ts
npm run typecheck
npx tsx --test src/design/tokenGuard.test.ts 2>&1 | grep -E "^# (pass|fail)"
```

Expected: `isDarkMode` 在 `editorStyles.ts` 中不再出现；typecheck 通过。

- [ ] **Step 4: 提交**

```bash
git add src/components/code-editor
git commit -m "refactor(design): drive code editor chrome from CSS variables"
```

---

## Task 14: 旧设计稿标记废弃

**Files:**
- Modify: `docs/design-html/2026-09-16-task-panel-redesign/index.html`

- [ ] **Step 1: 在文件顶部加说明**

在 `<head>` 之后紧接着插入：

```html
<!--
  DEPRECATED (2026-09-20)
  This mockup uses a warm-brown palette (#3f3a31 / #faf9f4 / #7c3aed) that
  conflicts with the cool-graphite direction adopted in
  docs/superpowers/specs/2026-09-20-design-token-unification-design.md
  Do not copy colors from this file. Layout ideas are still valid.
-->
```

- [ ] **Step 2: 提交**

```bash
git add docs/design-html/2026-09-16-task-panel-redesign/index.html
git commit -m "docs(design): mark warm-palette mockup as deprecated"
```

---

## Task 15: 全量验证

- [ ] **Step 1: 守卫测试必须全绿**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/tokenGuard.test.ts
```

Expected: **5 pass / 0 fail**。

- [ ] **Step 2: 独立复核三个为零的指标**

```bash
cd /mnt/b/workdir/github/lovdex/web
UT='bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret'
PA='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
echo -n "裸色: "; grep -rE "\\b($UT)-($PA)-[0-9]{2,3}\\b" src --include=*.ts --include=*.tsx --include=*.css | grep -vE 'llm-logo-provider|components/terminal' | wc -l
echo -n "dark:配对: "; grep -rhoE "dark:($UT)-($PA)-[0-9]{2,3}" src --include=*.ts --include=*.tsx | wc -l
echo -n "hex: "; grep -rhoE '#[0-9a-fA-F]{6}\b' src --include=*.ts --include=*.tsx | wc -l
echo -n "rgb字面量: "; grep -rhoE 'rgba?\([0-9][^)]*\)' src --include=*.ts --include=*.tsx --include=*.css | wc -l
```

Expected: 四个数字**全为 0**。

- [ ] **Step 3: 类型检查 / lint / 全量测试不得劣化**

```bash
unset TSX_TSCONFIG_PATH
npm run typecheck                                    # 期望 0 error
npm run lint 2>&1 | tail -3                          # 期望 0 error，warning ≤ 225
npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | tr '\n' ' ') 2>&1 | tail -8
```

Expected: typecheck 0 error；lint 0 error / warning ≤ 225；测试 496+ pass / 0 fail。

- [ ] **Step 4: 构建**

```bash
npm run build 2>&1 | tail -5
```

Expected: 构建成功。

- [ ] **Step 5: 亮/暗两态视觉回归**

启动 dev server（注意仓库的 supervisor 会拉起前端）：

```bash
npm run dev
```

用 `http://<本机IP>:5188` 访问（不要用 localhost，手机/远程访问场景需要 IP）。逐个核对四个主场景在**亮色与暗色**下：

1. **任务板** — 状态标签的三种语义色能区分；卡片不再是"脏"的暖底冷灰
2. **聊天** — 消息气泡层次清楚；输入框占位符可见；工具调用卡片焦点态正常
3. **侧边栏** — hover / 选中态可辨；分隔线在两种模式下都可见
4. **设置** — 表单边框与禁用态可辨

暗色切换方式由应用内的主题开关控制（`.dark` 类挂在根元素）。发现任何对比度不足或元素"消失"，回到对应任务修正。

- [ ] **Step 6: 最终提交**

```bash
git add -A
git commit -m "test(design): verify token unification guard passes end to end"
```

---

## 自查记录

**Spec 覆盖**：§4 token 体系 → Task 2/3；§5 语义色规则 → Task 2/3 + 全局映射表；§6.1 图表色 → Task 2/3；§6.2 豁免区 → Task 1 守卫的 `EXEMPT_DIRS`；§6.3 编辑器主题面 → Task 13；§7 迁移映射 → 全局映射表 + Task 5–13；§8 验收标准 → Task 15；§9 分期 → 本计划仅含一期，二期未展开。

**已知偏差**：spec §8 第 3 条把硬编码 hex 的豁免限定为 `llm-logo-provider` 与 `terminal`；本计划把 `stats` 的图表色通过 Task 2/3 转成 `--chart-*` 而非豁免，因此 `stats` 也必须清零。守卫测试已按此实现。
