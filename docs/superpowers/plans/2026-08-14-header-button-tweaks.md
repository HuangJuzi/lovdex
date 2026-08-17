# 顶部按钮微调（查看任务去蓝点 + Task 页手机端隐藏看板切换）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两处 UI 微调：①「查看任务」按钮去掉状态圆点，让 `Eye` 图标直接取任务状态色；② Task 页「看板/表格」切换组在手机端（<640px）整组隐藏。

**Architecture:** 纯 JSX/class 级改动。① 删除状态圆点 span，`Eye` 图标加 `style={{ color: STATUS_META[linkedTask.status].color }}`（lucide svg 描边走 currentColor，显式 style 覆盖按钮默认深色）；② 切换组容器加 Tailwind `hidden sm:flex`，<640px 整组 `display:none`，≥640px 恢复。零逻辑、零新依赖、零后端。

**Tech Stack:** React 18, TypeScript, Tailwind CSS, lucide-react（仓库内既有）。

**设计文档:** `docs/superpowers/specs/2026-08-14-header-button-tweaks-design.md`

**验收标准：** `npm run typecheck` 0 errors、`npm run lint` 报错/警告数不高于改动前（当前基线 0 errors / ~206 warnings，以实际跑出的为准；不得新增指向改动文件的行）；`npm run build` 通过；相关文件 diff 最小且只含本设计范围。

---

### Task 1: 「查看任务」按钮去圆点、眼睛用状态色

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`（查看任务按钮块，约 109-128 行）

现状代码（目标替换为 `Step 1` 的代码）：

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

- [ ] **Step 1: 编辑按钮内容**

删除状态圆点 `<span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[linkedTask.status].color }} />`；`<Eye />` 改为 `<Eye style={{ color: STATUS_META[linkedTask.status].color }} />`；更新行内注释。目标代码：

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

要点：
- `Eye` 是 lucide 图标，svg 描边默认继承 `currentColor`（按钮 chunky 变体为深色文字色）；显式 `style` 颜色覆盖它，桌面/移动端一致。
- `STATUS_META` 仍被引用，**保留** import（`src/components/main-content/view/MainContent.tsx` 第 10 行 `import { STATUS_META } from '../../tasks/taskStatus';`）——移除圆点后它并未变 unused。
- 其余（条件、onClick、title、aria-label、文字 span、`ml-auto`）一律不动。

- [ ] **Step 2: typecheck + lint 零新增**

Run: `npm run typecheck`（期望 0 errors）
Run: `npm run lint`（期望 warning 数 ≤ 改动前；无报错指向 `src/components/main-content/view/MainContent.tsx`）

- [ ] **Step 3: commit**

```bash
git add src/components/main-content/view/MainContent.tsx
git commit -m "feat: color view-task eye by task status, drop status dot"
```

---

### Task 2: Task 页手机端隐藏 看板/表格 切换组

**Files:**
- Modify: `src/components/tasks/TaskBoard.tsx`（header 内切换组容器，约 309 行）

现状代码（第 309 行）：`<div className="flex rounded-lg bg-muted/50 p-0.5">`——内含「看板」按钮（常显）与「表格」按钮（已 `hidden … sm:flex`）。

- [ ] **Step 1: 给容器加 `hidden sm:flex`**

把第 309 行改为：

```tsx
        <div className="hidden rounded-lg bg-muted/50 p-0.5 sm:flex">
```

- <640px：整组 `display:none`，手机端不再出现「看板/表格」切换（移动端 `effectiveView` 本就被强制为 `board`，无功能损失）。
- ≥640px：`sm:flex` 恢复，桌面行为不变；「表格」按钮自身的 `hidden … sm:flex` 类名**不要动**（diff 最小）。
- 容器内两个按钮、`ViewSwitcher`、`新建任务`、`TerminalToggleButton` 一律不动。

- [ ] **Step 2: typecheck + lint 零新增**

Run: `npm run typecheck`（期望 0 errors）
Run: `npm run lint`（期望 warning 数 ≤ 改动前；无报错指向 `src/components/tasks/TaskBoard.tsx`）

- [ ] **Step 3: commit**

```bash
git add src/components/tasks/TaskBoard.tsx
git commit -m "feat: hide board/table toggle group on task page mobile"
```

---

### Task 3: 全量验证

**Files:** 无改动。

- [ ] **Step 1: 编译 + 测试回归**

Run: `npm run build` → 期望 exit 0、`dist/` 生成。

Run 全量测试（显式文件传入，`src/` 目录直接当文件会报 ERR_MODULE_NOT_FOUND）：
```bash
TESTS=$(find src -name '*.test.*' | sort | tr '\n' ' ')
env -u TSX_TSCONFIG_PATH npx tsx --test $TESTS
```
期望 238 test pass、0 fail（`TSX_TSCONFIG_PATH` 不 unset 会在 lovdex-cli 崩溃，见 memory）。

- [ ] **Step 2: 浏览器响应式手测（DevTools 375px）**

1. 打开有任务关联的会话：顶部「查看任务」按钮**无圆点**、`Eye` 颜色随任务状态（待办黄/进行中蓝/评审紫/完成绿）变化；手机端只显示状态色眼睛图标。
2. Task 页（/tasks）375px：顶部无「看板/表格」切换组（只有 ViewSwitcher + 新建任务 + 终端），一行无溢出。
3. 切 ≥640px：Task 页切换组恢复；查看任务按钮 = 状态色眼睛 + 「查看任务」文字。
4. 任务状态切换（如 todo→in_progress→done）时眼睛颜色跟随变化。

- [ ] **Step 3: 收尾**

Run: `git status` → 工作区干净（仅 2 个 `feat:` commit），无未提交改动。