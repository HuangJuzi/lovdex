# Lovdex Token 统计页：TPM 曲线与面积的关系修复 设计

- 日期：2026-09-29
- 状态：待评审
- 范围：前端（仅 `web/src/components/stats/widgets/TpmChartCard.tsx` 一处 + 一个常量）
- 前置文档：`docs/superpowers/specs/2026-09-17-token-usage-stats-design.md`（本设计是其增量修订）

## 1. 背景与目标

### 1.1 用户反馈

用户原话：

> TPM 变化那个页面，曲线的颜色是不是应该和下面面积的延时保持一致，现在混在一起感觉很怪，
> 会给人曲线颜色是模型 tpm 变化曲线的错觉

经逐项对齐后确认，所指是**同一模型的曲线（描边）与它自己那块色带（填充）在视觉上对不上**——
不是「图表 vs 构成占比条」，也不是「曲线整体像一组独立折线」。

用户的期望形态是 **A：曲线 = 这块面积的轮廓**。也就是说，图里应当读不出「5 条彼此不同的线」，
每条曲线都应读作它自己那块色带的边界。

### 1.2 目标

让曲线在视觉上成为**它自己那块色带的边界**，而不是一个独立对象。

### 1.3 非目标（明确不做）

- **不动色板与色号语义**：`colorForModel` / `MODEL_COLORS` / `chart-1..10` token 全部保持。
  图例色块、Tooltip 色块、构成条色块的颜色**一个都不变**。
- **不动**堆叠顺序（`buildChartRows` 按 all-token 降序）、`stackId="tpm"`、`type="monotone"`、
  两轴与刻度逻辑、Tooltip 结构、空态分支、口径 / 维度控件。
- **不动构成条**。本轮评审中同时提出了「构成条与模型色板共用前四个色号（`chart-1/2/9/6`）」
  的问题，用户明确选择 **A：保持现状**，该项不在本次范围内。详见 §7 附录 A。
- **不解决**「数据严重偏斜时薄层边界本身很淡」。见 §5。

## 2. 现状（实测）

### 2.1 两层 DOM，同一个色号，却算出两个颜色

recharts 的 `Area` 对每个数据系列渲染**两个独立的 SVG 路径**（`web/node_modules/recharts/es6/cartesian/Area.js`，
`StaticArea` → `Shape` → `defaultAreaProps.shape`，先渲 `recharts-area-area` 后渲 `recharts-area-curve`）：

| 层 | class | 属性 |
|---|---|---|
| 填充 | `recharts-curve recharts-area-area` | `fill=<color>`，`stroke="none"` |
| 描边 | `recharts-curve recharts-area-curve` | `stroke=<color>`，`fill="none"` |

`TpmChartCard.tsx:397-409` 给两者的**色号本来就是同一个** `colorForModel(key, keys)`：

```jsx
stroke={colorForModel(key, keys)}
fill={colorForModel(key, keys)}
fillOpacity={0.35}
strokeWidth={1.5}
```

但描边**没有设 `strokeOpacity`**，SVG 默认 `α = 1`。

### 2.2 在线上页面实测到的合成色

1440 视口连 dev server（`:5188`）的 `/stats`，`deviceScaleFactor=2`，24 小时 / 按模型。
工具：puppeteer-core 取 `svg.recharts-surface` 的紧裁切截图 + pngjs 逐像素读列。

取「色带最厚的那一列」（实测 `cssX=473`），沿 y 逐像素读到的原始值：

```
y= 53.5  #ffffff     ← 绘图区留白
y= 56    #d4dfe2     ← 抗锯齿
y= 56.5  #8962d0     ← 抗锯齿
y= 57    #895af6     ← ★ 顶层那条曲线的描边：等于 chart-6 本身
y= 59.5  #8a5de6
y= 60    #8b60dc       ↓ 同一层自己的填充，从描边下方开始
y= 65    #777ba1         一路向底色渐变，没有任何一段是恒定色
y= 70    #80b5cb
y= 73.5  #aad5e9     ← 稳定在「chart-1 α=0.35 叠在白底上」的结果
y=211.5  #6a7181     ← 网格线
```

**同一个色号（`chart-6`，即 `glm-5.3-flash`），描边实测 `#895af6`、它自己下方的填充实测
`#aad5e9`。** 前者是纯的源色（α=1，未被底色混），后者是混出来的。

判定要点：`#895af6` 这个值在图里**只以描边形式出现，从不作为任何填充的合成结果出现**——
这就是用户所说的「另一个颜色」，也是「曲线像一条独立折线」的视觉来源。

### 2.3 实际数据形态（决定了薄层问题的量级）

24 小时区间各模型 all-token 占比（取自 `GET /api/stats/token-usage/timeseries`）：

| 模型 | 占比 |
|---|---|
| DeepSeek-Flash | 83.4% |
| claude-opus-4-8 | 9.2% |
| DeepSeek-V4-Pro-0813 | 6.7% |
| glm-5.3-flash | 0.5% |
| DeepSeek-V4-Flash-0731 | 0.2% |

后两个模型在图上本来就是贴地的薄带。

## 3. 改动本体

### 3.1 新增常量

`web/src/components/stats/widgets/TpmChartCard.tsx`（放在 `MINUTE_MS` 附近）：

```ts
/**
 * 色带与其边界线共用的不透明度。
 *
 * 两者必须一致：描边若用实色（SVG 默认 α=1），它和同层的半透明填充会在
 * 同一块底色上合成出两个不同的颜色，曲线看起来就成了「另一个东西」——
 * 用户会把它读成一条独立的模型 TPM 折线，而不是这块色带的边界。
 */
const AREA_OPACITY = 0.35;
```

### 3.2 应用到 `<Area>`（现 `TpmChartCard.tsx:397-409`）

```jsx
<Area
  key={key}
  type="monotone"
  dataKey={key}
  stackId="tpm"
  stroke={colorForModel(key, keys)}
  fill={colorForModel(key, keys)}
  fillOpacity={AREA_OPACITY}
  strokeOpacity={AREA_OPACITY}   // ← 新增
  strokeWidth={1.5}
  isAnimationActive={false}
/>
```

### 3.3 为什么这样就够（机制）

SVG 合成公式：

```
结果 = 源色 × α + 底色 × (1 − α)
```

描边之所以看着是「另一个颜色」，是因为它 `α = 1`，结果直接等于源色；而同层填充 `α = 0.35`，
结果是源色与底色的混合。**同色号 → 两个结果**。

把 `α` 对齐到 0.35 后：

- 源色相同——两者本来就取自同一个 `colorForModel(key, keys)`；
- 底色相同——描边描在填充的上边界上，其下方叠的正是这一层的填充 + 它下面那层；
- `α` 相同。

三项逐项相等 ⇒ 合成结果恒等 ⇒ 曲线在数学上成为色带边界的一部分。

**为什么 `fillOpacity` 与 `strokeOpacity` 共用一个常量**：结构上堵住「将来只改一处」把这个性质
悄悄破坏掉——两者一旦不等，本设计就退回现状，而这不会触发任何测试失败，只能靠人眼发现。

## 4. 验证

### 4.1 单元测试

`web/src/components/stats/` 的测试是纯 `node:test` + `renderToStaticMarkup`
（见 `TpmChartCard.test.tsx:4-6`、`vite.config.ts` 未配 jsdom 环境）。`TpmChartCard` 的既有测试
全部走 `timeseries={null}` 的空态分支，注释里写明原因：

> `renderToStaticMarkup` 不跑 effect；timeseries 传 null 时卡片走空态分支，
> 因此不会渲染 recharts（SSR 下 ResponsiveContainer 量不到尺寸）。

即**无法在 DOM 层断言曲线颜色**。因此断言落在源码级：读 `TpmChartCard.tsx` 文本，
断言每个 `<Area>` 的 `stroke` 与 `fill` 取值相同、`strokeOpacity` 与 `fillOpacity` 取值相同。
这是弱断言，但能挡住本设计唯一害怕的回归（两者被改得不一致）。

### 4.2 浏览器验证（真正的验收）

判据是**可证伪的**：渲染后取像素，**曲线的合成色必须等于同层填充的合成色**。
采样方法与 §2.2 相同（元素紧裁切 + `deviceScaleFactor=2` + pngjs 逐列扫描）。

覆盖组合：

| 维度 | 取值 |
|---|---|
| 时间范围 | 24 小时、7 天 |
| 维度 | 按模型、按厂商 |
| 主题 | 亮色、暗色 |

同时用 §2.2 的同一列做前后对照——`#895af6`（描边）与 `#aad5e9`（其下方填充）这一对，
改动后描边的合成值必须落到填充那一侧，不再出现「纯源色」。这是本次最能说明问题的单点验证。

### 4.3 回归

跑 stats 相关的 `npx tsx --test` 文件，确认零新增失败
（注意：`web/` 无 vitest，必须显式列文件跑 `node:test`）。

## 5. 已知残留与措辞澄清

### 5.1 已知残留（如实记录，不假装修好了）

1. **薄层边界依然很淡。** 两个 0.2% / 0.5% 的模型，色带本来就薄，`α=0.35` 下边界也淡。
   这是**堆叠面积图在极端偏斜数据下的固有性质**，不是本设计引入的，本次也不解决。
2. **陡坡处仍有一丝色差。** 1.5px 的描边会横跨斜边两侧略微不同的底色，合成结果不会严格相等。
   但那是**同一桶颜料**的差，不是第二个色号，不会再被读成独立曲线。
3. **实测顶部边界只占约 1 个 CSS px。** 名义 `strokeWidth` 是 1.5，但实测顶层描边在
   y=56.5→59.5 之间（约 3px 含抗锯齿，纯色段仅 y=57 一行）。原因：SVG 以路径为中心渲染描边，
   多出的一半落在绘图区之外。**这不是 recharts 显式加的 `clipPath`**——实测同一列在
   svg 顶边（y=0）之下就有颜色（y≈0.5 起）。视觉上够用，但不如标称值厚，如实记录。

### 5.2 关于「面积延时」的措辞

用户原话中的「面积的延时」应理解为**面积的呈现 / 视觉表现**（渲染色），不是时间维度上的延迟——
图上没有任何时间偏移逻辑，两层用的是同一组 `x` 坐标。本设计按「渲染色不一致」处理。

这一处措辞在动手前已向用户确认过，用户确认所指为「曲线 vs 同模型面积的填充」。

## 6. 影响面

- 改动文件：`web/src/components/stats/widgets/TpmChartCard.tsx`（+ 对应测试文件）。
- 用户可见变化：曲线变淡、与色带融为一体；**颜色语义零变化**，图例 / Tooltip 的色块仍是不透明实色。
- 风险面：极小。无数据流、无接口、无后端改动；`Area` 的属性增减不影响堆叠计算。

## 7. 附录

### 附录 A：本次评审中提出但**未采纳**的两项

**A.1 构成条与模型色板共用前四个色号。**

`componentShares`（`format.ts:293`）用 `chart-1 / chart-2 / chart-9 / chart-6`，
而 `MODEL_COLORS`（`format.ts:218`）的前四位是 `chart-1 / chart-2 / chart-9 / chart-6 / chart-8`。
按当前真实数据，`glm-5.3-flash`（紫 `chart-6`）与「缓存写入」（紫 `chart-6`）确实是同一个色号。

用户明确选择 **A：保持现状**，故本次不动。

**A.2 曾考虑的「把构成条挪到分类板尾部」方案，已被数据否掉。**

挪到 `chart-5` / `chart-10` 等尾部色号可以避开撞车，但实测「输出」只占 **0.07%**——
在 900px 宽的构成条上约 0.6px。与旁边 39.1% 的「缓存读取」并排时它几乎不可见，
**换色号解决不了这个问题**。记录在此，避免后续重复提出同一个方案。

### 附录 B：评审过程

- 现象定位：终端提问（曲线 vs 同模型填充 / 图表 vs 构成条 / 曲线整体）→ 用户答**前者**。
- 形态选择：浏览器 companion 渲染四块真实数据对比（现状 / 同透明度 / 去描边 / 同透明度 + 加粗）
  → 用户选 **B**（同色同透明度 1.5px）。
- 构成条：浏览器渲染三块（现状 / 中性阶 / 去色）→ 终端答 **A**，保持现状。

> 过程备注：构成条那一问，用户在浏览器里先后点了 B 与 C，且与终端回答（A）不一致。
> 经回问后用户确认以终端 **A** 为准。记录在此，避免日后回溯时误判意图。

### 附录 C：曾评估并否掉的方案

| 方案 | 否掉理由 |
|---|---|
| C：去掉描边 | 只剩填充时，被压薄的层退化成一条细的纯色带，**反而更像折线**——病没治好，还丢了边界。 |
| D：同透明度但加粗到 2.5px | 会让 0.2% 占比的模型变粗成一条抢眼的重线，把「这是一条折线」的读法请回来。 |
