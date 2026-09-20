# Lovdex 设计 Token 统一（冷石墨）设计

- 日期：2026-09-20
- 状态：设计待评审
- 相关：`docs/design-html/2026-09-16-task-panel-redesign/`（旧设计稿，暖褐路线，本方案不采纳）

## 1. 背景与问题

Lovdex 前端目前**同时运行两套设计语言**，色彩使用约一半绕过设计系统：

| 指标 | 数值 |
|---|---|
| `src/**/*.{ts,tsx,css}` 文件总数 | 370 |
| 裸 Tailwind 调色板类名出现次数（`text-gray-400`、`bg-blue-900` …） | **1717** |
| 受影响文件数 | **99**（占 27%） |
| 走语义 token 的类名次数（`text-muted-foreground` …） | 1679 |
| 裸色占比 | **50.6%** |
| `dark:` 裸色手工配对次数 | **579** |
| 硬编码 hex | **104** |
| `rgb()` / `rgba()` 字面量 | **85** |

> 计数口径：排除 `*.test.tsx?` 与两个豁免目录（§6.2），并对源码剥离注释后统计——与实施计划中的守卫测试完全一致。按全仓裸 grep 会略高（1720 / 111 / 142），差异来自测试文件、豁免目录与注释。

### 1.1 根因：两个色相家族并存

`web/src/index.css:26` 定义 `--background: 44 22% 96%`（**暖**米色，hue 44），
而组件层大量使用的 `gray-*` 是 **冷**灰（hue 220）。
同一屏内背景与卡片分属两个色相家族，导致卡片"发脏"——这是不统一的**结构性根因**，不是个别页面没调好。

### 1.2 具体症状

1. **中性色冲突**：`text-gray-400`（112 处）、`text-gray-500`（85 处）、`bg-gray-800`（40 处）、`border-gray-700`（37 处）均为冷灰，叠在暖米底上。
2. **主色有 7 个版本**：`#3b82f6`（token）、`#1c3fa8`×8、`#0ea5e9`×4、`#6366f1`×3、`#1a2d5c`×3、`#2f5fe0`×2、`#5b8cff`×2。用户无法判断"什么颜色代表可点击"。
3. **语义色缺失**：token 里只有 `--destructive`，**没有 success / warning / info**。状态色全靠内联裸色，同一个"成功"在 `bg-green-500` / `text-green-600` / `bg-green-900` 三种写法间摇摆。
4. **暗色是手工补丁**：579 处 `dark:` 配对；且暗色 token 为 `0 0% 8%`（**零饱和度**），与亮色暖米底不是同一套设计，明暗切换时观感断裂。
5. **第三套路线**：`docs/design-html/2026-09-16-task-panel-redesign/` 使用暖褐 `#3f3a31` + 纸白 `#faf9f4` + 紫 `#7c3aed`，与线上冷灰/冷蓝主体不一致。

## 2. 目标与非目标

### 2.1 目标

- 建立**单一色彩来源**：背景、卡片、边框、文字、状态色全部来自语义 token。
- 中性色收进**同一色相家族**，消除暖冷冲突。
- 补齐 `success` / `warning` / `info` 语义色，每个语义只有唯一来源。
- 暗色**由 token 驱动**，组件内不再需要 `dark:` 前缀。
- 消灭 104 处硬编码 hex 与 7 种野蓝。

### 2.2 非目标（本期不做）

- **不做组件观感重做**（圆角、阴影、间距、排版层级）——留待二期。
- 不改动布局、交互、信息架构。
- 不引入新的 UI 组件库或替换 Tailwind。

## 3. 关键设计决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 色系方向 | **冷调**（中性色 hue 220） | 开发者工具主流审美；代码/日志密集区可读性最好 |
| 背景是否保留暖调 | **否**，改为冷白 `220 20% 98%` | 消除双色相家族冲突的根本手段 |
| 旧设计稿（暖褐路线） | **不采纳**，标记为已废弃 | 与冷调方向冲突，避免后续误用 |
| 语义色数量 | success / warning / info / destructive 四类 | 覆盖现有全部状态场景 |
| 语义色 token 数 | 每类 **2 个**（base + foreground） | 浅底形态用 `bg-x/10` 的 alpha 推导，不额外占 token |
| `--destructive` 是否改名 | **保留原名** | 重命名需改动 100+ 处，收益仅为命名一致性，不划算 |
| 暗色语义色 base | **分模式取值**（亮深暗浅），foreground 同步翻转 | 单一 base 无法同时满足两种底色的正文对比度——实测暗底仅 3.2–4.0:1，不达 AA。详见 §4.3 修正记录 |
| 暗色主色前景 | 深色 `222 47% 8%`（非白色） | 亮蓝 `#3b82f6` 上白字仅 3.6:1，不达 AA；深色前景达 5.2:1 |
| 图表色 | **分模式取值** | 图形对象需对背景 ≥3:1（WCAG 1.4.11）；共用一组基色时亮底上有 5 个色不达标 |
| 主色取值 | 亮 `#2563eb` / 暗 `#3b82f6` | 与现有 token 一致（本就是 Tailwind blue-600/500），无需改动 |

## 4. Token 体系

### 4.1 中性色阶（hue 220，饱和度随明度递减）

| 级别 | HSL | 用途 |
|---|---|---|
| 50 | `220 20% 98%` | `--background` |
| 100 | `220 18% 96%` | `--muted` / `--secondary` / `--accent` |
| 200 | `220 16% 91%` | `--border` / `--input` |
| 300 | `220 14% 84%` | 强边框、分隔线 |
| 400 | `220 12% 66%` | 禁用态文字 |
| 500 | `220 10% 46%` | `--muted-foreground` |
| 600 | `220 13% 33%` | 次级文字 |
| 700 | `222 20% 22%` | 强文字 |
| 900 | `222 47% 11%` | `--foreground` |
| 950 | `222 47% 7%` | 最深（暗色 `--background`） |

### 4.2 亮色态（`:root`）

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
```

### 4.3 暗色态（`.dark`）

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

/* 图表色在暗色态需独立取值，见 §6.1 */
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
```

> **语义色 base 分模式取值**（亮色用深色 base 配白字，暗色用浅色 base 配深字）。每个语义色的四种形态均已实算验证达 WCAG AA：
>
> | 语义 | 亮 base | 亮·文字 | 亮·实心 | 暗 base | 暗·文字 | 暗·实心 |
> |---|---|---|---|---|---|---|
> | success | `#157f3c` | 4.86 | 5.08 | `#1abc55` | 6.94 | 6.01 |
> | warning | `#b35309` | 4.83 | 5.05 | `#fbbd23` | 10.29 | 8.93 |
> | info | `#0369a0` | 5.69 | 5.95 | `#0da2e7` | 6.09 | 5.75 |
> | destructive | `#dc2828` | 4.59 | 4.80 | `#ef4343` | 4.61 | 4.87 |
>
> **修正记录（2026-09-20）**：本文档早期版本声称"语义色 base 两态相同、仅 foreground 翻转"，并给出 `text-success` 暗底 5.8:1。该数字**是错的**——它从被替换掉的 green-600 值沿用而来，从未按最终采用的 green-700 复算。实测暗底仅 3.75:1，且 info 3.20:1、destructive 3.97:1、亮色态 warning 3.02:1，四项均低于 AA 阈值。现已改为分模式取值。该缺陷由代码审查的对比度实算发现。

### 4.4 导航 glass token

现有 `--nav-*` 系列保留结构，取值改为冷调（hue 220），`--nav-glass-bg` 亮态改 `220 20% 98% / 0.7`、暗态 `222 22% 11% / 0.55`。

## 5. 语义色使用规则

| 语义 | 模式 | base | hex | foreground | 文字对比 | 实心对比 | 典型用途 |
|---|---|---|---|---|---|---|---|
| success | 亮 | `142 72% 29%` | `#157f3c` | `#ffffff` | 4.86 | 5.08 | 任务成功、连接正常 |
| success | 暗 | `142 76% 42%` | `#1abc55` | `hsl(142 76% 10%)` | 6.94 | 6.01 | |
| warning | 亮 | `26 90% 37%` | `#b35309` | `#ffffff` | 4.83 | 5.05 | 进行中、即将超时 |
| warning | 暗 | `43 96% 56%` | `#fbbd23` | `hsl(43 96% 10%)` | 10.29 | 8.93 | |
| info | 亮 | `201 96% 32%` | `#0369a0` | `#ffffff` | 5.69 | 5.95 | 提示、模型信息 |
| info | 暗 | `199 89% 48%` | `#0da2e7` | `hsl(199 89% 10%)` | 6.09 | 5.75 | |
| destructive | 亮 | `0 72% 51%` | `#dc2828` | `#ffffff` | 4.59 | 4.80 | 失败、删除 |
| destructive | 暗 | `0 84% 60%` | `#ef4343` | `hsl(0 84% 10%)` | 4.61 | 4.87 | |

"文字对比" = base 直接作文字色，对 `--background` 与 `--card` 取较差者；"实心对比" = `-foreground` 对 base。全部 ≥ 4.5:1（WCAG AA 正文）。

**两种形态：**

- 实心：`bg-success text-success-foreground` — 用于按钮、强状态标签
- 浅底：`bg-success/10 text-success` — 用于徽章、行内标记（默认形态）

**注意**：`--info` 由设计稿中的 `#2563eb` 调整为 `#0369a1`。原因：`#2563eb` 与 `--primary` 完全相同，会导致"信息标签"与"主按钮"视觉无法区分。

## 6. 例外区域与独立色板

### 6.1 图表系列色（新增 token）

`src/components/stats/` 使用 10 色分类板，属**内容色**而非主题色，不转为语义色，提升为 token。

图表是图形对象，按 WCAG 1.4.11 需对背景 ≥ 3:1，因此**亮暗两态各自取值**（亮色态需压深，否则 lime/amber/teal 这类中浅色在近白底上几乎不可见）：

| token | 亮色态 HSL | 亮·hex | 亮·对比 | 暗色态 HSL | 暗·hex | 暗·对比 |
|---|---|---|---|---|---|---|
| `--chart-1` | `199 89% 40%` | `#0b87c1` | 3.83 | `199 89% 62%` | `#48bef4` | 8.26 |
| `--chart-2` | `160 84% 33%` | `#0d9b6c` | 3.39 | `160 84% 55%` | `#2cedac` | 11.47 |
| `--chart-3` | `173 80% 33%` | `#119788` | 3.46 | `173 80% 52%` | `#23e7d0` | 11.13 |
| `--chart-4` | `239 84% 67%` | `#6467f2` | 4.22 | `239 84% 74%` | `#8587f4` | 5.62 |
| `--chart-5` | `84 81% 34%` | `#659d10` | 3.15 | `84 81% 60%` | `#aaec46` | 12.28 |
| `--chart-6` | `258 90% 66%` | `#895af6` | 4.14 | `258 90% 76%` | `#ac8bf9` | 6.49 |
| `--chart-7` | `330 81% 60%` | `#ec4699` | 3.40 | `330 81% 70%` | `#f075b3` | 6.56 |
| `--chart-8` | `0 84% 60%` | `#ef4343` | 3.62 | `0 84% 68%` | `#f26969` | 5.81 |
| `--chart-9` | `50 95% 34%` | `#a98e04` | 3.06 | `50 96% 62%` | `#fbdc41` | 12.79 |
| `--chart-10` | `25 95% 45%` | `#e06106` | 3.42 | `25 95% 63%` | `#fa9247` | 7.69 |

对比度对 `--background` 与 `--card` 取较差者。**已知小瑕疵**：`chart-2`（翡翠）与 `chart-3`（青绿）色相仅差 13°，作为相邻数据系列时区分度偏弱；如需强区分可把 `chart-3` 的色相推向 188°（更偏青）。

> **修正记录（2026-09-20）**：亮色态黄色无法在近白底上同时做到"鲜明"与 3:1 达标（更亮的黄色 L≥40% 会跌破 2:1），故 `--chart-9` 刻意采用深金色 `50 95% 34%`。

### 6.2 完全豁免

| 区域 | 路径 | 理由 |
|---|---|---|
| 品牌 logo | `src/components/llm-logo-provider/` | 品牌色不可改（2 处 hex） |
| 语法高亮主题 | `react-syntax-highlighter` 的 `oneDark`/`oneLight` | 第三方库主题，不在本项目 CSS 内 |
| 终端 ANSI | `src/components/terminal/` | ANSI 标准色 |

### 6.3 编辑器外壳与 `editorStyles.ts`

`src/components/code-editor/` 的 130 处调色板类名**全部是编辑器外壳**（头部、标签页、边框、背景），**不含语法色**——语法高亮由上述第三方库提供。外壳正常转 token。

此外 `utils/editorStyles.ts` 是一个**独立主题面**：它以 JS 模板字符串注入 CodeMirror 的 CSS，并用 `isDarkMode` 布尔分支硬编码了 20+ 处 hex（`#111827`、`#1f2937`、`#374151`、`#e5e7eb` 等）。

处理方式：注入的 CSS 直接引用 `var(--card)` / `var(--border)` / `var(--foreground)` / `var(--muted)`，并**删除 `isDarkMode` 分支**——CSS 变量本身已随 `.dark` 类切换，无需 JS 判断。差异高亮的红/绿改用 `var(--destructive)` / `var(--success)` 配 alpha。

## 7. 迁移映射规则

| 裸色 | 目标 token | 估算处数 |
|---|---|---|
| `text-gray-400` | `text-muted-foreground` | 112 |
| `text-gray-500` / `text-gray-600` | `text-muted-foreground` | 132 |
| `text-gray-900` / `text-gray-100` | `text-foreground` | 57 |
| `bg-gray-800` / `bg-gray-900` | `bg-card` / `bg-background` | 61 |
| `bg-gray-100` / `bg-gray-50` | `bg-muted` | 60 |
| `border-gray-700` / `border-gray-200` | `border-border` | 73 |
| `bg-green-*` / `text-green-*` | `bg-success/10` / `text-success` | 92 |
| `bg-amber-*` / `text-amber-*` / `text-yellow-*` | `bg-warning/10` / `text-warning` | 96 |
| `bg-red-*` / `text-red-*` | `bg-destructive/10` / `text-destructive` | 129 |
| `text-blue-*` / `bg-blue-*`（作为操作色） | `text-primary` / `bg-primary` | 214 |
| `text-violet-*` / `text-purple-*` | 逐处判断：强调→`text-primary`，分类→`--chart-*` | 60 |
| `dark:*` 全部配对 | **删除**（token 已覆盖） | 579 |

**硬编码 hex**（104 处）逐处处理：`#1c3fa8`/`#1a2d5c`/`#2f5fe0`/`#5b8cff`/`#0ea5e9`/`#6366f1` → `hsl(var(--primary))`；`editorStyles.ts` 的 20+ 处按 §6.3 改为 `var(--*)`；`stats` 的 10 色按 §6.1 提升为 `--chart-*`；其余按语义归类或移入豁免区。

**`rgb()`/`rgba()` 字面量**（85 处）一律转为 `hsl()`：中性遮罩用 `hsl(0 0% 0% / 0.1)`，带色相的用 `hsl(var(--foreground) / 0.08)`。守卫测试不接受任何 `rgb(`/`rgba(` 字面量。

## 8. 验收标准

基线（2026-09-20 实测，守卫口径）：裸色 **1717**；`dark:` 裸色配对 **579**；硬编码 hex **104**；`rgb()`/`rgba()` **85**；
web `npm run typecheck` **0 error**；web `npm run lint` **0 error / 225 warning**。

1. 裸色调色板类名**为 0**（豁免区除外）：
   ```bash
   cd web && grep -rE '\b(bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b' \
     src --include=*.ts --include=*.tsx --include=*.css \
     | grep -vE 'llm-logo-provider|components/terminal'
   ```
2. `dark:` 裸色配对**为 0**（基线 579）。
3. 硬编码 hex **为 0**，豁免区（`llm-logo-provider`、`components/terminal`）除外（基线 104）。
4. `rgb()` / `rgba()` 字面量 **为 0**，豁免区除外（基线 85）。
5. 亮/暗两态下，正文文字对背景对比度 ≥ 4.5:1，大字号 ≥ 3:1；图表色等图形对象对背景 ≥ 3:1。**此项必须由守卫测试实算强制**（解析 `index.css` 的 token 值 → HSL→sRGB → WCAG 相对亮度 → 对比度），不接受人工目测——本 spec 早期版本正是因为"声称的对比度从未被实算"而写错了数字。
6. 视觉回归：任务板、聊天、侧边栏、设置四个主场景在亮暗两态下逐屏核对。
7. `npm run typecheck` 保持 **0 error**；`npm run lint` 保持 **0 error**（warning 数不高于 225）。

## 9. 实施分期

- **一期（本期）**：token 体系落地 + 语义色补齐 + 全量裸色替换 + 删除 `dark:` 补丁 + 例外区独立色板。
- **二期（不在本期）**：组件观感重做——圆角、阴影、间距、排版层级。

一期完成后，"不统一"的结构性根因即被消除；二期在此之上做视觉打磨，不阻塞、不返工。

**附带动作**：在 `docs/design-html/2026-09-16-task-panel-redesign/index.html` 顶部加废弃说明，指向本 spec，避免后续误用暖褐路线。
