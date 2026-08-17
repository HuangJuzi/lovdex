# 顶部按钮微调（查看任务去蓝点 + Task 页手机端隐藏看板切换）— 设计文档

> 状态：设计定稿 · 2026-08-14
> 定位：lovdex-cli 两处按钮视觉/响应式微调，改完顺手收尾「手机端图标化」的口径。
> 范围：仅 lovdex-cli 前端两个文件，纯 JSX 级改动，零逻辑、零后端。

---

## 1. 背景与目标

上一轮「聊天工作区顶部按钮手机端图标化」（`docs/superpowers/specs/2026-08-14-mobile-header-iconify-design.md`）上线后，用户反馈两处：

1. **「查看任务」按钮**：状态色圆点（蓝）与 `Eye` 图标两个元素叠加看着难受。此前已确认去掉圆点、保留眼睛；更进一步：**眼睛直接取任务状态色**，状态信号由图标颜色承载，单元素、无色块冲突。
2. **Task 页手机端**：`<640px` 时「表格」按钮本就隐藏（`hidden sm:flex`），只剩孤零零的「看板」按钮；而移动端强制看板视图（`effectiveView = isMobile ? 'board' : viewMode`），这组切换在手机上完全无用——**整组隐藏**。

**目标**：两处微调，保持上一轮「图标化」口径一致。

**不做的**：
- 不动「转为任务」按钮（用户只提了查看任务）。
- 不动终端按钮 / `ViewSwitcher` / 桌面端布局。
- 「查看任务」文字、`title`、`aria-label` 保持原样。
- 不加新测试（纯 class/JSX 级改动，仓库此类改动无测试先例）。

---

## 2. 方案选型

| 改动 | 做法 | 理由 |
|---|---|---|
| 查看任务按钮 | **去掉状态圆点 span；给 `Eye` 图标加 `style={{ color: STATUS_META[linkedTask.status].color }}`** | 状态色由眼睛承载：单元素、无「蓝点+暗图标」的色块冲突，状态信号不丢。`STATUS_META` import 继续使用，不产生 unused。 |
| Task 页手机端 | 给切换组容器 `<div className="flex rounded-lg bg-muted/50 p-0.5">` 加 **`hidden sm:flex`** | 整组 <640px 隐藏（视觉即「看板按钮」消失），≥640px 恢复；不保留空壳容器；「表格」按钮自身的 `hidden sm:flex` 保留不动，diff 最小。 |

> 备选（已否）：「表格按钮恢复可见」——用户在手机上强制看板视图，重新开放表格在手机上体验差，违背上轮共识，排除。

---

## 3. 改动设计

### 3.1 `src/components/main-content/view/MainContent.tsx` — 查看任务按钮

现状（约 111-128 行）：

```tsx
{selectedProject && linkedTask && (
  <Button
    variant="chunky"
    size="toolbar"
    className="ml-auto"
    onClick={() => navigate(`/task/${linkedTask.task_id}`)}
    title="查看任务"
    aria-label="查看任务"
  >
    <span
      className="h-2 w-2 rounded-full"
      style={{ background: STATUS_META[linkedTask.status].color }}
    />
    <Eye />
    {/* 移动端（<640px）只留圆点 + 图标 */}
    <span className="hidden sm:inline">查看任务</span>
  </Button>
)}
```

改为（删除圆点 span；`Eye` 加状态色；注释更新）：

```tsx
{selectedProject && linkedTask && (
  <Button
    variant="chunky"
    size="toolbar"
    className="ml-auto"
    onClick={() => navigate(`/task/${linkedTask.task_id}`)}
    title="查看任务"
    aria-label="查看任务"
  >
    {/* 眼睛颜色 = 任务状态色（待办黄/进行中蓝/评审紫/完成绿），不再单独画状态圆点 */}
    <Eye style={{ color: STATUS_META[linkedTask.status].color }} />
    {/* 移动端（<640px）只留状态色眼睛图标 */}
    <span className="hidden sm:inline">查看任务</span>
  </Button>
)}
```

- `Eye`（lucide 图标）的 svg 描边默认走 `currentColor`；给它显式 `style` 颜色即可覆盖按钮默认文字色（chunky 深色），桌面/移动端一致。
- `STATUS_META` 仍被引用，import 保留。

### 3.2 `src/components/tasks/TaskBoard.tsx` — 看板/表格切换组手机端隐藏

现状（约 309 行）：`<div className="flex rounded-lg bg-muted/50 p-0.5">` 内含「看板」按钮（常显）与「表格」按钮（`hidden … sm:flex`）。

改为：容器加 `hidden sm:flex`：

```tsx
<div className="hidden rounded-lg bg-muted/50 p-0.5 sm:flex">
```

- `<640px`：整组 `display:none`，「看板/表格」切换在手机端不再出现；`effectiveView` 手机端本就被强制为 `board`，无功能损失。
- `≥640px`：`sm:flex` 恢复，桌面行为逐像素不变（「表格」按钮类名不动）。

---

## 4. 验证要点

1. `npm run typecheck`、`npm run lint`（lovdex-cli）——零新增报错；无 unused import。
2. DevTools 375px 手测：
   - 有关联任务打开会话时头部只有「状态色眼睛」图标（无圆点）；无会话时仍显示「转为任务」。
   - Task 页顶部已无「看板/表格」切换，只留 ViewSwitcher + 新建任务 + 终端；一行无溢出。
3. 切回 ≥640px：查看任务按钮恢复 状态色眼睛 + 文字；Task 页「看板/表格」切换恢复。
4. 任务状态在中途切换（待办→进行中→完成）时，眼睛颜色随 `STATUS_META` 改变。
5. `npm run build` 通过。

---

## 5. 附：关键决策

- **状态信号由眼睛颜色承载**：去掉独立圆点，避免「蓝点+暗图标」叠加的视觉噪音；颜色即状态，桌面/移动端统一。
- **Task 页手机端整组隐藏切换而非只隐藏「看板」按钮**：只藏按钮会留下一个空药丸底（容器 `bg-muted/50 p-0.5`），隐藏容器才是干净的「消失」。
- **断点统一 640（`sm:`）**：与上一轮图标化、与 Task 页 `isMobile(640)` 对齐。