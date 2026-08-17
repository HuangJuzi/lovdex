# 返回任务面板 + 新建任务按钮移动端图标化 — 设计文档

> 状态：设计定稿 · 2026-08-14
> 定位：lovdex-cli 两处 header 按钮移动端（<640px）收成小图标，延续本日「手机端图标化」系列。
> 范围：仅 lovdex-cli 前端两文件，纯 JSX 级改动。

---

## 1. 背景与目标

今日已上线三批评敌式改动：聊天工作区顶部（tabs 图标化 + 转为任务/查看任务 + 查看任务去蓝点改状态色）、Task 页看板切换组手机端隐藏。全仓摸底后，header/工具栏区**仍**在移动端显示文字的紧凑按钮只剩两处值得处理：

1. **返回任务面板**（`tasks/TaskBackNav.tsx` 的 `BackToTasksButton`）——icon+文字，TaskDetail 页头部与 Operator 设置页头部复用，同排有 ViewSwitcher(160px)+终端 icon，320px 屏必挤；旁边的 HomeButton 早已 `hidden sm:inline-flex`。
2. **新建任务**（`tasks/TaskBoard.tsx` header 主 CTA，chunkyPrimary）——Plus+文字，Task 页手机端收缩后唯一仍显文字的 header 按钮。

**目标**：两处移动端收成小图标（`hidden sm:inline` 惯例），≥640px 恢复文字。已确认 **不做** git 面板 New branch/New worktree（用户未选）、表单/内容级按钮（可辨识性优先）、GitViewTabs/ViewSwitcher（不溢出，纯一致性，留待后续）。

**不做的**：不加新测试（纯 class/JSX 级）；不动 `HomeButton`（已是移动端隐藏）；不动断点（统一 640）。

---

## 2. 方案选型

唯一做法 = 项目既有惯例（`TerminalToggleButton` / tabs / 转为任务）：文字包 `<span className="hidden sm:inline">…</span>` + `title`/`aria-label`。无其它候选方案。

---

## 3. 改动设计

### 3.1 `src/components/tasks/TaskBackNav.tsx`（BackToTasksButton）

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

一处修改，TaskDetail 页头部与 OperatorSettingsPage 头部同时生效；`HomeButton` 不动。

### 3.2 `src/components/tasks/TaskBoard.tsx`（新建任务按钮）

```tsx
<div className="ml-auto">
  <Button size="toolbar" variant="chunkyPrimary" onClick={openCreateForm} disabled={creating} title="新建任务" aria-label="新建任务">
    <Plus />
    {/* 移动端（<640px）只留 + 号 */}
    <span className="hidden sm:inline">新建任务</span>
  </Button>
</div>
```

`disabled={creating}` 保留（创建中禁用态与 tooltip 叠加无关紧要）。

---

## 4. 验证要点

1. `npm run typecheck`、`npm run lint` 零新增。
2. 浏览器 375px：TaskDetail 页头部「返回任务面板」为纯 ← 图标；Task 页头部「新建任务」为纯 + 号；两者 `title` 存在。
3. 切 ≥640px：两处文字恢复，桌面无变化。
4. `npm run build` + 全量测试（238 个）通过。

---

## 5. 附：关键决策

- **只做 A1+A2**：A3/A4（git New branch/New worktree）用户明确未选；表单/内容按钮保持文字（无歧义操作优先）。
- **断点统一 640（`sm:`）**：与 Task 页 `isMobile(640)` 及本系列其它改动一致。