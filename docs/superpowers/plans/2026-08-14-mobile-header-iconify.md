# 聊天工作区顶部按钮手机端图标化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机端（<640px）把聊天工作区顶部按钮行的文字收成小图标，Tasks 标签保留文字，解决顶部显示不全。

**Architecture:** 纯 CSS 响应式——在 `lovdex-cli` 前端用 Tailwind `hidden sm:inline`（`sm:`=min-width 640px，与 Task 页 `isMobile(640)` 断点一致）把文字标签包起来：<640px 只显示图标，≥640px 自动恢复文字，桌面端零变化。改动仅 2 个文件的 JSX，无 JS 逻辑、无状态、无新依赖。

**Tech Stack:** React 18, TypeScript, Tailwind CSS, lucide-react（仓库内既有，无新增）。

**设计文档:** `docs/superpowers/specs/2026-08-14-mobile-header-iconify-design.md`

**验收标准：** `npm run typecheck` 与 `npm run lint` 的报错数不高于改动前基线（memory 记录 baseline：typecheck 4 / lint 44，均与本改动无关——若改动前数字有出入，以「没有错误指向本次修改的文件、总条数不增加」为准）；`npm run build` 通过；375px 手测顶部一行放得下。

---

### Task 1: 工作区 tab 图标化（Chat / Files / Source Control），Tasks 保留文字

**Files:**
- Modify: `src/components/main-content/view/subcomponents/MainContentTabs.tsx`

背景：`MainContentTabs` 渲染 4 个 tab（`workspace.map` 的 3 个 + 手动写的 Tasks 按钮）。工作区 3 个的 label 现在直接 `{label}` 渲染；Tasks 按钮直接渲染 `Tasks` 文本。`TerminalToggleButton` 已有既有图标化写法参考：`<TerminalIcon /><span className="hidden sm:inline">终端</span>` 加 `title`。

- [ ] **Step 1: 给工作区 tab 文字包上 `hidden sm:inline`，补 `title`/`aria-label`**

把 `workspace.map` 渲染的 `<button>...</button>` 中：
1. `<button ...>` 上补 `title={label}` 与 `aria-label={label}`；
2. 把 `{label}` 换成 `<span className="hidden sm:inline">{label}</span>`。

编辑后该按钮块应为（其余属性不变）：

```tsx
    <button
      key={value}
      type="button"
      aria-pressed={isActive}
      title={label}
      aria-label={label}
      onClick={() => !isActive && onSelect(value)}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-normal transition-all',
        isActive
          ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className={cn('h-3 w-3 flex-shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
      {/* 移动端（<640px）只留图标，桌面端恢复文字；断点与 Task 页 isMobile(640) 对齐。 */}
      <span className="hidden sm:inline">{label}</span>
    </button>
```

- [ ] **Step 2: Tasks 按钮保留文字，补 `title`**

Tasks 按钮保持文字始终可见（不套 `hidden sm:inline`），只补 `title="Tasks"`。编辑后应为：

```tsx
      <button
        type="button"
        aria-pressed={false}
        title="Tasks"
        onClick={() => navigate('/tasks')}
        className={cn(
          'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-normal transition-all',
          'text-muted-foreground hover:text-foreground',
        )}
      >
        <ClipboardList className="h-3 w-3 flex-shrink-0 text-emerald-500" />
        Tasks
      </button>
```

（Tasks 文字即 accessible name，无需 `aria-label`。）

- [ ] **Step 3: typecheck + lint，确认零新增报错**

Run: `npm run typecheck`
Expected: 报错类型与数量 ≤ 改动前；**没有**任何 error 指向 `src/components/main-content/view/subcomponents/MainContentTabs.tsx`。

Run: `npm run lint`
Expected: 同上一并确认（若 lint.error 数字比改动前多，报错须与本次改动无关）。

- [ ] **Step 4: commit**

```bash
git add src/components/main-content/view/subcomponents/MainContentTabs.tsx
git commit -m "feat: iconify workspace tabs on mobile, keep Tasks label"
```

---

### Task 2: 「转为任务 / 查看任务」按钮文字图标化

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`（两处 Button）

背景：两按钮均已有 `title`。把文字改为 `<span className="hidden sm:inline">…</span>` 并补 `aria-label`；「查看任务」按钮的状态圆点保留（它是唯一的任务状态信号）。

- [ ] **Step 1: 转为任务按钮**

把 (MainContent.tsx ~97-108)：

```tsx
        {selectedProject && selectedSession && !linkedTask && (
          <Button
            variant="chunky"
            size="toolbar"
            className="ml-auto"
            onClick={() => setConvertOpen(true)}
            title="转为任务"
          >
            <RefreshCw />
            转为任务
          </Button>
        )}
```

改为（仅 outer 按钮加 `aria-label`、文字包 span）：

```tsx
        {selectedProject && selectedSession && !linkedTask && (
          <Button
            variant="chunky"
            size="toolbar"
            className="ml-auto"
            onClick={() => setConvertOpen(true)}
            title="转为任务"
            aria-label="转为任务"
          >
            <RefreshCw />
            {/* 移动端（<640px）只留图标 */}
            <span className="hidden sm:inline">转为任务</span>
          </Button>
        )}
```

- [ ] **Step 2: 查看任务按钮**

把 (MainContent.tsx ~109-124)：

```tsx
        {selectedProject && linkedTask && (
          <Button
            variant="chunky"
            size="toolbar"
            className="ml-auto"
            onClick={() => navigate(`/task/${linkedTask.task_id}`)}
            title="查看任务"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: STATUS_META[linkedTask.status].color }}
            />
            <Eye />
            查看任务
          </Button>
        )}
```

改为（状态圆点和 `Eye` 图标保留）：

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

- [ ] **Step 3: typecheck + lint，确认零新增报错**

Run: `npm run typecheck` + `npm run lint`
Expected: 见 Task 1 Step 3 的同款标准（无错误指向 `src/components/main-content/view/MainContent.tsx`）。

- [ ] **Step 4: commit**

```bash
git add src/components/main-content/view/MainContent.tsx
git commit -m "feat: iconify convert/view task buttons on mobile"
```

---

### Task 3: 全量验证

**Files:** 无改动。

- [ ] **Step 1: 全项目编译**

Run: `npm run build`
Expected: exit 0，`dist/` 产物生成。

- [ ] **Step 2: 手工响应式验证（必须逐条确认）**

用 DevTools 设备仿真（或缩窄窗口到 375px）打开聊天工作区：

1. `<640px`：Chat / Files / Source Control 为纯图标（无文字），Tasks 文字可见；一行放得下，无水平溢出/换行。
2. `<640px`：「转为任务」（无关联任务时）只显示刷新图标；「查看任务」（有关联任务时）显示状态圆点 + 眼睛图标，无文字。
3. 点击验证：四个 tab 切换正常；点 Tasks 进入任务看板；点转为任务/查看任务弹窗/跳转正常；终端按钮行为不变。
4. `≥640px`：全部文字恢复，逐像素与改动前一致。
5. 空态（未选中项目）：header 正常，无回归。

- [ ] **Step 3: 收尾确认**

Run: `git status`
Expected: 工作区干净（仅剩两个 `feat:` commit），无未提交改动。