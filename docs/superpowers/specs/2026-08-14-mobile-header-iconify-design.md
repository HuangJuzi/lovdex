# 聊天工作区顶部按钮手机端图标化 — 设计文档

> 状态：设计定稿 · 2026-08-14
> 定位：lovdex-cli 聊天工作区（MainContent）顶部按钮行在手机端（<640px）将文字标签收成小图标，解决「显示不全」。
> 范围：仅 lovdex-cli 前端两个文件，纯样式/JSX 级改动，零逻辑改动、零后端改动。

---

## 1. 背景与目标

聊天工作区顶部（`MainContent` header）在手机窄屏上放不下：

```
[☰] [Chat │ Files │ Source Control │ Tasks] [项目标题] [转为任务] [终端]
```

4 个 tab 的英文标签 + 右侧「转为任务/查看任务」文字按钮挤在同一行，手机端溢出或挤压，显示不全。

**目标**：手机端（<640px）把该行按钮收成小图标，保证一行放得下、不溢出。
**用户已确认的取舍**：4 个 tab 中 **Chat / Files / Source Control 缩成纯图标**（tooltip 提示），**Tasks 保留文字**（作为任务看板入口保留可发现性）；右侧 **转为任务 / 查看任务** 缩成纯图标；菜单与终端按钮本就已是图标，不动。

**不做的**（刻意排除）：
- 不把 Tab 收进 dropdown / 更多菜单——导航成本高，违背「一行图标」的诉求。
- 不动任务看板页 / 任务详情页顶部（本次范围只有聊天工作区）。
- 不做 JS 设备检测条件渲染——用纯 CSS `hidden sm:inline`，与既有惯例一致。
- 不加新测试——纯 class 级响应式改动，仓库此类改动无测试先例。

---

## 2. 方案选型

**选：方案 A —— 纯 CSS 响应式（`hidden sm:inline`）。**

| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 纯 CSS（选）** | 文字标签包 `<span className="hidden sm:inline">`；Tasks 标签不套，保持常显 | ✅ 零 JS / 零设备 hook；与 `TerminalToggleButton` 既有写法完全一致；`sm:` 断点与 Task 页 `isMobile(640)` 对齐；改动面 2 文件。❌ 无。 |
| B JS 设备检测 | `useDeviceSettings({ mobileBreakpoint: 640 })` 条件渲染 | ❌ MainContentTabs 需引入 hook；多一跳渲染；与现有 CSS 惯例不一致。 |
| C tab 收进 dropdown | 顶部只留「更多」菜单 | ❌ 导航成本高、改动面大；YAGNI，排除。 |

---

## 3. 改动设计

### 3.1 `src/components/main-content/view/subcomponents/MainContentTabs.tsx`

- 三个工作区 tab（Chat / Files / Source Control）：label 文字 `{label}` 改为包进 `<span className="hidden sm:inline">{label}</span>`，图标 `Icon` 保留；按钮补 `title={label}` 作悬停提示（对齐 `TerminalToggleButton` 的图标化写法：`<Button title="终端 (Ctrl+`)" ><TerminalIcon /><span className="hidden sm:inline">终端</span></Button>`）。
- **Tasks tab（第 4 个按钮）**：label **不套** `hidden sm:inline`，保持始终可见；同样补 `title="Tasks"`。
- 布局微调：按钮已带 `gap-1.5` 与 `justify-center`，移动端只剩图标时 gap 无副作用，`px-2` 保留做点击热区，**无需改样式 class**；`flex-1` 保持不变（图标均分、居中显示）。
- 可访问性：移动端隐藏文字后按钮 accessible name 将丢失，`title` 之外再补 `aria-label={label}` 兜底（icon svg 为装饰性元素）。

### 3.2 `src/components/main-content/view/MainContent.tsx`

- **转为任务** 按钮（`RefreshCw` + 文字）：把文字改为 `<span className="hidden sm:inline">转为任务</span>`；已有 `title="转为任务"`，移动端只留图标。
- **查看任务** 按钮（状态圆点 + `Eye` 图标 + 文字）：文字同样用 `<span className="hidden sm:inline">查看任务</span>`；**状态圆点保留**（`h-2 w-2 rounded-full`，颜色来自 `STATUS_META[linkedTask.status].color`）——它传达任务状态，与图标一起构成移动端有效信息；已有 `title="查看任务"`。
- 两按钮补充 `aria-label` 兜底，保持移动端可访问性。

### 3.3 断点约定

统一 Tailwind `sm:`（min-width 640px）——与 Task 页 `useDeviceSettings({ mobileBreakpoint: 640 })` 一致。
- `<640px`：三个 tab 与动作按钮显示纯图标，Tasks 保持文字，行内放得下。
- `≥640px`：全部恢复文字，桌面端零视觉变化（`hidden sm:inline` 是 min-width 向上恢复）。

### 3.4 不受影响的部分

- `TerminalToggleButton`：已有 `hidden sm:inline` 图标化，不动。
- `MobileMenuButton`：已是纯图标，不动。
- `MainContentTitle`：`flex-1 truncate` 自动收缩，不动。

---

## 4. 验证要点

1. `npm run typecheck`、`npm run lint`（在 `lovdex-cli`）——验收标准「零新增」：baseline 4 个 typecheck / 44 个 lint 错误均与本改动无关。
2. DevTools 375px 宽度手测：顶部一行放得下、不溢出；Chat/Files/Source Control 为纯图标，Tasks 文字可见；转为任务/查看任务为图标（查看任务仍带状态圆点）。
3. 手测点击：四个 tab 切换正常；Tasks 进入任务看板；转为任务/查看任务弹窗正常打开；终端按钮行为不变。
4. 切回 ≥640px：文字全部恢复，与改动前逐像素一致。
5. 空态（未选项目）与选中会话两种场景下 header 均正常。

---

## 5. 附：关键决策

- **纯 CSS 收字，不做 JS 条件渲染**：写法与仓库既有 `TerminalToggleButton` 完全一致，零逻辑、零测试覆盖的隐藏层。
- **Tasks 保留文字**：任务看板入口需要可发现性（用户明确要求「不包含 tasks」）。
- **查看任务保留状态圆点**：移动端去掉文字后圆点仍是状态信号，保留成本为零。
- **统一 640px 断点**：与 Task 页移动断点一致，避免出现「Task 页算移动、聊天页算桌面」的不一致。