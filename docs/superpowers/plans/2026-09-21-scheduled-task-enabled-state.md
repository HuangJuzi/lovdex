# 定时任务启用/停用状态可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时任务列表中启用/停用状态一眼可辨：新增通用 Switch 开关（表格第 1 列 / 卡片标题右侧），停用行整体弱化，停用后「下次触发」显示「—」。

**Architecture:** 纯前端改动。新增受控 Switch 组件（`web/src/shared/view/ui/Switch.tsx`），`ScheduledTasksView.tsx` 桌面表格与手机卡片双渲染分支同步接入；数据流不变（enable/disable API + refresh），开关为受控组件故 API 失败时自动回弹。Spec：`docs/superpowers/specs/2026-09-21-scheduled-task-enabled-state-design.md`。

**Tech Stack:** React + TypeScript + Tailwind（CSS 变量主题），测试为 `node:test` + `renderToStaticMarkup` 标记断言（无 DOM 环境不做点击模拟）。

**测试/验收命令约定：**
- 前端单测必须在 `web/` 下并清掉全局残留的 `TSX_TSCONFIG_PATH`（它指向 backend 的 tsconfig，会毒化 web 的 tsx 运行）：
  ```bash
  cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test <file>
  ```
- 类型检查：`cd /mnt/b/workdir/github/lovdex/web && npm run typecheck`（仓库允许存量错误，验收标准 = 不新增）
- commit message 英文，不加 Co-Authored-By。
- 工作区可能有其他会话的未提交 WIP（backend/*）：**只 `git add` 本计划明确列出的文件**。

---

### Task 1: 通用 Switch 组件

**Files:**
- Create: `web/src/shared/view/ui/Switch.test.tsx`
- Create: `web/src/shared/view/ui/Switch.tsx`
- Modify: `web/src/shared/view/ui/index.ts`

- [ ] **Step 1: 写失败测试**

创建 `web/src/shared/view/ui/Switch.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Switch from './Switch';

test('renders role=switch with aria-checked=true and success track when checked', () => {
  const html = renderToStaticMarkup(<Switch checked onToggle={() => {}} ariaLabel="示例开关" />);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /aria-label="示例开关"/);
  assert.match(html, /bg-success/);
  assert.doesNotMatch(html, /bg-muted/);
});

test('renders aria-checked=false and muted track when unchecked', () => {
  const html = renderToStaticMarkup(<Switch checked={false} onToggle={() => {}} ariaLabel="示例开关" />);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /bg-muted/);
  assert.doesNotMatch(html, /bg-success/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Switch.test.tsx
```

预期：FAIL，报错为「Cannot find module './Switch'」（模块还不存在）。

- [ ] **Step 3: 实现 Switch**

创建 `web/src/shared/view/ui/Switch.tsx`：

```tsx
import { cn } from '../../../lib/utils';

type SwitchProps = {
  checked: boolean;
  onToggle: () => void;
  ariaLabel: string;
};

/**
 * 受控开关：状态与操作二合一（当前用于定时任务启用/停用）。
 * 视觉参考 DarkModeToggle，尺寸缩小以适配表格行高；开=bg-success，关=bg-muted。
 * mobile-touch-target + -my-2：保证 44px 触控面积的同时不撑高所在行/卡片。
 */
function Switch({ checked, onToggle, ariaLabel }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
      className="mobile-touch-target -my-2 inline-flex flex-shrink-0 items-center rounded-full p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span
        className={cn(
          'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200',
          checked ? 'bg-success' : 'border border-border bg-muted',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-card shadow-sm transition-transform duration-200',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}

export default Switch;
```

滑块位移算术：轨道 `w-9`=36px，滑块 `w-4`=16px，两侧留 2px → 开态位移 `36-16-2=18px`。

- [ ] **Step 4: 从 ui index 导出**

`web/src/shared/view/ui/index.ts` 在 `export { default as DarkModeToggle } from './DarkModeToggle';` 一行之后插入：

```ts
export { default as Switch } from './Switch';
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Switch.test.tsx
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck
```

预期：2 pass 0 fail；typecheck 错误数不多于改前基线（先跑一次记录基线再比对）。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/shared/view/ui/Switch.tsx web/src/shared/view/ui/Switch.test.tsx web/src/shared/view/ui/index.ts && git commit -m "feat(web): add reusable Switch control"
```

---

### Task 2: ScheduledTasksView 接入开关 + 停用行弱化

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksView.test.tsx`（追加用例）
- Modify: `web/src/components/tasks/ScheduledTasksView.tsx`

- [ ] **Step 1: 追加失败测试**

在 `web/src/components/tasks/ScheduledTasksView.test.tsx` 末尾追加（`baseTask` / `render` 沿用文件顶部既有定义；`baseTask.next_run_at` 为 `2026-08-14T09:00:00.000Z`，在 UTC-8…UTC+14 任意时区格式化后日期部分都是 `2026-08-14`，可安全用作存在性断言）：

```tsx
test('renders 启用 switch column and 模式 header with aria-checked=true for enabled task', () => {
  const html = render([baseTask]);
  assert.match(html, /<th[^>]*>启用<\/th>/);
  assert.match(html, /<th[^>]*>模式<\/th>/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /每日站会：启用\/停用/);
  // 旧 ⏻ Power 按钮（aria-label=启停）已由开关取代
  assert.doesNotMatch(html, /aria-label="启停"/);
});

test('enabled task renders next_run_at time', () => {
  const html = render([baseTask]);
  assert.match(html, /2026-08-14/);
});

test('disabled task: aria-checked=false, dimmed, em-dash next run, desktop mode badge persists', () => {
  const html = render([{ ...baseTask, enabled: 0 }]);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /opacity-60/);
  assert.match(html, /已停用/);
  // 卡片停用时徽标被「已停用」取代，此处的「自动执行」只能来自桌面「模式」列
  assert.match(html, /自动执行/);
  // 停用后不再渲染会误导的下次触发时间
  assert.doesNotMatch(html, /2026-08-14/);
});
```

（SSR 两分支都渲染：`renderToStaticMarkup` 同时产出桌面表格与手机卡片的标记，上述正则不区分断言即可定位到唯一来源。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

预期：新增 3 个用例 FAIL（表格无「启用」表头、无 role="switch"、停用时仍渲染 `2026-08-14`），既有 7 个用例保持 PASS。

- [ ] **Step 3: 改造 ScheduledTasksView.tsx**

共 4 处修改：

**3a. imports**（第 3-8 行区域）——去掉 `Power`，新增 `Switch`：

```tsx
import { CalendarClock, Pencil, Play, Trash2 } from 'lucide-react';

import type { ScheduledTask } from '../../types/app';
import { scheduleLabel } from '../../utils/scheduleLabel';
import { Switch } from '../../shared/view/ui';
import type { TaskProjectOption } from './TaskCard';
import { formatAbsoluteTime } from './taskTimestamp';
```

**3b. 徽标函数**——用下面内容整体替换现有 `statusBadge` 函数（第 27-36 行）：

```tsx
const MODE_BADGE_CLASS = {
  auto: 'rounded-full bg-success/10 px-2 py-0.5 font-semibold text-success',
  remind: 'rounded-full bg-warning/10 px-2 py-0.5 font-semibold text-warning',
} as const;

/** 模式徽标：只表达 auto_run 两态。桌面「模式」列常显；卡片启用态经 statusBadge 复用。 */
function modeBadge(task: ScheduledTask) {
  return task.auto_run === 1 ? (
    <span className={MODE_BADGE_CLASS.auto}>✅ 自动执行</span>
  ) : (
    <span className={MODE_BADGE_CLASS.remind}>🔔 仅提醒</span>
  );
}

function statusBadge(task: ScheduledTask) {
  if (task.enabled === 0) {
    return (
      <span className="rounded-full border border-dashed border-border bg-muted px-2 py-0.5 font-semibold text-muted-foreground">⏸ 已停用</span>
    );
  }
  return modeBadge(task);
}
```

**3c. 手机卡片**——用下面内容整体替换 `ScheduledTaskCard` 函数（第 55-76 行）：

```tsx
function ScheduledTaskCard({ task, projectOptions, onEdit, onDelete, onToggle, onRunNow }: ScheduledTaskCardProps) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm ${task.enabled === 0 ? 'opacity-60' : ''}`}>
      {/* 标题与启停开关同行：开关即状态；长标题最多两行，开关不随标题拉伸。 */}
      <div className="flex items-center justify-between gap-2">
        <span className={`line-clamp-2 overflow-hidden text-sm font-semibold ${task.enabled === 0 ? 'text-muted-foreground' : 'text-card-foreground'}`}>{task.title}</span>
        <Switch checked={task.enabled === 1} onToggle={() => onToggle(task)} ariaLabel={`${task.title}：启用/停用`} />
      </div>
      <div className="self-start">{statusBadge(task)}</div>
      <FieldRow label="调度" value={<><CalendarClock className="mr-1 inline h-3 w-3" />{scheduleLabel(task)}</>} />
      <FieldRow label="项目" value={projectLabel(task, projectOptions)} />
      <FieldRow label="下次" value={<span className="font-mono text-2xs">{task.enabled === 0 ? '—' : formatAbsoluteTime(task.next_run_at)}</span>} />
      <FieldRow
        label="上次"
        value={task.last_task_id ? <Link className="text-primary underline" to={`/task/${task.last_task_id}`}>查看任务</Link> : '—'}
      />
      <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
        <ActionButton title="立即触发" label="立即触发" className="text-info hover:bg-info/10" onClick={() => onRunNow(task)}><Play className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="编辑" label="编辑" className="text-muted-foreground hover:bg-muted" onClick={() => onEdit(task)}><Pencil className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="删除" label="删除" className="text-destructive hover:bg-destructive/10" onClick={() => onDelete(task)}><Trash2 className="h-3.5 w-3.5" /></ActionButton>
      </div>
    </div>
  );
}
```

**3d. 桌面表格**——在 `ScheduledTasksView` 内：

表头数组（第 100 行）替换为：

```tsx
              {['启用', '标题', '调度', '项目', '模式', '下次触发', '上次触发', '操作'].map((h) => (
```

`<tbody>` 内整个 `{tasks.map((task) => (...))}` 块（第 106-136 行）替换为：

```tsx
            {tasks.map((task) => (
              <tr key={task.schedule_id} className={`bg-card shadow-sm ${task.enabled === 0 ? 'opacity-60' : ''}`}>
                <td className="rounded-l-lg px-4 py-3">
                  <Switch checked={task.enabled === 1} onToggle={() => onToggle(task)} ariaLabel={`${task.title}：启用/停用`} />
                </td>
                <td className={`px-4 py-3 font-semibold [overflow-wrap:anywhere] ${task.enabled === 0 ? 'text-muted-foreground' : 'text-card-foreground'}`}>{task.title}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <CalendarClock className="mr-1 inline h-3 w-3" />
                  {scheduleLabel(task)}
                </td>
                {/* projectLabel 在项目不在 projectOptions 时会回退成完整路径（不可断
                    长 token），截断 + title 兜底，避免将来把本表推出横向滚动。 */}
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <span className="block max-w-40 truncate" title={projectLabel(task, projectOptions)}>
                    {projectLabel(task, projectOptions)}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">{modeBadge(task)}</td>
                <td className="px-4 py-3 font-mono text-2xs text-muted-foreground">
                  {task.enabled === 0 ? '—' : formatAbsoluteTime(task.next_run_at)}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {task.last_task_id ? (
                    <button className="text-primary underline" onClick={() => navigate(`/task/${task.last_task_id}`)}>查看</button>
                  ) : '—'}
                </td>
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button title="立即触发" aria-label="立即触发" onClick={() => onRunNow(task)} className="rounded-lg px-2 py-1 text-info hover:bg-info/10"><Play className="h-3 w-3" /></button>
                    <button title="编辑" aria-label="编辑" onClick={() => onEdit(task)} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><Pencil className="h-3 w-3" /></button>
                    <button title="删除" aria-label="删除" onClick={() => onDelete(task)} className="rounded-lg px-2 py-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </td>
              </tr>
            ))}
```

- [ ] **Step 4: 跑测试确认全部通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

预期：10 pass 0 fail（既有 7 + 新增 3）。

- [ ] **Step 5: 类型检查 + lint 新增文件**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck
cd /mnt/b/workdir/github/lovdex/web && npx eslint src/shared/view/ui/Switch.tsx src/components/tasks/ScheduledTasksView.tsx
```

预期：typecheck 不多于基线错误数；eslint 对这两个文件 0 error（存量错误 elsewhere 不管）。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/tasks/ScheduledTasksView.tsx web/src/components/tasks/ScheduledTasksView.test.tsx && git commit -m "feat(scheduled-tasks): make enable state visible with switch and dimmed rows"
```

---

### Task 3: 浏览器手工验收

**Files:** 无代码改动。

- [ ] **Step 1: 在 live dev server 上过一遍**

dev server 前端 ：5188（vite HMR 会自动生效，无需重启任何服务；本改动纯前端，不动后端）。让用户打开 `http://172.26.13.157:5188/tasks?view=scheduled`（或按当前实际端口）检查：

- 启用任务：第 1 列/标题右侧绿色开关 = 开；行正常亮度
- 点开关 → 变灰、整行变淡、标题变灰、「下次」变「—」、卡片徽标变「⏸ 已停用」虚线框
- 再点回开 → 恢复原样，「下次」恢复时间
- 桌面表格与手机宽度（DevTools 窄屏）都检查
- 既有「立即触发/编辑/删除」按钮不受影响，操作列无 ⏻ 残留

验收中若发现视觉问题（如开关撑行、卡片标题行高度异常），回到 Task 2 修样式后重跑该文件测试再提交 fix commit。

- [ ] **Step 2: 收尾确认**

```bash
cd /mnt/b/workdir/github/lovdex && git log --oneline -3 && git status --short | head
```

预期：两个新 commit 在 main 顶部；工作区不新增本计划之外的改动（其他会话的 backend WIP 不动）。
