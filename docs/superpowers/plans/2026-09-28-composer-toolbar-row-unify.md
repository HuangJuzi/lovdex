# 手机端输入栏折行统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机端 composer 工具栏的六个权限模式占位相同，从而消除「只有 Approve 折成 3 行」的差异，并在 ≥ 358px 视口下统一为 2 行。

**Architecture:** 纯前端、两处 Tailwind class。机制只有一条：模式按钮是内容自适应宽度，六个短标签宽度不同（`Approve` 80px vs `Plan` 58px），所以「哪一档宽度折行」因模式而异。给短标签一个最小宽度，六个模式的按钮占位就按构造相同 —— 折行结果必然一致。第二处（收紧手机端模型名上限）把「一致在 2 行」的宽度门槛从 374px 拉到 358px。

**Tech Stack:** React + TypeScript + Tailwind 3.4.19（`sm` = 640px）+ `node:test` / `node:assert/strict`。浏览器验证用 `/tmp/node_modules/puppeteer-core` + 缓存 chromium。

**Spec:** `docs/superpowers/specs/2026-09-28-composer-toolbar-row-unify-design.md`

---

## 为什么不用常规 TDD 贯穿

`web` 测试环境**无 DOM**（无 jsdom / happy-dom，见 `web/src/components/chat/view/subcomponents/MessageComponent.test.tsx:19` 的记载）。折行是布局事实，单测量不到。所以本计划分两层：

- **能进 CI 的那层**：钉住「让折行可预测」的两处 className。先写测试、验证它红，再改代码让它绿 —— 这部分是标准 TDD（Task 1 → Task 2）。
- **量像素的那层**：一次性 puppeteer 探针（Task 4）。它 **不写进仓库**（仓库先例：同类探针都在 `/tmp`，见 `docs/superpowers/plans/2026-09-18-mobile-permission-mode-label.md` 的 Task 0/4）。

计划里**没有**「像素预算纯函数 + 单测」这一步，这是刻意的：spec §3 记了实测证据 —— 折行边界有亚像素敏感性（按钮 `min-w:80px` 时 `Approve` 是 80.094px、其余 80.000px），闭式算术算出的门槛是 356px 而实测是 358px。把测不准的东西钉成硬数字，第一次换字号就会假红。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `web/src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts` | 钉住两处 className 不变量。读源码文本，不渲染 | 新建 |
| `web/src/components/chat/view/subcomponents/ChatComposer.tsx` | 消费上述两处 class（第 575 行短标签 span、第 589 行模型名 span） | 修改 2 行 |
| `web/src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts` | 修订长度断言的**理由**（折行已改由像素保证，长度只管可读性） | 修改注释与测试名 |
| `/tmp/lovdex-toolbar-rows.cjs` | 浏览器实测三不变量。**不入库** | 新建（临时） |

---

## Task 0: 记录 baseline（不提交任何东西）

改动前先量一遍，否则 §Task 5 的「零新增」没有对照物。**这些数字会随并发会话波动**，判据是**所改文件**的计数不变，不是仓库总数不变（仓库与别的会话共用工作区）。

**Files:** 无

- [ ] **Step 1: 确认工作区状态**

```bash
cd /mnt/b/workdir/github/lovdex
git status --short
git log --oneline -1
```

Expected: 只有 `?? docs/preview/` 是未跟踪的（那是别的会话的产物，**不要动**），且 HEAD 是 `8da4877 docs(chat): design the composer toolbar row unification on mobile`。

如果 `ChatComposer.tsx` 出现在 `git status` 里，说明**另一个会话正在改同一个文件**（本仓库已知的并发风险）。停下来，把冲突报告给用户，不要继续。

- [ ] **Step 2: 记录 web typecheck baseline**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npm run typecheck 2>&1 | tail -20
```

把输出抄下来。2026-09-28 实测为**零输出（0 错误）**。若你看到错误，记下条数与文件 —— 那是别的会话引入的，验收看「零新增」。

`env -u TSX_TSCONFIG_PATH` 是必须的：全局导出的 `TSX_TSCONFIG_PATH=server/tsconfig.json` 会破坏 web 侧的运行。

- [ ] **Step 3: 记录所改文件的 eslint baseline**

```bash
cd /mnt/b/workdir/github/lovdex/web
for f in src/components/chat/view/subcomponents/ChatComposer.tsx \
         src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts; do
  n=$(env -u TSX_TSCONFIG_PATH npx eslint "$f" 2>&1 | grep -cE "^\s+[0-9]+:[0-9]+\s+(warning|error)")
  echo "$n  $f"
done
```

Expected（2026-09-28 实测）：

```
6  src/components/chat/view/subcomponents/ChatComposer.tsx
0  src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts
```

仓库 eslint baseline 本就不干净（全量 227 warnings / 0 errors），**只看这两个文件的计数是否变化**。

- [ ] **Step 4: 确认 E2E 前置**

```bash
ls /tmp/node_modules/puppeteer-core >/dev/null 2>&1 && echo "puppeteer ok" || echo "puppeteer MISSING"
ls ~/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome
ss -ltn 2>/dev/null | grep -E ":(3188|5188)"
```

Expected: 前两条都打印路径；`ss` 显示 :3188 与 :5188 都在 LISTEN。

- `/tmp/node_modules` 会在会话中途被清空（真踩过）。若 MISSING，**当下**重装再继续；不要跨 Bash 调用假设它在。
- 若 :3188/:5188 没起，停下来问用户 —— 重启后端会杀掉所有活跃会话，需要用户逐次许可。

---

## Task 1: 写静态守卫测试（先红）

**Files:**
- Create: `web/src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 手机端 composer 工具栏的折行不变量。
 * 见 docs/superpowers/specs/2026-09-28-composer-toolbar-row-unify-design.md
 *
 * 为什么钉 className 而不是量布局：web 测试环境无 DOM，量不到像素。所以这里
 * 钉的是「让折行结果可预测」的那两处 class —— 它们是折行的充分条件，不是代理
 * 指标。真正的折行结论由该 spec §3 的 puppeteer 探针给出（那才量得到像素）。
 *
 * 读取方式是「按标记定位开标签、再取 className」。刻意只匹配**单个 class 成员**
 * （`min-w-12` / `max-w-20`），不做结构匹配、不数括号、不比对整条 className 字符串
 * —— 多行书写或格式化不会误红。仓库对「读源码断言结构」有过一次教训
 * （MessageComponent.test.tsx 顶部注释：多行书写会误红、路由写反却全绿）。
 */
const SOURCE = fileURLToPath(new URL('./ChatComposer.tsx', import.meta.url));

/** 取源码里包含 `marker` 的那个 JSX 开标签的整段文本。 */
function openingTagContaining(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `ChatComposer.tsx 里找不到 ${marker}（改动后标记变了？）`);
  const open = source.lastIndexOf('<', at);
  const close = source.indexOf('>', at);
  assert.ok(open !== -1 && close > at, `${marker} 所在的标签读不出来`);
  return source.slice(open, close + 1);
}

/** 开标签上的 class 成员列表；顺序无关。 */
function classNamesOf(tag: string): string[] {
  const match = /className="([^"]*)"/.exec(tag);
  assert.ok(match, `标签上没有 className 字面量（改成了表达式？）：${tag}`);
  return match[1].split(/\s+/).filter(Boolean);
}

const source = readFileSync(SOURCE, 'utf8');
const shortLabelTag = openingTagContaining(source, 'modeLabelKeys.shortKey');
const modelLabelTag = openingTagContaining(source, '{modelLabel}');

// 六种模式的短标签宽度不同（Approve 80px vs Plan 58px），这就是 bug 的全部原因：
// 模式按钮内容自适应 ⇒「哪一档视口宽度折行」因模式而异。给短标签一个最小宽度，
// 六个模式的按钮占位就按构造相同，折行结果必然一致 —— 不再靠调宽度碰运气。
//
// 钉的是「六者相等」这条不变量，不是「都等于 82px」：min-w 是下限，将来往
// modesShort 里加更长（例如中文）的标签时按钮仍会变宽，届时这条会红，逼人回来重算。
// 长度预算那条测试（permissionModeLabels.i18n.test.ts）拦不住这件事 —— 字符数与
// 像素宽不是一回事，正是本 bug 的成因。
test('the short mode label reserves a fixed minimum width', () => {
  const classes = classNamesOf(shortLabelTag);
  assert.ok(
    classes.includes('min-w-12'),
    `短标签需要固定最小宽度 48px（min-w-12）；实际 class：${classes.join(' ')}`,
  );
  assert.ok(
    classes.includes('text-center'),
    `窄标签要在固定宽度里居中，圆点才会与其它模式对齐；实际 class：${classes.join(' ')}`,
  );
});

// 模型名上限与上一项合起来决定「2 行」的宽度门槛。只钉标签不收紧模型名时，
// 358–373px 这批机器会从「2 行 / 3 行混杂」变成「统一 3 行」—— 差异是没了，
// 但方向反了（spec §2.2 的实测：门槛 374px vs 358px）。
test('the model label keeps the narrower mobile cap', () => {
  const classes = classNamesOf(modelLabelTag);
  assert.ok(
    classes.includes('max-w-20'),
    `手机端模型名上限应为 80px（max-w-20）；实际 class：${classes.join(' ')}`,
  );
  assert.ok(
    !classes.includes('max-w-24'),
    '手机端上限不能退回 96px（max-w-24）—— 那会把「2 行」的门槛推回 374px',
  );
  assert.ok(
    classes.includes('sm:max-w-32'),
    `桌面端上限 128px 保持不变；实际 class：${classes.join(' ')}`,
  );
});

// 两处断言必须落在不同的标签上。抽错标记（比如两个 marker 撞到同一个开标签）时，
// 前两条会对着同一段文本重复断言，看着全绿却漏掉另一半。
test('the two assertions land on different tags', () => {
  assert.notEqual(shortLabelTag, modelLabelTag, '两处断言落到了同一个标签上，抽取标记写错了');
});
```

- [ ] **Step 2: 跑测试，确认它红**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts 2>&1 | tail -30
```

Expected: **失败**，且失败信息是「短标签需要固定最小宽度 48px（min-w-12）」。

三条否定式确认（**别跳过** —— 测试因为无关原因红（比如路径写错、标记找不到）时，后面「改代码转绿」这一步就什么都没证明）：

1. 失败的是 `the short mode label reserves a fixed minimum width`，**不是** `找不到 modeLabelKeys.shortKey`。
2. `the model label keeps the narrower mobile cap` 也失败（`max-w-20` 还不存在）。
3. `the two assertions land on different tags` **通过**。

用一个临时探针确认抽取器本身工作正常（跑完删掉）：

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx -e "
import { readFileSync } from 'node:fs';
const src = readFileSync('src/components/chat/view/subcomponents/ChatComposer.tsx', 'utf8');
const at = src.indexOf('modeLabelKeys.shortKey');
console.log('FOUND:', src.slice(src.lastIndexOf('<', at), src.indexOf('>', at) + 1));
"
```

Expected: 打印出 `<span className="whitespace-nowrap sm:hidden">` —— 说明标记能定位到标签，红的确实是缺 class。

- [ ] **Step 3: 不提交**

测试此刻是红的，提交它会让仓库进入坏状态。Task 2 转绿后与实现一起提交。

---

## Task 2: 改两处 class（转绿）

**Files:**
- Modify: `web/src/components/chat/view/subcomponents/ChatComposer.tsx:575`（短标签 span）
- Modify: `web/src/components/chat/view/subcomponents/ChatComposer.tsx:589`（模型名 span）
- Test: `web/src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts`

- [ ] **Step 1: 改短标签 span**

`web/src/components/chat/view/subcomponents/ChatComposer.tsx` 第 575 行：

```tsx
                <span className="min-w-12 whitespace-nowrap text-center sm:hidden">{t(modeLabelKeys.shortKey)}</span>
```

（原来只有 `whitespace-nowrap sm:hidden`）

`min-w-12` = `12 × 0.25rem` = 48px，略大于今天最宽标签 `Approve` 的自然宽 **46.094px**（实测），所以**不截断任何现有标签**。

`text-center` 让 `Plan`/`Auto` 这类窄标签在 48px 里居中。不需要 `sm:` 变体 —— 它挂在 `sm:hidden` 的 span 上，`sm:` 以上整个 span 不显示。

- [ ] **Step 2: 改模型名 span**

同文件第 589 行：

```tsx
                <span className="max-w-20 truncate sm:max-w-32">{modelLabel}</span>
```

（原来 `max-w-24 truncate sm:max-w-32`。只改 `< sm` 那一档：96px → 80px，桌面 `sm:max-w-32` 不变。）

- [ ] **Step 3: 跑测试，确认转绿**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts 2>&1 | tail -12
```

Expected:

```
# tests 3
# pass 3
# fail 0
```

- [ ] **Step 4: 确认 Tailwind 真的能生成这两个类**

`min-w-12` / `max-w-20` 若不在 Tailwind 的默认刻度里，className 写了也不会有任何效果（静默失效，测试照样绿 —— 因为测试读的是源码文本）。这一步就是拦这个。

```bash
cat > /tmp/lovdex-tw-probe.cjs <<'EOF'
const postcss = require('/mnt/b/workdir/github/lovdex/web/node_modules/postcss');
const tailwind = require('/mnt/b/workdir/github/lovdex/web/node_modules/tailwindcss');
postcss([tailwind({ content: [{ raw: '<div class="min-w-12 text-center max-w-20 sm:max-w-32"></div>' }] })])
  .process('@tailwind utilities;', { from: undefined })
  .then((r) => console.log(r.css.trim() || '(empty)'))
  .catch((e) => console.error('ERR', e.message));
EOF
node /tmp/lovdex-tw-probe.cjs
```

Expected（2026-09-28 实测，Tailwind 3.4.19）：

```
.min-w-12 {
    min-width: 3rem
}
.max-w-20 {
    max-width: 5rem
}
.text-center {
    text-align: center
}
@media (min-width: 640px) {
    .sm\:max-w-32 {
        max-width: 8rem
    }
}
```

关键是 `min-width: 3rem` 与 `max-width: 5rem` 两条都在。缺任何一条就说明这个刻度不存在，必须换一个存在的刻度（例如 `min-w-12` 换成 `min-w-[48px]`），并回头同步 Task 1 的断言与 spec。

- [ ] **Step 5: 跑既有的相关测试，确认没打破别的**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/permissionModeLabels.test.ts src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts 2>&1 | tail -12
```

Expected: 全过（`# pass 2` 与 `# pass 3`；两个文件分别跑）。这一改动不碰 i18n，理应零影响 —— 若红了说明改错了文件。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/ChatComposer.tsx \
        web/src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts
git commit -m "fix(chat): pin the mode label width so the composer toolbar wraps the same way in every mode"
```

**提交信息不要加 `Co-Authored-By` 行**（本仓库约定）。

---

## Task 3: 修订 i18n 测试里已过时的理由

**Files:**
- Modify: `web/src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts:31-48`

这条测试本身保留；要改的是它的**理由**。现在它写着「短标签是为了 footer 在 375px 不折行」—— 这条依据被 Task 2 取代了：折行现在由「标签等宽 + 模型名上限」保证，而「字符数 ≤ 7」按字符数做预算、折行却按像素发生（`Approve` 与 `Default` 同为 7 字符却差 6px，正是本 bug 的成因）。

**不改** `MAX_SHORT_LABEL_LENGTH = 7`（`Approve` 正好 7，改小会红；没有理由改小）。

- [ ] **Step 1: 替换注释与测试名**

把 `permissionModeLabels.i18n.test.ts` 第 31–38 行：

```ts
// The whole point of the short labels is that the composer footer does not wrap
// at 375px. Nothing else asserts that property — the sibling test pins key
// strings, not values — so without this a future edit could set
// modesShort.bypassPermissions back to "Bypass Permissions" and every other
// check would stay green while the phone UI regressed.
const MAX_SHORT_LABEL_LENGTH = 7;

test('short labels stay short enough not to wrap the composer footer', () => {
```

改成：

```ts
// Short labels exist so a phone shows a readable word instead of a bare colour
// dot. This budget keeps them RENDERABLE, not wrap-immune: label length is
// counted in characters while wrapping happens in pixels — `Approve` and
// `Default` are both 7 chars yet 6px apart, which is precisely how the Approve
// row ended up alone on a third line. Row count is now guaranteed structurally
// by the fixed-width label span (see ChatComposer.toolbar.test.ts) plus the
// mobile model-name cap, so this test no longer carries that job.
// docs/superpowers/specs/2026-09-28-composer-toolbar-row-unify-design.md
const MAX_SHORT_LABEL_LENGTH = 7;

test('short labels stay short enough to render whole on a phone', () => {
```

- [ ] **Step 2: 只改注释与测试名，断言不动**

`assert.ok(... <= MAX_SHORT_LABEL_LENGTH, ...)` 那一段原样保留。失败信息里的文案也不用改（它说的是「over the 7-char budget」，仍准确）。

- [ ] **Step 3: 跑测试确认仍绿**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts 2>&1 | tail -12
```

Expected: `# tests 3` / `# pass 3` / `# fail 0`。

- [ ] **Step 4: 确认没有别处引用旧测试名**

```bash
cd /mnt/b/workdir/github/lovdex
grep -rn "not to wrap the composer footer" --include=*.ts --include=*.tsx --include=*.md . | grep -v node_modules
```

Expected: **只有本计划自身的输出**，形如：

```
docs/superpowers/plans/2026-09-28-composer-toolbar-row-unify.md:359:test('short labels stay short enough not to wrap the composer footer', () => {
```

那一行是本 Step 1 的「改前」代码块（计划的留痕），**不要改它**。除此以外不该有别的引用；若出现别的文件（比如 spec 或别的 plan 引用旧测试名），把引用一并更新。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts
git commit -m "test(chat): stop claiming the short-label budget is what keeps the composer from wrapping"
```

---

## Task 4: 浏览器实测三不变量

**Files:**
- Create: `/tmp/lovdex-toolbar-rows.cjs`（**不入库**）

Task 1–3 钉的是 className，**没有证明折行真的统一了**。这一步才量像素。它是本计划唯一能证伪设计的环节 —— 如果实测与 spec §3 的实测值不符，**以实测为准**，回头改 spec 的预期表。

> **好消息：这一步的期望值已经用真实改动验证过了。** 写计划时我照 §Task 2 把两处 class 真改了一遍、跑过这个探针、确认全部 PASS，然后 `git checkout` 还原（工作区未留痕 —— 你开工时 `git status` 只该看到 `?? docs/preview/` 与本计划/设计两个文档）。所以下面 Expected 里的数字是**实测值**，不是推算。若你跑出来不同，先怀疑探针或环境，不要先怀疑产品代码。

**为什么这一步不是重复 Task 1。** Task 1 的静态测试钉的是「源码里有 `min-w-12` / `max-w-20` 这两个字符串」（外加 Task 2 Step 4 证明 Tailwind 真能生成它们）。它**无法**知道：

1. 六个短标签是否真的都短于 48px —— 将来加个中文标签，`min-w` 会被撑开，六者又不等了；
2. 那 48px 在真实布局里是否真的让六种模式落在同一档折行；
3. 累积效果有没有把门槛推到用户报的那个宽度档之下。

第 3 条是用户唯一能感知的事。所以本步是**独立的验收**。

**为什么不注入 `content-visibility: visible`。** `content-visibility: auto` 只影响屏幕外的**消息行**（`.chat-message`）。composer 工具栏在视口内、不受影响，所以本探针不需要它。spec §3 记的那条坑是给「顺带量消息行」的探针用的 —— 别照抄进这个探针：多注入一条全局样式反而可能影响工具栏的合成层，把测量搞出别的噪音。

- [ ] **Step 1: 写探针**

创建 `/tmp/lovdex-toolbar-rows.cjs`：

```js
/**
 * 量 composer 工具栏在六个权限模式下分别折成几行，以及模式按钮的宽度。
 *
 * 前置：:5188 前端 + :3188 后端在跑（纯前端改动走 vite HMR，不重启后端）。
 * 运行：node /tmp/lovdex-toolbar-rows.cjs
 */
const puppeteer = require('puppeteer-core');

const CHROME = '/home/zhijuhuang/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';
const BASE = 'http://127.0.0.1:5188';
const API = 'http://127.0.0.1:3188';
const EMAIL = 'zhiju.huang@sophgo.com';
const CODE = '888888';

const MODES = ['Default', 'Auto', 'Approve', 'Accept', 'Bypass', 'Plan'];

// ≥ 640px 时 `sm:inline` 的全称标签生效，读到的文字是 "Auto Approve" 这类全称。
// 不做归一化的话，桌面那几档会一个模式都收不到、全报「未覆盖到模式」。
const MODE_ALIASES = {
  'Default Mode': 'Default',
  'Auto Mode': 'Auto',
  'Auto Approve': 'Approve',
  'Accept Edits': 'Accept',
  'Bypass Permissions': 'Bypass',
  'Plan Mode': 'Plan',
};
const canonicalMode = (text) => MODE_ALIASES[text] || text;

// 工具栏里 button 的数量。2026-09-28 实测为 8：附件、文件、权限模式、模型
// （前提是 composer 拿到了 modelLabel）、effort（前提是有 effort 选项）、token、
// quick replies、slash commands。
// 探针会把它与实际数量比对：数量不符时行数会集体偏小，「六种模式一致」就会假绿。
// 换了会话/视图模式/功能开关后这个数可能不同 —— 先按实测值确认，再改这个常量，
// 或者换一个更接近本计划取样条件的会话。
const EXPECTED_BUTTON_COUNT = 8;

// 视口 → 该视口的期望。'two' = 六种模式都是 2 行；'uniform' = 六种模式行数一致（几行不限）；
// 'distinct' = 六种模式按钮宽度互不相同（桌面端内容自适应仍在）。
const WIDTHS = [
  [344, 'uniform'],
  [350, 'uniform'],
  [356, 'uniform'],
  [358, 'two'],
  [360, 'two'],
  [375, 'two'],
  [414, 'two'],
  [430, 'two'],
  [640, 'distinct'],
  [768, 'distinct'],
  [1024, 'distinct'],
  [1440, 'distinct'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modeText = () => {
  const footer = document.querySelector('[data-slot="prompt-input-footer"]');
  const b = footer && [...footer.querySelectorAll('button')].find((x) =>
    (x.getAttribute('title') || '').startsWith('Click to change permission mode'));
  if (!b) return null;
  return [...b.querySelectorAll('span')]
    .filter((s) => getComputedStyle(s).display !== 'none')
    .map((s) => s.textContent.trim())
    .filter(Boolean)
    .pop() || null;
};

const clickMode = () => {
  const footer = document.querySelector('[data-slot="prompt-input-footer"]');
  const b = footer && [...footer.querySelectorAll('button')].find((x) =>
    (x.getAttribute('title') || '').startsWith('Click to change permission mode'));
  if (!b) return false;
  b.click();
  return true;
};

const measure = () => {
  const tools = document.querySelector('[data-slot="prompt-input-tools"]');
  if (!tools) return { found: false };
  const btns = [...tools.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect();
    return { top: r.top, w: r.width };
  });
  const sorted = [...btns].sort((a, b) => a.top - b.top);

  // 按 top 聚类成视觉行，容差 8px。
  // 注意 rows 的元素是 { top, items }，不是数组 —— 写成数组后 `last.top` 是
  // undefined，`Math.abs(x - undefined) <= 8` 恒 false，会把每个按钮都算成独立
  // 一行（实测踩过：报出「8 行，每行 1 个」）。这段注释就是拦它的。
  const rows = [];
  for (const b of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(b.top - last.top) <= 8) {
      last.items.push(b);
      continue;
    }
    rows.push({ top: b.top, items: [b] });
  }

  const modeBtn = [...tools.querySelectorAll('button')].find((x) =>
    (x.getAttribute('title') || '').startsWith('Click to change permission mode'));
  return {
    found: true,
    rowCount: rows.length,
    rowSizes: rows.map((r) => r.items.length),
    modeW: modeBtn ? +modeBtn.getBoundingClientRect().width.toFixed(3) : null,
    buttonCount: btns.length,
  };
};

(async () => {
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, code: CODE }),
  });
  const login = await loginRes.json();
  if (!login.token) {
    console.error('登录失败，检查 backend/server/modules/auth/auth.config.json:', login);
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.evaluateOnNewDocument((t) => localStorage.setItem('auth-token', t), login.token);
  await page.setViewport({ width: 390, height: 900 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await sleep(1500);

  // 落地页可能是「Choose Your Project」空态（没有 composer）。深链一个会话最稳。
  if (!(await page.$('[data-slot="prompt-input-tools"]'))) {
    const href = await page.evaluate(() => {
      const a = document.querySelector('a[href^="/session/"]');
      return a ? a.getAttribute('href') : null;
    });
    if (!href) {
      console.error('侧边栏里没有会话链接，无法定位 composer');
      await browser.close();
      process.exit(3);
    }
    console.log('深链到会话:', href);
    await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle2' });
    await sleep(2500);
  }
  try {
    await page.waitForSelector('[data-slot="prompt-input-tools"]', { timeout: 20000 });
  } catch {
    console.error('拿不到 composer 工具栏');
    await browser.close();
    process.exit(3);
  }

  const failures = [];

  for (const [width, expectation] of WIDTHS) {
    await page.setViewport({ width, height: 900 });
    await sleep(320);

    const perMode = new Map();
    // 多按几次：第一次点击后的模式由 localStorage 决定，六次点击只覆盖从起点
    // 开始的连续六种。多一轮保证六种都被采到。
    for (let i = 0; i < 8; i++) {
      const raw = await page.evaluate(modeText);
      const mode = canonicalMode(raw);
      const m = await page.evaluate(measure);
      if (!m.found) break;
      if (mode && !perMode.has(mode)) perMode.set(mode, m);
      await page.evaluate(clickMode);
      await sleep(160);
    }

    // 按钮数必须与真值一致。缺一个按钮时行数会集体偏小，那时「六种模式一致」会
    // 假绿（六种都少一行，看着统一）。用**全部**采样里的极值，而不是随便取一个 ——
    // 取到的那次若正好按钮少，这条检查就白做了。
    const anySample = perMode.values().next().value;
    const sampledCounts = [...perMode.values()].map((v) => v.buttonCount);
    if (anySample) {
      const observed = Math.max(...sampledCounts);
      const minObserved = Math.min(...sampledCounts);
      if (observed !== minObserved) {
        failures.push(`${width}px: 按钮数在采样过程中变化了（${minObserved}…${observed}）—— 采样不可靠`);
      }
      if (observed !== EXPECTED_BUTTON_COUNT) {
        failures.push(
          `${width}px: 工具栏按钮数 ${observed}，期望 ${EXPECTED_BUTTON_COUNT}` +
            `（视图模式或功能开关与取样时不同？）`,
        );
      }
    }

    const missing = MODES.filter((k) => !perMode.has(k));
    const counts = MODES.map((k) => (perMode.get(k) ? perMode.get(k).rowCount : null));
    const widths = MODES.map((k) => (perMode.get(k) ? perMode.get(k).modeW : null));
    const distinctCounts = new Set(counts.filter((c) => c !== null));
    const distinctWidths = new Set(widths.filter((w) => w !== null).map((w) => w.toFixed(3)));

    const summary = MODES.map((k, i) => `${k}=${counts[i] ?? '?'}`).join(' ');
    const widthSummary = [...distinctWidths].join(',');

    let verdict = 'OK';
    if (missing.length) {
      verdict = `FAIL 未覆盖到模式: ${missing.join(',')}`;
    } else if (expectation === 'two' && !(distinctCounts.size === 1 && distinctCounts.has(2))) {
      verdict = `FAIL ${expectation}: 期望六种模式统一 2 行，实际 ${summary}`;
    } else if (expectation === 'uniform' && distinctCounts.size !== 1) {
      verdict = `FAIL ${expectation}: 期望六种模式行数一致，实际 ${summary}`;
    } else if (expectation === 'distinct' && distinctWidths.size === 1) {
      verdict = `FAIL ${expectation}: 桌面端六个模式按钮宽度被钉成同一个（${widthSummary}），内容自适应被破坏了`;
    }
    // 任意视口：手机区间里六种模式的按钮宽度必须相等
    if (width < 640 && distinctWidths.size !== 1 && verdict === 'OK') {
      verdict = `FAIL 手机端六种模式按钮宽度不等: ${widthSummary}`;
    }

    const rowSizes = perMode.get('Approve') ? perMode.get('Approve').rowSizes.join('/') : '?';
    console.log(
      `${String(width).padStart(4)}px rows=${counts.join('/')} widths=${widthSummary} ` +
      `Approve每行按钮数=${rowSizes} → ${verdict}`,
    );
    if (verdict !== 'OK') failures.push(`${width}px: ${verdict}`);
  }

  await browser.close();

  console.log('\n=== 判定 ===');
  if (failures.length) {
    console.log(`FAIL (${failures.length})`);
    failures.forEach((f) => console.log('  ' + f));
    process.exit(1);
  }
  console.log('PASS：手机端六种模式行数一致、按钮等宽；375px 及 358px 起恒 2 行；桌面端宽度仍各不相同');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: 跑探针，确认全绿**

```bash
cd /tmp && node /tmp/lovdex-toolbar-rows.cjs 2>&1 | tail -20
```

Expected（**实测基线**；写计划时已把两处 class 真改了一遍跑过、再 `git checkout` 还原）：

```
 344px rows=3/3/3/3/3/3 widths=82.000 Approve每行按钮数=3/2/3 → OK
 350px rows=3/3/3/3/3/3 widths=82.000 Approve每行按钮数=3/2/3 → OK
 356px rows=3/3/3/3/3/3 widths=82.000 Approve每行按钮数=3/2/3 → OK
 358px rows=2/2/2/2/2/2 widths=82.000 Approve每行按钮数=4/4 → OK
 360px rows=2/2/2/2/2/2 widths=82.000 Approve每行按钮数=4/4 → OK
 375px rows=2/2/2/2/2/2 widths=82.000 Approve每行按钮数=4/4 → OK
 414px rows=2/2/2/2/2/2 widths=82.000 Approve每行按钮数=4/4 → OK
 430px rows=2/2/2/2/2/2 widths=82.000 Approve每行按钮数=4/4 → OK
 640px rows=2/2/2/2/2/2 widths=107.969,94.625,109.766,100.656,140.625,91.734 Approve每行按钮数=5/3 → OK
 768px rows=2/2/2/2/3/2 widths=（同上六个值） Approve每行按钮数=4/4 → OK（Bypass 的 3 行是既有现象，见 Step 5）
1024px rows=2/2/2/2/2/2 widths=（同上六个值） Approve每行按钮数=4/4 → OK
1440px rows=2/2/2/2/2/2 widths=（同上六个值） Approve每行按钮数=6/2 → OK
=== 判定 ===
PASS：手机端六种模式行数一致、按钮等宽；375px 及 358px 起恒 2 行；桌面端宽度仍各不相同
```

**探针自身的健康度指示器**：`Approve每行按钮数` 那列应是 `3/2/3`（344px）或 `4/4`（360px）。若出现 `1/1/1/…`，一律是聚类坏了（`last.top` 落在数组上 → `undefined`，`Math.abs(x - undefined) <= 8` 恒 false ⇒ 每个按钮自成一「行」，实测报出 8 行）—— 修聚类，别去改产品代码。

**想亲眼看它红一次**（确认探针真的在测这个 bug，而不是恒绿）：把改动临时收起来再跑同一命令，跑完恢复。

```bash
cd /mnt/b/workdir/github/lovdex
git stash push -- web/src/components/chat/view/subcomponents/ChatComposer.tsx
cd /tmp && node /tmp/lovdex-toolbar-rows.cjs 2>&1 | tail -12   # 期望 FAIL (8)
cd /mnt/b/workdir/github/lovdex && git stash pop
```

改动前的失败特征（实测）：

```
  344px: FAIL 手机端六种模式按钮宽度不等: 74.047,60.719,80.094,70.734,72.641,57.828
  350px: FAIL uniform: 期望六种模式行数一致，实际 Default=3 Auto=3 Approve=3 Accept=3 Bypass=3 Plan=2
  356px: FAIL uniform: … Auto=2 … Plan=2
  358px: FAIL two: 期望六种模式统一 2 行，实际 Default=3 Auto=2 Approve=3 Accept=3 Bypass=3 Plan=2
  360px: FAIL two: 同上
```

改动前的六种模式按钮宽 `Approve 80.094 / Default 74.047 / Bypass 72.641 / Accept 70.734 / Auto 60.719 / Plan 57.828` —— 六个全不相等、Approve 最宽，正是这个 bug 的签名。改动后应全部变成 `82.000`。

`git stash pop` 之后务必确认 `grep -n "min-w-12" src/components/chat/view/subcomponents/ChatComposer.tsx` 仍有输出 —— 别把改动忘在 stash 里。

- [ ] **Step 3: 若 358/360px 没到 2 行，先查环境再动代码**

本期望值**已经用真实改动实测过并 PASS**（见本节开头的说明），所以出现不符时**几乎一定是环境或探针问题**，按此顺序查：

1. **确认改动真的生效了**：`grep -n "min-w-12" src/components/chat/view/subcomponents/ChatComposer.tsx` 要有输出。vite HMR 偶发不重建时硬刷新一次页面。
2. **确认读的是同一个会话/同一套按钮**：看 `Approve每行按钮数` 那列 —— 若出现 `1/1/1/…` 就是聚类坏了（`last.top` 落在数组上）；若按钮数不等于 `EXPECTED_BUTTON_COUNT`，说明取样条件的按钮数与写计划时不同。
3. 都排除后再动代码：`max-w-20` → `max-w-16`（64px）重跑。**只允许收一档**；再不够就停手，把实测写进 spec 并报告用户「这一档做不到 2 行，代价是砍掉模型名」——不要一路砍到把模型名砍没（spec §2.2 已定此界）。

- [ ] **Step 4: 反向验证桌面没被污染**

Step 2 输出里的 640/1024/1440 行已经在断言这件事：六种模式按钮宽度**互不相同**（`107.969,94.625,109.766,100.656,140.625,91.734`）。若它们变成同一个值，说明 `min-w-12` 漏到了 `sm:` 以上（例如有人把 `text-center` 挪到了父 div），必须修 —— 那是本改动最容易引入的回归。

- [ ] **Step 5: 认识到 768px 的 Bypass 3 行不是回归**

探针会有一行看着扎眼：`768px … Bypass Permissions` 是 3 行。**这是既有现象，与本改动无关**，spec §3 末已记录并给了三条证据（改动前后都复现、两轮采样一致、`toolsW` 381px 放不下 166px 的模型按钮）。它和用户报的 bug 是同一个成因（模式按钮宽度随模式变化）在 `≥ 640px` 窄视口上的同构形态，而本设计的 `min-w-12` 挂在 `sm:hidden` 的 span 上、不覆盖那一档。

**探针对它的判定是 `OK`**（`'distinct'` 期望只看「六种模式宽度互不相同」，不看行数）。不要去修它，也不要在汇报里把它说成已修好 —— 如实说明是既有现象、在本设计范围外。

- [ ] **Step 6: 按实测更新 spec（预期已在计划阶段核对过，通常无需改动）**

spec §3 的表格**已经**被真实改动实测过（见 Task 4 开头）。所以你这一步通常**什么都不用做**。只有在实测与 spec 表格有出入时才改它，并把 §3 里对应行标注为「已由实测取代」——spec 与实现不一致时以实测为准，且必须同步，否则下一个人会照着错的表改。

- [ ] **Step 7: 提交（仅当 Step 6 真的改了 spec）**

```bash
cd /mnt/b/workdir/github/lovdex
git add docs/superpowers/specs/2026-09-28-composer-toolbar-row-unify-design.md
git commit -m "docs(chat): record the measured composer toolbar wrap thresholds"
```

探针 `/tmp/lovdex-toolbar-rows.cjs` **不提交**。

---

## Task 5: 收尾核对

**Files:** 无（只跑验证）

- [ ] **Step 1: 单测全过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts \
  src/components/chat/view/subcomponents/permissionModeLabels.test.ts \
  src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts 2>&1 | tail -12
```

Expected: `# tests 8` / `# pass 8` / `# fail 0`（3 + 2 + 3）。

- [ ] **Step 2: 跑一遍 chat 目录的既有测试，确认没连带打破**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test "src/components/chat/**/*.test.ts" 2>&1 | tail -8
env -u TSX_TSCONFIG_PATH npx tsx --test "src/components/chat/**/*.test.tsx" 2>&1 | tail -8
```

Expected（2026-09-28 实测）：`.test.ts` **71 个全过**，`.test.tsx` **51 个全过**。

**两条 glob 都要跑，不能只跑第一条**：`.test.ts` 那条覆盖 `useChatMessages` / `autoApproveDeny` 等纯逻辑；渲染类（`MessageComponent.test.tsx`、`AutoApproveDenyNotice.test.tsx`）都在 `.test.tsx` 里，而它们才是会因 className 改动而受影响的那批。只跑 `.ts` 会漏掉整批渲染测试。

（`.test.tsx` 那条要在 `cd web` 之后跑；glob 必须带引号，交给 tsx 展开 —— 裸 `**` 会被 bash 按字面传给 tsx，结果一个文件都不匹配却「全绿」。）

- [ ] **Step 3: typecheck 零新增**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npm run typecheck 2>&1 | tail -20
```

Expected: 与 Task 0 Step 2 记录的输出**逐条一致**（2026-09-28 baseline 是 0 错误）。新增任何错误都必须修掉。

- [ ] **Step 4: 所改文件的 eslint 计数不变**

```bash
cd /mnt/b/workdir/github/lovdex/web
for f in src/components/chat/view/subcomponents/ChatComposer.tsx \
         src/components/chat/view/subcomponents/ChatComposer.toolbar.test.ts \
         src/components/chat/view/subcomponents/permissionModeLabels.i18n.test.ts; do
  n=$(env -u TSX_TSCONFIG_PATH npx eslint "$f" 2>&1 | grep -cE "^\s+[0-9]+:[0-9]+\s+(warning|error)")
  echo "$n  $f"
done
```

Expected: `ChatComposer.tsx` 仍是 **6**（Task 0 Step 3 的 baseline），两个测试文件 **0**。

`ChatComposer.tsx` 到 6 就对了 —— 不要试图把它们清零，那些是仓库既有的 import 顺序之类警告。

- [ ] **Step 5: 确认工作区干净**

```bash
cd /mnt/b/workdir/github/lovdex
git status --short
git log --oneline -4
```

Expected: 只剩 `?? docs/preview/`（别的会话的产物，**不要提交、不要删**）。日志里能看到本计划的 3 个提交（fix / test / 视 Step 5 而定的 docs）。

- [ ] **Step 6: 报告给用户**

汇报里必须包含**实测数字**，不要只说「改好了」：

- 360px · Approve 改动前 3 行 → 改动后 2 行（用户报的就是这个宽度档）；
- 六种模式在各视口的行数与按钮宽度；
- 桌面端宽度仍各不相同；
- **344–356px 极窄视口仍是 3 行**，且这是**已知边界**（spec §4 已列为「不做什么」）；
- **768px 的 `Bypass Permissions` 是 3 行** —— 既有现象、非本改动引入、在本设计范围外（Task 4 Step 5）。**不要略过这条**：用户若自己去 768px 看，看到的就是 3 行，不提前说会像是漏改。

按仓库约定用**中文**汇报（代码注释跟仓库风格、commit message 保持英文）。

---

## 完成标准

- [ ] `ChatComposer.toolbar.test.ts` 三条断言全绿，且**在 Task 2 之前确认过它们红**（写计划时已验证：红的正是「短标签需要固定最小宽度 48px（min-w-12）；实际 class：whitespace-nowrap sm:hidden」与「手机端模型名上限应为 80px（max-w-20）；实际 class：max-w-24 truncate sm:max-w-32」，第三条「落在不同标签上」通过）
- [ ] Tailwind 确实生成 `min-width: 3rem` 与 `max-width: 5rem`（不是写了个不存在的刻度）
- [ ] 浏览器实测：344/350/356px 六模式统一 3 行；358/360/375/414/430px 统一 2 行
- [ ] 浏览器实测：手机区间六种模式按钮宽度全为 82.000（改动前是 57.828…80.094 六个不同值）
- [ ] 浏览器实测：≥ 640px 六种模式按钮宽度互不相同
- [ ] 浏览器实测：工具栏按钮数为 8（探针的 `EXPECTED_BUTTON_COUNT` 与实际一致）
- [ ] 已确认 768px 的 Bypass 3 行是既有现象（非本改动引入），并在汇报里如实说明
- [ ] `permissionModeLabels.i18n.test.ts` 仍过，且理由不再是「防折行」
- [ ] chat 目录 `.test.ts`（71）与 `.test.tsx`（51）两条 glob 都全过
- [ ] typecheck 与所改文件 eslint 计数零新增
- [ ] 探针脚本留在 `/tmp`，未入库
