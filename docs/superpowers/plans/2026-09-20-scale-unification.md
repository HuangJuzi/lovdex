# Lovdex 尺度统一实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把圆角、字号、阴影各自收敛为单一具名刻度，消灭 187 处任意值，并加守卫防止回潮——**不改变任何渲染结果**（除 8 处字号吸附）。

**Architecture:** 三个刻度都定义在 `tailwind.config.js`（`borderRadius` 全部改为由 `--radius` 派生、新增 `fontSize`、新增 5 个 `boxShadow` 配方）。新增 `src/design/scaleGuard.test.ts` 把"禁止任意值"变成可执行约束，然后按维度迁移直到守卫全绿。颜色 token（一期）不动。

**Tech Stack:** Tailwind 3.4 + React 18 + TypeScript；测试用 Node 内置 `node:test` + `tsx`（无 DOM）。

**Spec:** `docs/superpowers/specs/2026-09-20-scale-unification-design.md`

---

## 0. 环境与基线

所有命令在 `web/` 下执行。

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH   # 仓库全局导出了该变量，会让 tsx 读错 tsconfig
```

| 项目 | 基线（2026-09-20 实测） |
|---|---|
| `text-[…px]` 任意字号 | 153 处 / 52 文件 |
| `rounded-[…]` 任意圆角 | 3 处（`[3px]` ×2、`[inherit]` ×1） |
| `index.css` 硬编码 `border-radius` | **6 处**（`index.css` 5 + `editorStyles.ts` 1） |
| 5 种重复 3D 阴影配方（内联） | 27 处 / 13 文件 |
| `npm run typecheck` | 0 error |
| `npm run lint` | 0 error / 225 warning |
| 测试 | 512 pass / 0 fail |

**跑测试：**（`package.json` 无 `test` 脚本，必须显式传文件）

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | tr '\n' ' ')
```

---

## 全局映射表

### 圆角（全部由 `--radius` 派生，渲染值不变）

| 当前写法 | 目标 | 渲染值 |
|---|---|---|
| `rounded` | 不变（来源改为 token） | 4px |
| `rounded-sm` / `md` / `lg` / `xl` / `2xl` / `3xl` / `full` / `none` | 不变 | 4/6/8/12/16/24/9999/0 |
| `rounded-[3px]` | `rounded-xs` | 3px |
| `rounded-[inherit]` | **保留**（继承语义，非尺寸） | — |
| 方向性 `rounded-r`、`rounded-t-lg`、`rounded-br-md` 等 | 尺寸部分按上表；方向前缀不变 | — |
| `index.css` 的 `border-radius: 3px/4px/8px` | 见 Task 3 Step 3 | — |

### 字号

| 当前写法 | 目标 | 渲染值 |
|---|---|---|
| `text-sm` 430 / `text-xs` 329 / `text-base` 11 / `text-lg` 20 / `text-xl` 4 | 不变 | 14/12/16/18/20px |
| `text-[11px]` | `text-2xs` | 11px |
| `text-[10px]` | `text-3xs` | 10px |
| `text-[9px]` | `text-4xs` | 9px |
| `text-[12px]` | `text-xs` | 12px |
| `text-[14px]` | `text-sm` | 14px |
| `text-[13px]` | `text-sm` | 14px（**吸附，+1px**） |
| `text-[10.5px]` | `text-2xs` | 11px（**吸附，+0.5px**） |

### 阴影（仅命名，取值逐字不变）

| 当前内联值 | 目标类名 |
|---|---|
| `shadow-[0_2px_0_hsl(var(--foreground)/0.10),0_4px_10px_hsl(var(--foreground)/0.06)]` | `shadow-raised-sm` |
| `shadow-[0_3px_0_hsl(var(--foreground)/0.07),0_12px_26px_hsl(var(--foreground)/0.07)]` | `shadow-raised` |
| `shadow-[0_2px_0_hsl(var(--primary))]` | `shadow-pressed` |
| `shadow-[0_2px_0_hsl(var(--foreground)/0.08)]` | `shadow-raised-xs` |
| `shadow-[0_3px_0_hsl(var(--foreground)/0.08),0_6px_16px_hsl(var(--foreground)/0.07)]` | `shadow-raised-md` |

**其余 `shadow-[…]` 一次性配方（13 处）保持内联**，spec §6.2 已说明理由。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `tailwind.config.js` | 三个刻度的唯一定义处 | 改 `borderRadius`，新增 `fontSize` 与 `boxShadow` |
| `src/design/scaleGuard.test.ts` | 守卫：禁止任意值 | 新建 |
| `src/index.css` + `editorStyles.ts` | 6 处硬编码 `border-radius` | 改为 token 表达式 |
| `src/**/*.tsx` | 消费方 | 按映射表替换类名 |

---

## Task 1: 尺度守卫（驱动全部后续工作）

**Files:**
- Create: `src/design/scaleGuard.test.ts`

- [ ] **Step 1: 写守卫测试**

创建 `src/design/scaleGuard.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the scale unification (radius / font-size / shadow).
 * See docs/superpowers/specs/2026-09-20-scale-unification-design.md
 *
 * Scales must come from the named steps in tailwind.config.js, never from
 * arbitrary values. Arbitrary values are exactly how the scale drifted last
 * time: 153 font sizes and 40 shadows accumulated one inline value at a time.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, acc);
    } else if (
      /\.(ts|tsx|css|js|jsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      acc.push(path);
    }
  }
  return acc;
}

function matches(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of sourceFiles('src')) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push(`${file}:${line}: ${match[0]}`);
    }
  }
  return found;
}

function report(found: string[]): string {
  const sample = found.slice(0, 10).join('\n  ');
  return `${found.length} occurrences, first 10:\n  ${sample}`;
}

const ARBITRARY_FONT_SIZE = /\btext-\[[0-9.]+px\]/g;
const ARBITRARY_RADIUS = /\brounded(?:-[a-z]+)*-\[([^\]]+)\]/g;
const HARDCODED_BORDER_RADIUS = /border-radius:\s*[0-9]/g;

// The five recurring 3D recipes, matched as EXACT strings. A prefix pattern
// like `shadow-[0_[23]px_0_` would also catch two one-off recipes that merely
// share the `0 3px 0` start (they end in 24px/60px and 8px/18px spreads) --
// those are deliberately NOT named, so a prefix pattern would make this test
// impossible to pass. See spec §1.3.
const RECURRING_SHADOW_RECIPES = [
  'shadow-[0_2px_0_hsl(var(--foreground)/0.10),0_4px_10px_hsl(var(--foreground)/0.06)]',
  'shadow-[0_3px_0_hsl(var(--foreground)/0.07),0_12px_26px_hsl(var(--foreground)/0.07)]',
  'shadow-[0_2px_0_hsl(var(--primary))]',
  'shadow-[0_2px_0_hsl(var(--foreground)/0.08)]',
  'shadow-[0_3px_0_hsl(var(--foreground)/0.08),0_6px_16px_hsl(var(--foreground)/0.07)]',
];

/** Finds inlined occurrences of the recurring recipes, with line numbers. */
function findInlineRecipes(source: string): string[] {
  const found: string[] = [];
  for (const recipe of RECURRING_SHADOW_RECIPES) {
    let from = 0;
    for (;;) {
      const at = source.indexOf(recipe, from);
      if (at < 0) break;
      found.push(`line ${source.slice(0, at).split('\n').length}: ${recipe}`);
      from = at + recipe.length;
    }
  }
  return found;
}

test('no arbitrary font sizes', () => {
  const found = matches(ARBITRARY_FONT_SIZE);
  assert.equal(found.length, 0, report(found));
});

test('no arbitrary radius values (rounded-[inherit] is allowed)', () => {
  const found = matches(ARBITRARY_RADIUS).filter((hit) => !hit.includes('[inherit]'));
  assert.equal(found.length, 0, report(found));
});

test('no hardcoded border-radius in CSS', () => {
  const found = matches(HARDCODED_BORDER_RADIUS);
  assert.equal(found.length, 0, report(found));
});

test('the recurring 3D shadow recipes are named, not inlined', () => {
  const failures: string[] = [];
  for (const file of sourceFiles('src')) {
    const source = readFileSync(file, 'utf8');
    for (const hit of findInlineRecipes(source)) failures.push(`${file}:${hit}`);
  }
  assert.equal(failures.length, 0, report(failures));
});
```

- [ ] **Step 2: 跑守卫，确认失败**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/scaleGuard.test.ts
```

Expected: **4 个测试全挂**，计数如下（已实测）：

| 测试 | 期望失败数 |
|---|---|
| no arbitrary font sizes | 153 |
| no arbitrary radius values | 2 |
| no hardcoded border-radius in CSS | 6 |
| recurring 3D shadow recipes inlined | 27 |

若数字与上表不符，**停下来报告**，不要调整断言。

- [ ] **Step 3: 提交**

```bash
git add src/design/scaleGuard.test.ts
git commit -m "test(design): guard radius, font-size and shadow against arbitrary values"
```

---

## Task 2: 三个刻度落地（tailwind.config.js）

**Files:**
- Modify: `tailwind.config.js`（`theme.extend` 内）

- [ ] **Step 1: 替换 `borderRadius`**

把现有的三档定义整体替换为：

```js
      borderRadius: {
        DEFAULT: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 5px)",
        sm: "calc(var(--radius) - 4px)",
        md: "calc(var(--radius) - 2px)",
        lg: "var(--radius)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) * 2)",
        "3xl": "calc(var(--radius) * 3)",
        full: "9999px",
      },
```

`--radius` 保持 `0.5rem` 不变。`DEFAULT` 与 `sm` 同值同源（都是 `calc(var(--radius) - 4px)`），消除了"一个来自框架默认、一个来自 token"的问题。

- [ ] **Step 2: 新增 `fontSize`**

在 `theme.extend` 内新增（**不设 `lineHeight`**——当前用法都未指定行高，设了会改观感）：

```js
      fontSize: {
        "4xs": "9px",
        "3xs": "10px",
        "2xs": "11px",
        xs: "12px",
        sm: "14px",
        base: "16px",
        lg: "18px",
        xl: "20px",
      },
```

显式写出 `xs`/`sm`/`base`/`lg`/`xl` 的 Tailwind 默认值，是为了让刻度表在一处可见。

- [ ] **Step 3: 新增 5 个 `boxShadow` 配方**

在 `theme.extend` 内新增（取值与现有内联值**逐字一致**）：

```js
      boxShadow: {
        "raised-xs": "0 2px 0 hsl(var(--foreground) / 0.08)",
        "raised-sm":
          "0 2px 0 hsl(var(--foreground) / 0.10), 0 4px 10px hsl(var(--foreground) / 0.06)",
        "raised-md":
          "0 3px 0 hsl(var(--foreground) / 0.08), 0 6px 16px hsl(var(--foreground) / 0.07)",
        raised:
          "0 3px 0 hsl(var(--foreground) / 0.07), 0 12px 26px hsl(var(--foreground) / 0.07)",
        pressed: "0 2px 0 hsl(var(--primary))",
      },
```

- [ ] **Step 4: 验证刻度真实生成**

`npm run build` 成功**不能**证明刻度生效（Tailwind 只产出被用到的类）。用 CLI 探针验证：

```bash
cat > /tmp/scale-probe.html <<'EOF'
<div class="rounded-xs rounded-2xl rounded-3xl rounded text-4xs text-2xs text-xs shadow-raised-xs shadow-raised-sm shadow-raised-md shadow-raised shadow-pressed"></div>
EOF
npx tailwindcss -c tailwind.config.js --content /tmp/scale-probe.html -o /tmp/scale-probe.css
grep -oE '\.(rounded-xs|rounded-2xl|rounded-3xl|rounded|text-4xs|text-2xs|shadow-raised-sm|shadow-pressed)\b' /tmp/scale-probe.css | sort -u
rm -f /tmp/scale-probe.html /tmp/scale-probe.css
```

Expected: 上面每个类名都出现在输出里。**特别确认 `rounded-xs` 解析为 `calc(var(--radius) - 5px)`、`text-2xs` 为 `11px`、`shadow-raised-sm` 含两段阴影。**

- [ ] **Step 5: 跑构建与既有测试**

```bash
npm run build 2>&1 | tail -3
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/scaleGuard.test.ts 2>&1 | grep -E "^# (pass|fail)"
```

Expected: 构建成功；守卫仍 4 挂（消费方尚未迁移）。

- [ ] **Step 6: 提交**

```bash
git add tailwind.config.js
git commit -m "feat(design): define radius, font-size and shadow scales"
```

---

## Task 3: 迁移圆角（8 处）

**Files:**
- Modify: `src/components/chat/tools/components/ContentRenderers/QuestionAnswerContent.tsx:140,172`
- Modify: `src/index.css:377,395,414,875,1020`
- Modify: `src/components/code-editor/utils/editorStyles.ts:61`

- [ ] **Step 1: 迁移任意值圆角**

`QuestionAnswerContent.tsx` 第 140、172 行各有一处 `rounded-[3px]`，改为 `rounded-xs`。两处上下文相同（多选框方角）：

```tsx
// 前
${q.multiSelect ? 'rounded-[3px]' : 'rounded-full'}
// 后
${q.multiSelect ? 'rounded-xs' : 'rounded-full'}
```

`src/shared/view/ui/ScrollArea.tsx:13` 的 `rounded-[inherit]` **保持不动**（继承语义，守卫已豁免）。

- [ ] **Step 2: 核对圆角渲染值未变**

```bash
cd /mnt/b/workdir/github/lovdex/web
grep -nE 'rounded(-[a-z]+)*-\[[^]]+\]' src --include=*.tsx
```

Expected: 只剩 `ScrollArea.tsx:13` 的 `rounded-[inherit]`。

- [ ] **Step 3: 迁移 6 处硬编码 `border-radius`**

**注意是 6 处不是 5 处**——守卫的基线口径包含 `.ts` 文件，因为 `editorStyles.ts` 用模板字符串注入了 CSS，纯 `--include=*.css` 的 grep 看不见它。

```bash
grep -rnB3 -E 'border-radius:\s*[0-9]' src --include=*.css --include=*.ts --include=*.tsx | grep -v '\.test\.'
```

按渲染值对应到刻度：

| 文件:行 | 当前值 | 改为 |
|---|---|---|
| `src/index.css:377` | `3px` | `calc(var(--radius) - 5px)`（= `rounded-xs`） |
| `src/index.css:395` | `3px` | 同上 |
| `src/index.css:414` | `4px` | `calc(var(--radius) - 4px)`（= `rounded-sm`） |
| `src/index.css:875` | `3px` | 同上 `xs` |
| `src/index.css:1020` | `8px` | `var(--radius)`（= `rounded-lg`） |
| `src/components/code-editor/utils/editorStyles.ts:61` | `4px` | `calc(var(--radius) - 4px)`（= `rounded-sm`） |

`editorStyles.ts:61` 位于 CodeMirror 的 `.cm-diff-nav-btn, .cm-toolbar-btn` 规则内。该文件是**注入的 CSS 模板字符串**，写法与 `index.css` 相同（都是 CSS 声明），但注意里面的 `var(--…)` 必须包在 `hsl()` 里才合法——那是颜色 token 的规则，**本条是 `border-radius`，直接用 `calc()`/`var()` 即可，不要包 `hsl()`**。

**用 `calc()`/`var()` 而非 `var(--radius-xs)`**——本项目未定义 `--radius-xs` 这类独立变量，刻度的派生表达式写在 `tailwind.config.js` 里；CSS 里直接写等价表达式，并在每行上方加注释注明它对应哪个档位（例如 `/* = rounded-xs */`），避免下次有人改 `--radius` 时漏掉。

- [ ] **Step 4: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/scaleGuard.test.ts 2>&1 | grep -E "^# (pass|fail)|not ok"
npm run typecheck
npm run build 2>&1 | tail -3
```

Expected: 守卫的 `no arbitrary radius values` 与 `no hardcoded border-radius in CSS` 两条转 **PASS**（另两条仍挂）。typecheck 与构建通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/chat/tools/components/ContentRenderers/QuestionAnswerContent.tsx src/index.css
git commit -m "refactor(design): migrate radius values onto the named scale"
```

---

## Task 4: 迁移字号（153 处 / 52 文件）

**Files:**
- Modify: `src/**/*.tsx`（52 个文件，见下表）

这是本计划最大的一块，但**纯粹是字符串替换**——每个 `text-[Npx]` 对应一个固定目标，无需逐处判断。

- [ ] **Step 1: 按映射表替换**

| 当前 | 目标 | 处数 |
|---|---|---|
| `text-[11px]` | `text-2xs` | 82 |
| `text-[10px]` | `text-3xs` | 49 |
| `text-[9px]` | `text-4xs` | 10 |
| `text-[13px]` | `text-sm` | 7 |
| `text-[12px]` | `text-xs` | 3 |
| `text-[14px]` | `text-sm` | 1 |
| `text-[10.5px]` | `text-2xs` | 1 |

用精确字符串替换（**不要用正则匹配数字**，否则会把 `text-[10px]` 误伤成 `text-1xs`）：

```bash
cd /mnt/b/workdir/github/lovdex/web
FILES=$(grep -rlE 'text-\[[0-9.]+px\]' src --include=*.tsx)
for f in $FILES; do
  sed -i \
    -e 's/text-\[11px\]/text-2xs/g' \
    -e 's/text-\[10px\]/text-3xs/g' \
    -e 's/text-\[9px\]/text-4xs/g' \
    -e 's/text-\[13px\]/text-sm/g' \
    -e 's/text-\[12px\]/text-xs/g' \
    -e 's/text-\[14px\]/text-sm/g' \
    -e 's/text-\[10\.5px\]/text-2xs/g' \
    "$f"
done
```

**注意替换顺序无关**（每个模式都带完整方括号，`text-[10px]` 与 `text-[10.5px]` 不会互相误伤）。

- [ ] **Step 2: 确认替换彻底**

```bash
echo -n "剩余任意字号: "; grep -rhoE 'text-\[[0-9.]+px\]' src --include=*.tsx | wc -l
echo "=== 新类名的使用量 ==="
grep -rhoE '\btext-(2xs|3xs|4xs)\b' src --include=*.tsx | sort | uniq -c
```

Expected: 剩余 **0**；`text-2xs` 83、`text-3xs` 49、`text-4xs` 10。

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/scaleGuard.test.ts 2>&1 | grep -E "^# (pass|fail)|not ok"
npm run typecheck
npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `no arbitrary font sizes` 转 **PASS**；typecheck 0 error；测试全绿。

**若有测试断言了旧的 `text-[Npx]` 类名而失败**：只更新颜色/尺寸类名断言，**不得删改结构性断言**，并在报告中列出改了哪些。

- [ ] **Step 4: 提交**

```bash
git add src
git commit -m "refactor(design): migrate font sizes onto the named scale"
```

---

## Task 5: 迁移阴影配方（27 处 / 13 文件）

**Files:**
- Modify: 13 个文件（`tasks/` 7 个、`shared/view/ui/` 3 个、`sidebar/` 3 个、`main-content/` 1 个）

- [ ] **Step 1: 按映射表替换**

| 当前内联值 | 目标类名 | 处数 |
|---|---|---|
| `shadow-[0_2px_0_hsl(var(--foreground)/0.10),0_4px_10px_hsl(var(--foreground)/0.06)]` | `shadow-raised-sm` | 9 |
| `shadow-[0_3px_0_hsl(var(--foreground)/0.07),0_12px_26px_hsl(var(--foreground)/0.07)]` | `shadow-raised` | 6 |
| `shadow-[0_2px_0_hsl(var(--primary))]` | `shadow-pressed` | 5 |
| `shadow-[0_2px_0_hsl(var(--foreground)/0.08)]` | `shadow-raised-xs` | 4 |
| `shadow-[0_3px_0_hsl(var(--foreground)/0.08),0_6px_16px_hsl(var(--foreground)/0.07)]` | `shadow-raised-md` | 3 |

**注意**：源文件里这些值写在 Tailwind 任意值语法中，空格被替换为下划线，但**斜杠与百分号保持原样**。替换前先看一处真实写法确认格式：

```bash
cd /mnt/b/workdir/github/lovdex/web
grep -oE 'shadow-\[0_2px_0_hsl\(var\(--foreground\)[^]]*\]' src/components/tasks/TaskCard.tsx | head -3
```

**逐文件替换，不要全局 sed**——这 5 个模式有前缀包含关系（`shadow-[0_2px_0_hsl(var(--foreground)/0.08)]` 是 `shadow-[0_2px_0_hsl(var(--foreground)/0.08),0_6px_16px_…]` 的前缀），长模式必须先替换：

```bash
FILES=$(grep -rlE 'shadow-\[0_[23]px_0_' src --include=*.tsx)
for f in $FILES; do
  # 长模式优先，避免前缀误伤
  sed -i \
    -e 's|shadow-\[0_3px_0_hsl(var(--foreground)/0.08),0_6px_16px_hsl(var(--foreground)/0.07)\]|shadow-raised-md|g' \
    -e 's|shadow-\[0_3px_0_hsl(var(--foreground)/0.07),0_12px_26px_hsl(var(--foreground)/0.07)\]|shadow-raised|g' \
    -e 's|shadow-\[0_2px_0_hsl(var(--foreground)/0.10),0_4px_10px_hsl(var(--foreground)/0.06)\]|shadow-raised-sm|g' \
    -e 's|shadow-\[0_2px_0_hsl(var(--foreground)/0.08)\]|shadow-raised-xs|g' \
    -e 's|shadow-\[0_2px_0_hsl(var(--primary))\]|shadow-pressed|g' \
    "$f"
done
```

**若某处实际写法与上表不完全一致**（空格/斜杠格式差异），该处不会被替换——替换后按 Step 2 检查，逐一手工处理，不要放宽 sed 模式去猜。

- [ ] **Step 2: 确认替换彻底**

```bash
cd /mnt/b/workdir/github/lovdex/web
echo -n "剩余重复配方（精确匹配 5 个完整串）: "
for r in \
  'shadow-\[0_2px_0_hsl(var(--foreground)/0.10),0_4px_10px_hsl(var(--foreground)/0.06)\]' \
  'shadow-\[0_3px_0_hsl(var(--foreground)/0.07),0_12px_26px_hsl(var(--foreground)/0.07)\]' \
  'shadow-\[0_2px_0_hsl(var(--primary))\]' \
  'shadow-\[0_2px_0_hsl(var(--foreground)/0.08)\]' \
  'shadow-\[0_3px_0_hsl(var(--foreground)/0.08),0_6px_16px_hsl(var(--foreground)/0.07)\]' ; do
  grep -rhoE "$r" src --include=*.tsx | wc -l
done | paste -sd+ | bc
echo -n "新类名使用: "; grep -rhoE '\bshadow-(raised(-xs|-sm|-md)?|pressed)\b' src --include=*.tsx | sort | uniq -c
echo "=== 一次性配方（应保留 13 处）==="
grep -rhoE 'shadow-\[[^]]+\]' src --include=*.tsx | wc -l
```

Expected: 剩余 **0**；新类名合计 **27**；一次性配方 **13**（40 − 27）。

> **不要用 `shadow-\[0_[23]px_0_` 这类前缀模式核对**——它会多算 2 处一次性配方（共 29），让你误以为还有残留。

- [ ] **Step 3: 验证**

```bash
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/scaleGuard.test.ts 2>&1 | tail -12
npm run typecheck
npm run build 2>&1 | tail -3
```

Expected: **守卫 4 个测试全 PASS**。typecheck 0 error，构建成功。

- [ ] **Step 4: 提交**

```bash
git add src
git commit -m "refactor(design): name the recurring 3D shadow recipes"
```

---

## Task 6: 全量验证

- [ ] **Step 1: 守卫全绿**

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH
npx tsx --test src/design/scaleGuard.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|not ok"
```

Expected: **4 tests / 4 pass / 0 fail**。

- [ ] **Step 2: 独立复核四项指标（不依赖守卫）**

```bash
echo -n "任意字号: "; grep -rhoE 'text-\[[0-9.]+px\]' src --include=*.tsx --include=*.ts | wc -l
echo -n "任意圆角(除 inherit): "; grep -rhoE 'rounded(-[a-z]+)*-\[[^]]+\]' src --include=*.tsx --include=*.ts | grep -v '\[inherit\]' | wc -l
echo -n "CSS 硬编码 border-radius: "; grep -rhoE 'border-radius:\s*[0-9]' src --include=*.css | wc -l
echo -n "重复阴影配方: "; node -e "
const fs=require('fs'),path=require('path');
const recipes=[
 'shadow-[0_2px_0_hsl(var(--foreground)/0.10),0_4px_10px_hsl(var(--foreground)/0.06)]',
 'shadow-[0_3px_0_hsl(var(--foreground)/0.07),0_12px_26px_hsl(var(--foreground)/0.07)]',
 'shadow-[0_2px_0_hsl(var(--primary))]',
 'shadow-[0_2px_0_hsl(var(--foreground)/0.08)]',
 'shadow-[0_3px_0_hsl(var(--foreground)/0.08),0_6px_16px_hsl(var(--foreground)/0.07)]',
];
let n=0;
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory())walk(p); else if(/\.tsx?$/.test(e.name)&&!/\.test\./.test(e.name)){
 const s=fs.readFileSync(p,'utf8'); for(const r of recipes) n+=(s.split(r).length-1);}}})('src');
console.log(n);"
```

Expected: **四项全为 0**。

- [ ] **Step 3: 质量门不得劣化**

基线：typecheck 0 error；lint 0 error / 225 warning；测试 512 pass / 0 fail。

```bash
unset TSX_TSCONFIG_PATH
npm run typecheck
npm run lint 2>&1 | tail -3
npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
npm run build 2>&1 | tail -3
```

- [ ] **Step 4: 视觉一致性核对（本期核心验收）**

本期的验收标准是**渲染结果不变**。逐项核对：

```bash
echo "=== 刻度定义 ==="
grep -A10 'borderRadius' tailwind.config.js
grep -A10 'fontSize' tailwind.config.js
echo "=== 8 处吸附的位置（应仅这些）==="
grep -rnE '\btext-sm\b' src --include=*.tsx | grep -iE '13px|10\.5' || echo "（已替换，无法从类名反查——见 spec §5.2 列表）"
```

再对**任务板、聊天、侧边栏、设置**四屏做亮/暗两态前后对比（截图或目视）。重点看：

1. 圆角：卡片、按钮、标签的圆角**与改动前一致**（尤其 `rounded`/`rounded-sm` 那 86+8 处）
2. 字号：`text-[11px]` 变 `text-2xs` 的 82 处**视觉无变化**
3. 阴影：13 个文件里提成类名的 27 处**阴影观感一致**
4. **唯一应有差异**：spec §5.2 的 8 处字号吸附（13→14px、10.5→11px），1px 以内

若发现任何超出这 8 处的视觉差异，**回到对应任务修正**，不要放过。

- [ ] **Step 5: 最终提交**

```bash
git add -A
git commit -m "test(design): verify scale unification end to end"
```

---

## 自查记录

**Spec 覆盖**：§4 圆角刻度 → Task 2/3；§5 字号刻度 → Task 2/4；§6 阴影刻度 → Task 2/5；§8 验收标准 → Task 6；§2.2 非目标（不做层级/密度/阴影风格统一）→ 计划中无对应任务，符合预期。

**与一期的隔离**：本期只改 `borderRadius`/`fontSize`/`boxShadow` 与类名，不碰任何颜色 token；`tokenGuard.test.ts`（一期守卫）应保持 9/9 全绿，Task 6 Step 3 的全量测试会覆盖这一点。

**已知偏差**：spec §5.2 的 8 处字号吸附是本计划唯一的视觉变化，已在 Task 4 映射表与 Task 6 Step 4 中显式标注。
