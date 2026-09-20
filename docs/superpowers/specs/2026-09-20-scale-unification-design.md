# Lovdex 尺度统一（圆角 / 字号 / 阴影）设计

- 日期：2026-09-20
- 状态：设计待评审
- 前置：`docs/superpowers/specs/2026-09-20-design-token-unification-design.md`（一期，色彩 token 统一，已完成并合入 main）

## 1. 背景与问题

一期把**颜色**收敛到了单一语义 token 体系。但形状与排版仍是散的——同一类"两套来源并存"的问题在三个维度上重演。

### 1.1 圆角：两个来源

`tailwind.config.js:80-84` 只覆盖了三个档位：

```js
borderRadius: {
  lg: "var(--radius)",
  md: "calc(var(--radius) - 2px)",
  sm: "calc(var(--radius) - 4px)",
}
```

其余档位（`DEFAULT`、`xl`、`2xl`、`3xl`、`full`）**来自 Tailwind 框架默认值**。后果：

- 改 `--radius` **只影响一半**——`rounded-sm/md/lg` 跟着变，`rounded/xl/2xl/3xl` 纹丝不动。
- `rounded`(4px，框架默认 `0.25rem`) 与 `rounded-sm`(4px，`calc(var(--radius) - 4px)`) **渲染值相同但来源不同**。

实际使用分布（`src/**/*.tsx`）：

| 写法 | 处数 | 渲染值 |
|---|---|---|
| `rounded-lg` | 177 | 8px |
| `rounded-md` | 138 | 6px |
| `rounded-full` | 128 | 9999px |
| `rounded` | 86 | 4px（框架默认） |
| `rounded-xl` | 61 | 12px（框架默认） |
| `rounded-2xl` | 27 | 16px（框架默认） |
| `rounded-sm` | 8 | 4px（token） |
| `rounded-r` / `rounded-t` / `rounded-l` / `rounded-br` / `rounded-b` | 17 | 方向性 |
| `rounded-3xl` | 2 | 24px（框架默认） |
| `rounded-none` | 2 | 0 |
| `rounded-[3px]` | 2 | 3px（任意值） |
| 带尺寸的方向性（`rounded-r-lg` 等） | 12 | — |

另有 `src/index.css` 内 5 处硬编码 `border-radius`（3px ×3、4px ×1、8px ×1）。

### 1.2 字号：10 种取值，其中 153 处是硬编码像素

`fontSize` **未被 config 覆盖**，命名档位用 Tailwind 默认值；但项目里大量使用任意值：

| 渲染尺寸 | 写法 | 处数 |
|---|---|---|
| 14px | `text-sm` 430 + `text-[14px]` 1 | 431 |
| 12px | `text-xs` 329 + `text-[12px]` 3 | 332 |
| **11px** | `text-[11px]` | **82** |
| **10px** | `text-[10px]` | **49** |
| 18px | `text-lg` | 20 |
| 16px | `text-base` | 11 |
| 9px | `text-[9px]` | 10 |
| 13px | `text-[13px]` | 7 |
| 20px | `text-xl` | 4 |
| 10.5px | `text-[10.5px]` | 1 |

共 10 种渲染尺寸。其中 `text-[12px]`/`text-[14px]` 是 `text-xs`/`text-sm` 的**纯重复**；`text-[11px]` 是第二高频尺寸（82 处）却没有名字。

### 1.3 阴影：两种视觉语言并存

- 命名阴影 7 种：`shadow`(47)、`shadow-sm`(41)、`shadow-lg`(18)、`shadow-2xl`(17)、`shadow-md`(9)、`shadow-none`(5)、`shadow-xl`(3)。
- **任意值阴影 40 处**，是硬边"3D 按压"风格（一期迁移时引入），其中 5 种配方在重复使用：

| 配方 | 处数 |
|---|---|
| `0 2px 0 hsl(var(--foreground)/0.10), 0 4px 10px hsl(var(--foreground)/0.06)` | 9 |
| `0 3px 0 hsl(var(--foreground)/0.07), 0 12px 26px hsl(var(--foreground)/0.07)` | 6 |
| `0 2px 0 hsl(var(--foreground))` | 5 |
| `0 2px 0 hsl(var(--foreground)/0.08)` | 4 |
| `0 3px 0 hsl(var(--foreground)/0.08), 0 6px 16px hsl(var(--foreground)/0.07)` | 3 |

### 1.4 间距：健康，不在本期范围

padding/gap 大体落在 4px 网格上（`px-2` 137、`py-2` 130、`gap-2` 157…），未发现失控。

## 2. 目标与非目标

### 2.1 目标

- 圆角、字号、阴影各自收敛为**单一具名刻度**，消除"两个来源"。
- 消灭 `rounded-[…]` 与 `text-[…px]` 任意值（共 154 处）。
- 把重复的 3D 阴影配方提成具名工具类。
- 新增守卫测试，防止任意值回潮。
- **观感不变**——除下文 §5.2 明列的 8 处字号吸附外，渲染结果与今天逐像素一致。

### 2.2 非目标（本期不做）

- **不做观感重做**：不改变字号层级、不调整密度、不统一两种阴影风格。这些需要先改变观感，属将来独立一期。
- 不改动间距（§1.4 已健康）。
- 不改动颜色 token（一期已完成）。
- 不改动布局、交互、信息架构。

### 2.3 本期的价值定位

视觉上几乎看不出变化。**价值在于让下一次改动变便宜**：今天把 11px 调成 12px 要改 82 个位置，收完之后改 1 行 config；今天改 `--radius` 只影响一半，之后一个旋钮控制全部。这是为将来那次真正的排版调整铺路。

## 3. 关键设计决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 圆角来源 | **全部由 `--radius` 派生** | 消除"改一个旋钮只动一半"的陷阱 |
| `rounded` 与 `rounded-sm` 同值冗余 | **保留两个名字，同源** | 合并需改 86 处且无视觉收益；来源统一已解决实际问题 |
| `xs`(3px) 与 `sm`(4px) 冗余 | **保留** | 合并会改观感（1px），越界 |
| 字号命名风格 | 沿用 Tailwind 的 `xs/sm/base/lg/xl`，向下扩展 `2xs/3xs/4xs` | 不重命名 430 处 `text-sm`；新增档位补在下方不冲突 |
| 13px / 10.5px 离群值 | **吸附**到最近档位（14px / 11px） | 见 §5.2 |
| 两种阴影风格 | **不统一**，仅把重复配方具名 | 统一需要观感决策，越界 |
| 是否改 `--radius` 的值 | **否**，保持 `0.5rem` | 改值会改观感 |

## 4. 圆角刻度

### 4.1 目标定义（`tailwind.config.js`）

```js
borderRadius: {
  DEFAULT: "calc(var(--radius) - 4px)",   // 4px — 与 sm 同值，但同源
  xs:  "calc(var(--radius) - 5px)",       // 3px
  sm:  "calc(var(--radius) - 4px)",       // 4px
  md:  "calc(var(--radius) - 2px)",       // 6px
  lg:  "var(--radius)",                   // 8px
  xl:  "calc(var(--radius) + 4px)",       // 12px
  "2xl": "calc(var(--radius) * 2)",       // 16px
  "3xl": "calc(var(--radius) * 3)",       // 24px
  full: "9999px",
}
```

`--radius` 保持 `0.5rem`。上表右侧注释是 `--radius = 0.5rem` 时的渲染值，**与当前逐值一致**。

### 4.2 迁移映射

| 当前 | 目标 | 处数 |
|---|---|---|
| `rounded` | 不变（值同，来源改） | 86 |
| `rounded-sm` / `rounded-md` / `rounded-lg` / `rounded-xl` / `rounded-2xl` / `rounded-3xl` / `rounded-full` / `rounded-none` | 不变 | 543 |
| `rounded-[3px]` | `rounded-xs` | 2 |
| `rounded-[inherit]` | **保留**（继承语义，非尺寸） | 1 |
| `src/index.css` 的 `border-radius: 3px/4px/8px` | 分别改为 `var(--radius-*)` 或对应工具类 | 5 |
| 方向性（`rounded-r` 3、`rounded-r-lg` 4、`rounded-t-2xl` 3、`rounded-l-lg` 2、`rounded-t-lg` 1、`rounded-r-md` 1、`rounded-br-md` 1、`rounded-t-none` 1、`rounded-b-none` 1） | 保持方向前缀，尺寸部分按上表映射 | 17 |

方向性写法本身**不需要改**——它们引用的是同一套档位名，档位改了它们自动跟随。

## 5. 字号刻度

### 5.1 目标定义（`tailwind.config.js` 新增 `fontSize`）

```js
fontSize: {
  "4xs": "9px",
  "3xs": "10px",
  "2xs": "11px",
  xs:    "12px",   // Tailwind 默认，显式写出
  sm:    "14px",   // Tailwind 默认，显式写出
  base:  "16px",
  lg:    "18px",
  xl:    "20px",
  // 2xl 及以上保持 Tailwind 默认，本期未使用
}
```

显式写出 `xs`/`sm` 等默认值，是为了让**刻度表在一个地方可见**，而不是"一半在 config、一半在框架"——与 §1.1 圆角的问题是同一个道理。

**不设置 `lineHeight`**：当前所有用法都未指定行高，Tailwind 默认行高随字号变化。给新档位设行高会改观感。

### 5.2 8 处离群值的吸附（本期唯一视觉变化）

| 当前 | 目标 | 处数 | 差异 |
|---|---|---|---|
| `text-[13px]` | `text-sm`（14px） | 7 | +1px |
| `text-[10.5px]` | `text-2xs`（11px） | 1 | +0.5px |

**理由**：若为这两个值保留具名档位，刻度表会变成 `9/10/10.5/11/12/13/14`——那不是刻度，是清单，中央控制的价值随之消失。吸附后刻度是 `9/10/11/12/14/16/18/20`，仍不完美（缺 13、15），但至少是单调递增的。

这 8 处已在设计预览中按**实际大小**并排展示，肉眼难以分辨。**这是本期唯一偏离"逐像素一致"的地方，如需严格一致可改为具名保留。**

### 5.3 迁移映射

| 当前 | 目标 | 处数 |
|---|---|---|
| `text-sm` / `text-xs` / `text-base` / `text-lg` / `text-xl` | 不变 | 794 |
| `text-[11px]` | `text-2xs` | 82 |
| `text-[10px]` | `text-3xs` | 49 |
| `text-[9px]` | `text-4xs` | 10 |
| `text-[13px]` | `text-sm`（吸附） | 7 |
| `text-[12px]` | `text-xs` | 3 |
| `text-[14px]` | `text-sm` | 1 |
| `text-[10.5px]` | `text-2xs`（吸附） | 1 |

## 6. 阴影刻度

### 6.1 命名阴影：保持不变

7 种命名阴影沿用 Tailwind 默认值，**不新增 token、不改取值**。加 token 会带来"暗色态该不该不同"的问题，而那需要观感决策。

### 6.2 把 5 种重复的 3D 配方具名

在 `tailwind.config.js` 的 `boxShadow` 中新增：

```js
boxShadow: {
  "raised-xs": "0 2px 0 hsl(var(--foreground) / 0.08)",
  "raised-sm": "0 2px 0 hsl(var(--foreground) / 0.10), 0 4px 10px hsl(var(--foreground) / 0.06)",
  "raised-md": "0 3px 0 hsl(var(--foreground) / 0.08), 0 6px 16px hsl(var(--foreground) / 0.07)",
  raised:      "0 3px 0 hsl(var(--foreground) / 0.07), 0 12px 26px hsl(var(--foreground) / 0.07)",
  pressed:     "0 2px 0 hsl(var(--foreground))",
}
```

取值与现有内联值**逐字一致**，零视觉差异。5 种一次性配方（各 1 处）保持内联并加注释说明为何不具名。

## 7. 迁移映射汇总

| 维度 | 需改动处数 |
|---|---|
| 圆角（任意值 + CSS 硬编码） | 7 |
| 字号（任意值） | 153 |
| 阴影（5 种重复配方 → 类名） | 27 |
| **合计** | **187** |

其余（圆角 629 处、字号 794 处）**类名不变**——它们已经引用了正确的档位名，只是档位的定义从框架默认改到了 config。

## 8. 验收标准

基线（2026-09-20 实测）：`rounded-[…]` 3 处；`text-[…px]` 153 处；`shadow-[…]` 40 处；`index.css` 硬编码 `border-radius` 5 处；`npm run typecheck` 0 error；`npm run lint` 0 error / 225 warning；测试 512 pass / 0 fail。

1. `text-[…px]` 任意值**为 0**（基线 153）。
2. `rounded-[…]` 任意值仅剩 `rounded-[inherit]` 1 处（基线 3）。
3. `index.css` 硬编码 `border-radius` **为 0**（基线 5）。
4. 5 种重复 3D 配方在 `.tsx` 中出现次数**为 0**（全部改为具名类）。
5. 新增守卫断言：禁止 `text-[…px]` 与 `rounded-[…]` 回归。
6. `npm run typecheck` 保持 0 error；`npm run lint` 保持 0 error（warning 不高于 225）。
7. 测试全绿（不低于 512 pass）。
8. **视觉一致性抽查**：亮/暗两态下，圆角与字号的渲染结果与改动前一致（§5.2 的 8 处除外）。建议对任务板、聊天、侧边栏、设置四屏做前后截图对比。

## 9. 与一期及将来的关系

- **一期**（色彩 token）：已完成，合入 main。
- **本期**（尺度统一）：零视觉差异的重构，让刻度可集中控制。
- **将来**（观感重做）：在本期之上做真正的视觉决策——建立字号层级、统一两种阴影风格、调整密度、清理 `xs`(3px)/`sm`(4px) 这类冗余档位。**本期刻意不做这些，因为它们都会改变观感。**

本期完成后，将来那一期的成本会显著降低：改字号层级变成改 config，而不是改 150 个位置。
