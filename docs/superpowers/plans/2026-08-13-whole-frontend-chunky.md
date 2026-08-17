# 全站 chunky 风格统一 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 按 W4 立体厚板风格把前端框架层(共享组件/侧栏/任务看板/详情/弹窗/聊天框架/终端外壳)统一重做。

**Architecture:** chunky 语言定义为一组内联类字符串配方(见 spec),下沉到共享组件(Card/Input/Dialog/PillBar/Badge/ViewSwitcher),再逐面应用到页面。**硬约束:只改 className/样式类字符串,禁止任何逻辑/结构/行为改动。** 每任务独立提交,完成后全量 typecheck + 测试套件(222 项)必须全绿。

**Tech Stack:** React + Tailwind CSS + cva + lucide-react;测试 node:test + SSR。

---

## 通用前置(每个任务都要带上)

- 工作目录:`/mnt/b/workdir/github/lovdex/lovdex-cli`,git 分支 `main`。
- **环境坑:** `TSX_TSCONFIG_PATH=server/tsconfig.json` 全局导出会破坏 tsx;跑测试必须 `env -u TSX_TSCONFIG_PATH node --import tsx --test <file>`。
- 类型检查:`npm run typecheck`。
- 提交信息必须以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。
- **硬约束(对每个任务):只能改 className / Tailwind 类字符串。禁止改动:逻辑、数据流、状态、API 调用、组件结构/层级、DOM 标签、aria/role、onClick 等事件属性、i18n 文案。暗色用 `dark:` 覆盖。** 若必须动结构才能达到效果 → 报告 DONE_WITH_CONCERNS,不要自作主张。

## 样式配方(内联使用)

- `CHUNKY_CARD` = `rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)]`
- `CHUNKY_INPUT` = `h-10 w-full rounded-xl border-2 border-border bg-card px-3.5 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50`
- `CHUNKY_NAV_ACTIVE` = `bg-card font-medium text-card-foreground shadow-[0_3px_0_#d8d5cd,0_6px_16px_rgba(35,33,41,0.07)]`
- `CHUNKY_GROUP` = `rounded-xl border border-border/70 bg-muted/60 p-[3px]`
- `CHUNKY_ACTIVE` = `bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]`
- `CHUNKY_DIALOG` = `rounded-2xl border border-border/80 bg-popover text-popover-foreground shadow-[0_3px_0_rgba(30,27,50,0.08),0_24px_60px_rgba(20,17,12,0.28)]`

---

### Task 1: 共享组件下沉 chunky 语言

**Files:**
- Modify: `src/shared/view/ui/Card.tsx`、`Input.tsx`、`Dialog.tsx`、`PillBar.tsx`、`Badge.tsx`
- Modify: `src/components/tasks/ViewSwitcher.tsx`

- [ ] **Step 1: Card.tsx** — 把 base 类 `'rounded-xl border bg-card text-card-foreground shadow-sm'` 换成 `CHUNKY_CARD`(其余子组件不动)。

- [ ] **Step 2: Input.tsx** — 把 base 类整体换成 `CHUNKY_INPUT`(保留 `file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground` 三个 file: 前缀类)。原类含 `shadow-sm`、`rounded-md border border-input bg-transparent`、`focus-visible:ring-1 ring-ring`。

- [ ] **Step 3: Dialog.tsx** — `DialogContent` 挂载层(约 L194-199)的类 `'rounded-xl border bg-popover text-popover-foreground shadow-lg'` 换成 `CHUNKY_DIALOG`。遮罩层 `bg-black/50 backdrop-blur-sm` 不动。

- [ ] **Step 4: PillBar.tsx** — 容器换成 `CHUNKY_GROUP`;`Pill` 的激活类 `'bg-background text-foreground shadow-sm'` 换成 `CHUNKY_ACTIVE`;Pill 基础类 `rounded-md` 保持。

- [ ] **Step 5: Badge.tsx** — 基础串 `rounded-md` → `rounded-lg`(仅圆角,不动 variant)。

- [ ] **Step 6: ViewSwitcher.tsx** — 容器 `'flex rounded-lg bg-muted/50 p-0.5'` → `'flex rounded-xl border border-border/70 bg-muted/50 p-0.5'`;子按钮基础 `rounded-md` → `rounded-lg`;两个 `activeClass`(`bg-sky-500 text-white shadow-sm shadow-sky-500/30` 与 `bg-emerald-500 ...`)都换成 `CHUNKY_ACTIVE`;图标激活态 `isActive ? 'text-white' : iconClass` 中 `text-white` → `text-primary`。

- [ ] **Step 7: 校验 + 提交**

```bash
npm run typecheck
git add -A
git commit -m "style(ui): apply chunky design language to shared primitives"
```

---

### Task 2: 侧栏

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`、`SidebarProjectList.tsx`、`SidebarHeader.tsx`、`SidebarAssistant.tsx`

**提示:** 逐个文件先读,再改。只动 className。

- [ ] **Step 1: SidebarContent** — 根容器类 `bg-background/80 backdrop-blur-sm` → `bg-card`(去掉 blur,实心白卡)。其余不动。

- [ ] **Step 2: SidebarProjectList** — 项目/会话「导航项」基础 hover 用 `hover:bg-muted`;「激活态」类(项目当前项/会话激活行)换成 `CHUNKY_NAV_ACTIVE` 配套结构(图标在激活态改 `text-primary`)。仅样式,保留选中逻辑与图标文案。

- [ ] **Step 3: SidebarHeader** — 搜索输入框 className 若含 `rounded-md border-input` 之类的换成 2px 硬边红圈(可用 `border-2 border-border ... focus-visible:ring-2 focus-visible:ring-ring/50 rounded-xl`);logo/标题/刷新按钮仅轻微圆角对齐,不换结构。

- [ ] **Step 4: SidebarAssistant** — 助手入口行激活态(当前高亮会话)用 `CHUNKY_NAV_ACTIVE`,hover 底色 `hover:bg-muted`;图标激活 `text-primary`。

- [ ] **Step 5: 校验 + 提交**

```bash
npm run typecheck
git add -A
git commit -m "style(sidebar): chunky nav items, active state white card"
```

---

### Task 3: 任务看板(看板视图 + 任务卡)

**Files:**
- Modify: `src/components/tasks/TaskBoard.tsx`、`TaskCard.tsx`

- [ ] **Step 1: TaskBoard 头部** —（六按钮已在 chunky;本节不动按钮。）看板列容器/列头(约 L390 起)若为纯文字 + `bg-card` 灰底,维持;看板容器保持页面底色,不套卡。仅检查是否残留旧按钮样式(如有,none)。

- [ ] **Step 2: TaskBoard 新建任务表单** — 表单内 `<textarea>`、`<Input>`、`<select>`、`<input type="date">` 的硬边:使用 `Input` 组件的自动获得新样式;手写 textarea/select/date 的 className 若有 `rounded-md border border-input bg-muted` 等,换成 `CHUNKY_INPUT` 变体(textarea 保留 py/rows 语义;select 保留 pr 下拉箭头 padding;**不改任何 onChange/value/option**)。

- [ ] **Step 3: TaskBoard 弹窗/遮挡层类** — `DialogContent` 已通过 Task 1 变 chunky;不需要改。

- [ ] **Step 4: TaskCard** — 卡片容器(约 L44)由 `'rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/50'` 换成 chunky 卡片 + 微浮起:
  `'rounded-2xl border border-border/70 bg-card p-3 transition-all shadow-[0_3px_0_rgba(30,27,50,0.07),0_8px_18px_rgba(35,33,41,0.05)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_rgba(30,27,50,0.08),0_12px_24px_rgba(35,33,41,0.10)]'`
  徽章(Label/优先级/状态/模型)圆角 `rounded-full` 保留;灰色小徽章 `rounded-full bg-muted` 保留。

- [ ] **Step 5: TaskCard 动作按钮** — `开始执行`/`重试` 类 `bg-primary` 按钮加底部硬边:`shadow-[0_2px_0_#1c3fa8]`(保留 `bg-primary text-primary-foreground hover:bg-primary/90`);`标记完成`(绿)与 `打开会话`(primary 软底)加 `shadow-[0_2px_0_rgba(30,27,50,0.08)]`。**保留全部 onClick/e.stopPropagation。**

- [ ] **Step 6: 校验 + 提交**

```bash
npm run typecheck
git add -A
git commit -m "style(tasks): chunky board cards + form inputs"
```

---

### Task 4: 筛选栏 TaskFilterBar

**Files:**
- Modify: `src/components/tasks/TaskFilterBar.tsx`

- [ ] **Step 1: 项目下拉/日期范围容器** — 两个 `flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5` → `rounded-xl border-2 border-border`(保留 bg-card/padding);内部 `<select>`/`<input>` 保持 `bg-transparent` 与数据属性。

- [ ] **Step 2: 「只看助手」与「清除筛选」** — 容器/按钮加 `.pill` 质感:只看助手激活态 `bg-violet-500/15 text-violet-600` 保留,仅加 `rounded-lg` 与 `border border-border/70`;清除筛选保留 hover:underline 逻辑,仅加 `rounded-lg py-1.5`。

- [ ] **Step 3: 移动端触发行** — 圆角微调即可,不改按钮行为。

- [ ] **Step 4: 校验 + 提交**

```bash
npm run typecheck
git add -A
git commit -m "style(tasks): chunky filter bar controls"
```

---

### Task 5: 表格视图 TaskTableView

**Files:**
- Modify: `src/components/tasks/TaskTableView.tsx`

- [ ] **Step 1: 表格容器** — 外层容器加 `CHUNKY_CARD`(若已是 Card 组件则自动获得);表头行/斑马纹仅保留,不改数据绑定与排序逻辑。

- [ ] **Step 2: 表格内动作/分页小按钮** — 若有 `rounded-md` 文字按钮,统一 `rounded-lg`,底部硬边可加 `CHUNKY_PILL`;**禁止改列排序/过滤/onClick。**

- [ ] **Step 3: 校验 + 提交**

```bash
npm run typecheck
git add -A
git commit -m "style(tasks): chunky table view card"
```

---

### Task 6: 任务详情 TaskDetail

**Files:**
- Modify: `src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 详情面板** — 面板若用 `Card` 组件(自动获得 chunky)或手写 `rounded-lg border bg-card` → 换成 `CHUNKY_CARD` 配方;右侧「详情」元信息行保留。

- [ ] **Step 2: 徽章/头部状态条** — `rounded-full bg-muted/40` 类徽章保留;若头部有 `rounded-md` 的面抖标签,微调 `rounded-lg`。

- [ ] **Step 3: 标签/描述/会话关联等结构** — 不做任何逻辑改动。

- [ ] **Step 4: 校验 + 提交**

```bash
npm run typecheck
git add -A
git commit -m "style(tasks): chunky task detail panels"
```

---

### Task 7: 聊天框架 + 弹窗残留 + 终端外壳

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`（已 chunky;仅检查）
- Modify: `src/components/chat/view/ChatInterface.tsx`（仅头部/标题区域样式）
- Modify: `src/components/chat/view/ui/PromptInput.tsx`（若提交钮非 Button 组件则套主色厚板;禁用时 opacity 保留）
- Modify: `src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx`（textarea/date/select 硬边）
- Modify: `src/components/terminal/TerminalDrawerPanel.tsx`（抽屉外壳 header 圆角对齐,**内部暗色终端本体不动**）

- [ ] **Step 1: ChatInterface 头部/标题** — 标题、tabular/tab 区域仅轻量圆角与字号对齐;聊天消息区(消息气泡)一行不改。

- [ ] **Step 2: PromptInput 提交钮** — 若已是 `Button` 组件则确保 primary 语义(可给 `chunkyPrimary` size sm/toolbar);手写按钮则换正文粗底边;仅样式。

- [ ] **Step 3: ConvertToTaskDialog** — 手写 `<textarea>`(`rounded-md border border-input bg-transparent px-3 py-1.5`)、`<input type="date">`(`h-9 rounded-md ...`)、`select`(`h-9 rounded-md ...`)统一换成 `CHUNKY_INPUT` 变体(select 保留下拉箭头 padding);**不改任何 onChange/value/option。**

- [ ] **Step 4: TerminalDrawerPanel** — 外壳 header(约 L36 起)加白色圆角对齐与硬边;内部终端内容(暗色)一行不改。

- [ ] **Step 5: 校验 + 提交**

```bash
npm run typecheck
git add -A
git commit -m "style(chat,terminal): chunky chat header, prompt submit, dialog inputs"
```

---

### Task 8: 全量校验

- [ ] **Step 1: 全量 typecheck** — `npm run typecheck` 无错误。

- [ ] **Step 2: 全量测试** — `env -u TSX_TSCONFIG_PATH node --import tsx --test $(find src -name '*.test.ts' -o -name '*.test.tsx')`,期望 222 全绿。

- [ ] **Step 3: 风格-only diff 审计** — `git diff <base>..HEAD --stat`,人工抽查 diff,确认无 `onClick` 之外的行为改动、无结构级变化。若有越界的,在对应任务修复。

- [ ] **Step 4: 提交(若有微调)** — `git add -A && git commit -m "style(ui): final chunky polish"`。

---

## Self-Review

- **Spec 覆盖:** 共享组件(T1)/侧栏(T2)/看板+任务卡(T3)/筛选(T4)/表格(T5)/详情(T6)/聊天框架+弹窗+终端(T7)/校验(T8)。✓
- **硬约束:** 每个任务显式声明「只改 className」;T3/T7 涉及 Input/textarea 的既有元素样式,均已注明保留数据属性与事件。✓
- **占位符:** 无 TBD;配方字符串完整;页面级任务给出元素清单与配方引用(实现者需读文件定位)。✓
- **类型一致性:** 新 chunky 配方仅在 `className` 字符串中出现,不新增 props/类型;ViewSwitcher 图标激活类变化为纯 className 分支。✓