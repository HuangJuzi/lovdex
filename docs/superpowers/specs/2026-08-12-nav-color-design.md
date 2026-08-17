# 导航配色丰富化 — 设计文档

> 状态：设计定稿 · 2026-08-12
> 定位：为 lovdex-cli 的顶层导航（Chat/Task 切换）与返回按钮（返回任务面板/返回主页）补充色彩，解决「太素」问题。
> 范围：仅 `src/components/tasks/ViewSwitcher.tsx` 与 `src/components/tasks/TaskBackNav.tsx` 两个组件，纯样式类改动。

---

## 1. 背景与目标

当前导航元素均为单色（muted 底 + 灰字灰图标），视觉上过于朴素，无法快速区分「会话 / 任务」两个顶级视图与返回动作。目标：在不改变交互与布局的前提下，用克制的色彩让导航更有辨识度与活力。

**方案：C 全彩胶囊**（用户从 A/B/C/D 四套 HTML 预览中选定）。

**不做的**：
- 不改引擎色（Claude 绿 / Codex 琥珀 / SophCode 紫）、状态色（看板列）、`TaskCard` 等其它色彩体系。
- 不改布局、尺寸、断点、交互（onClick/navigate 不变）。
- 不改后端、不加依赖、不改 i18n。

---

## 2. 改动明细

### 2.1 `ViewSwitcher.tsx`（Chat / Task 顶层切换）

`items` 数组为每个 tab 增加品牌色字段：

| tab | 激活态（active） | 图标色 |
|---|---|---|
| Chat | `bg-sky-500 text-white shadow-sm shadow-sky-500/30` | `text-sky-500`（未激活）；激活时图标 `text-white` |
| Task | `bg-emerald-500 text-white shadow-sm shadow-emerald-500/30` | `text-emerald-500`（未激活）；激活时图标 `text-white` |

- 未激活按钮：保持 `text-muted-foreground hover:text-foreground`，图标用各自品牌色。
- segmented 容器 `flex rounded-lg bg-muted/50 p-0.5`、按钮尺寸/间距不变。

影响面：`ViewSwitcher` 用于 `MainContent.tsx`（chat 激活）、`TaskBoard.tsx`（tasks 激活）、`TaskDetail.tsx`（tasks 激活），三处统一生效。

### 2.2 `TaskBackNav.tsx`（返回按钮）

| 按钮 | outline 基类之上的覆盖 |
|---|---|
| 返回任务面板 | `border-blue-500/30 bg-blue-500/5` + ArrowLeft `text-blue-600`；hover `hover:bg-blue-500/10 hover:text-blue-600` |
| 返回主页 | `border-amber-500/30 bg-amber-500/5` + Home `text-amber-600`；hover `hover:bg-amber-500/10 hover:text-amber-600` |

- 通过 `cn`（twMerge）覆盖 `Button variant="outline"` 基类的 `border-input bg-background` 与 `hover:bg-accent hover:text-accent-foreground`（同 modifier 冲突取后者）。
- 移动端隐藏主页按钮（`hidden sm:inline-flex`）不变。
- 默认文字色保持 muted-foreground，hover 变品牌色（与预览一致）。

---

## 3. 验证

1. `npm run typecheck` 无报错。
2. `npm run lint` 无 error。
3. `npm run dev` 手测：
   - 聊天页 header：Chat 激活为天蓝实心胶囊、Task 图标翠绿；
   - Task 看板 / 详情 header：Task 激活为翠绿实心胶囊、Chat 图标天蓝；
   - TaskDetail / OperatorSettingsPage 返回按钮带蓝/琥珀色描边 + 浅色底，hover 加深；
   - 深色模式可读。

---

## 4. 文件清单

| 文件 | 改动 |
|---|---|
| `src/components/tasks/ViewSwitcher.tsx` | items 加色字段 + 按钮/图标 className 条件化 |
| `src/components/tasks/TaskBackNav.tsx` | 两个按钮加彩色 className |
