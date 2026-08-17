# 返回任务面板 + 新建任务按钮移动端图标化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两处 header 按钮（返回任务面板、新建任务）在手机端（<640px）只显示小图标，≥640px 恢复文字。

**Architecture:** 沿用仓库既有惯例（`TerminalToggleButton` / tabs / 转为任务）——文字包 `<span className="hidden sm:inline">…</span>`，配 `title`/`aria-label`。纯 JSX 级改动，零逻辑、零新依赖。断点统一 Tailwind `sm:`（640px）。

**Tech Stack:** React 18, TypeScript, Tailwind CSS, lucide-react。

**设计文档:** `docs/superpowers/specs/2026-08-14-back-newtask-iconify-design.md`

**验收标准：** `npm run typecheck` 0 errors；`npm run lint` 报错/警告数不高于改动前（基线 0 errors / ~206 warnings，以实际为准，不得新增指向改动文件的行）；`npm run build` 通过；diff 只含设计范围。

---

### Task 1: 返回任务面板按钮图标化

**Files:**
- Modify: `src/components/tasks/TaskBackNav.tsx`（`BackToTasksButton`，约 8-21 行）

现状代码（要替换的 return 块）：

```tsx
  return (
    <Button
      variant="chunky"
      size="toolbar"
      className={cn('gap-1.5', className)}
      onClick={() => navigate('/tasks')}
    >
      <ArrowLeft />
      返回任务面板
    </Button>
  );
```

- [ ] **Step 1: 加 title/aria-label，文字包 span**

改为：

```tsx
  return (
    <Button
      variant="chunky"
      size="toolbar"
      className={cn('gap-1.5', className)}
      onClick={() => navigate('/tasks')}
      title="返回任务面板"
      aria-label="返回任务面板"
    >
      <ArrowLeft />
      {/* 移动端（<640px）只留返回图标 */}
      <span className="hidden sm:inline">返回任务面板</span>
    </Button>
  );
```

要点：只改 `BackToTasksButton`；同文件里的 `HomeButton`、`TaskBackNav` 均**不要动**（`HomeButton` 已有 `hidden sm:inline-flex`）。一处修改同时让 TaskDetail 页头部与 OperatorSettingsPage 头部生效。

- [ ] **Step 2: typecheck + lint 零新增**

Run: `npm run typecheck`（期望 0 errors）
Run: `npm run lint`（期望 warning 数 ≤ 改动前；无报错指向 `src/components/tasks/TaskBackNav.tsx`）

- [ ] **Step 3: commit**

```bash
git add src/components/tasks/TaskBackNav.tsx
git commit -m "feat: iconify back-to-tasks button on mobile"
```

---

### Task 2: 新建任务按钮图标化

**Files:**
- Modify: `src/components/tasks/TaskBoard.tsx`（header 内，约 339-344 行）

现状代码（要替换的块）：

```tsx
        <div className="ml-auto">
          <Button size="toolbar" variant="chunkyPrimary" onClick={openCreateForm} disabled={creating}>
            <Plus />
            新建任务
          </Button>
        </div>
```

- [ ] **Step 1: 加 title/aria-label，文字包 span**

改为：

```tsx
        <div className="ml-auto">
          <Button size="toolbar" variant="chunkyPrimary" onClick={openCreateForm} disabled={creating} title="新建任务" aria-label="新建任务">
            <Plus />
            {/* 移动端（<640px）只留 + 号 */}
            <span className="hidden sm:inline">新建任务</span>
          </Button>
        </div>
```

要点：`disabled={creating}` 保留；只改这一个按钮块；`ViewSwitcher`、`TerminalToggleButton`、切换组容器一律不动。

- [ ] **Step 2: typecheck + lint 零新增**

Run: `npm run typecheck`（期望 0 errors）
Run: `npm run lint`（期望 warning 数 ≤ 改动前；无报错指向 `src/components/tasks/TaskBoard.tsx`）

- [ ] **Step 3: commit**

```bash
git add src/components/tasks/TaskBoard.tsx
git commit -m "feat: iconify new-task button on mobile"
```

---

### Task 3: 全量验证

**Files:** 无改动。

- [ ] **Step 1: 编译 + 测试回归**

Run: `npm run build` → 期望 exit 0。

Run 全量测试（显式文件传入）：
```bash
TESTS=$(find src -name '*.test.*' | sort | tr '\n' ' ')
env -u TSX_TSCONFIG_PATH npx tsx --test $TESTS
```
期望 238 test pass、0 fail。

- [ ] **Step 2: 浏览器 375px/640px 实测**

1. `/tasks` 375px：头部「新建任务」为纯 + 号（无文字），且该行无溢出。
2. `/tasks` 640px：「新建任务」文字恢复。
3. 打开任一任务详情页（/task/:id）375px：头部「返回任务面板」为纯 ← 图标；640px 恢复文字。
4. 点击验证：+ 号打开新建弹窗；← 返回任务看板。

- [ ] **Step 3: 收尾**

Run: `git status` → 工作区干净（仅 2 个 `feat:` commit）。