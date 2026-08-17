# 按钮统一 · W4 立体厚板(Chunky 3D)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将六个高频按钮(`新建任务 / 终端 / 返回任务面板 / 返回主页 / 查看任务 / 转为任务`)统一为 W4「立体厚板」风格,并让侧栏 Change Password / Sign Out 并排一行。

**Architecture:** 在共享 `Button` 组件(`src/shared/view/ui/Button.tsx`)中新增 `chunky`(白卡厚板)与 `chunkyPrimary`(主色厚板)两个 variant 和 `toolbar` 尺寸;六个按钮全部改用共享 Button 的这套 variant,删除各处手写 `<button>` 与彩色覆写。`cn` 基于 `twMerge`,新 variant 类会自动覆盖基础类的 `rounded-md` / `transition-colors`。

**Tech Stack:** React + TypeScript + Tailwind CSS + cva(class-variance-authority) + lucide-react。测试用 `node:test` + `react-dom/server` 做 SSR 渲染断言。

---

### Task 1: 在共享 Button 中新增 chunky / chunkyPrimary variant 和 toolbar size

**Files:**
- Modify: `src/shared/view/ui/Button.tsx`
- Create: `src/shared/view/ui/Button.test.tsx`

- [ ] **Step 1: 先写失败测试**

Create `src/shared/view/ui/Button.test.tsx`:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Button } from './Button';

function renderButton(props: React.ComponentProps<typeof Button>, label = 'x') {
  return renderToStaticMarkup(React.createElement(Button, props, label));
}

test('chunky variant renders white-card gradient + hard bottom edge', () => {
  const html = renderButton({ variant: 'chunky' });
  assert.match(html, /shadow-\[0_4px_0_#d8d5df/);
  assert.match(html, /bg-gradient-to-b/);
});

test('chunkyPrimary variant renders primary gradient', () => {
  const html = renderButton({ variant: 'chunkyPrimary' });
  assert.match(html, /from-\[#5b8cff\]/);
  assert.match(html, /to-\[#2f5fe0\]/);
});

test('toolbar size renders 34px height', () => {
  const html = renderButton({ size: 'toolbar' });
  assert.match(html, /h-\[34px\]/);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run (working dir = `lovdex-cli`):
```bash
env -u TSX_TSCONFIG_PATH node --import tsx --test src/shared/view/ui/Button.test.tsx
```
Expected: 3 个 test 全 FAIL(`chunky variant...` 等断言不匹配),因为 variant 还不存在。

- [ ] **Step 3: 实现新 variant 与 size**

Modify `src/shared/view/ui/Button.tsx` — 在 `buttonVariants` 的 `variants.variant` 对象中追加两个值,`variants.size` 中追加 `toolbar`:

```tsx
const buttonVariants = cva(
  'inline-flex touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90 active:bg-primary/80',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:bg-destructive/80',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 active:bg-secondary/70',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        link: 'text-primary underline-offset-4 hover:underline',
        // W4 立体厚板 —— 白卡(次要)
        chunky: [
          'rounded-xl border border-black/5 bg-gradient-to-b from-white to-slate-100 text-slate-900 transition-all',
          'shadow-[0_4px_0_#d8d5df,0_10px_20px_rgba(35,33,41,0.08)]',
          'hover:-translate-y-0.5 hover:shadow-[0_6px_0_#d8d5df,0_14px_26px_rgba(35,33,41,0.12)]',
          'active:translate-y-[3px] active:shadow-[0_1px_0_#d8d5df,0_3px_8px_rgba(35,33,41,0.08)]',
          'dark:border-white/10 dark:from-zinc-800 dark:to-zinc-900 dark:text-zinc-100',
          'dark:shadow-[0_4px_0_#1f1f26,0_10px_20px_rgba(0,0,0,0.45)]',
          'dark:hover:shadow-[0_6px_0_#1f1f26,0_14px_26px_rgba(0,0,0,0.5)]',
          'dark:active:shadow-[0_1px_0_#1f1f26,0_3px_8px_rgba(0,0,0,0.4)]',
        ].join(' '),
        // W4 立体厚板 —— 主色(新建任务 / 终端激活态)
        chunkyPrimary: [
          'rounded-xl border border-transparent bg-gradient-to-b from-[#5b8cff] to-[#2f5fe0] text-white transition-all',
          'shadow-[0_4px_0_#1c3fa8,0_12px_24px_rgba(47,95,224,0.28)]',
          'hover:-translate-y-0.5 hover:shadow-[0_6px_0_#1c3fa8,0_16px_30px_rgba(47,95,224,0.4)]',
          'active:translate-y-[3px] active:shadow-[0_1px_0_#1c3fa8,0_3px_8px_rgba(47,95,224,0.25)]',
          'dark:from-[#7ea6ff] dark:to-[#4d7df0]',
          'dark:shadow-[0_4px_0_#1a2d5c,0_12px_24px_rgba(90,130,255,0.35)]',
          'dark:hover:shadow-[0_6px_0_#1a2d5c,0_16px_30px_rgba(90,130,255,0.45)]',
          'dark:active:shadow-[0_1px_0_#1a2d5c,0_3px_8px_rgba(90,130,255,0.3)]',
        ].join(' '),
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3 text-sm',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
        // W4 工具栏统一尺寸:34px 高,圆角由 variant 提供
        toolbar: 'h-[34px] px-3.5 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);
```

- [ ] **Step 4: 运行测试,确认通过**

Run:
```bash
env -u TSX_TSCONFIG_PATH node --import tsx --test src/shared/view/ui/Button.test.tsx
```
Expected: `# pass 3` / `# fail 0`。

- [ ] **Step 5: 类型检查**

Run:
```bash
npm run typecheck
```
Expected: 无新增类型错误。

- [ ] **Step 6: Commit**

```bash
git add src/shared/view/ui/Button.tsx src/shared/view/ui/Button.test.tsx
git commit -m "feat(ui): add chunky/chunkyPrimary variants and toolbar size to Button"
```

---

### Task 2: 新建任务按钮 → TaskBoard

**Files:**
- Modify: `src/components/tasks/TaskBoard.tsx`(import 行 + 头部按钮约 339-343)

- [ ] **Step 1: 加 `Plus` 图标 import**

Modify the lucide import in `src/components/tasks/TaskBoard.tsx`:

```tsx
import { LayoutGrid, Plus, Table } from 'lucide-react';
```

- [ ] **Step 2: 换按钮**

Replace(约 339-343):

```tsx
        <div className="ml-auto">
          <Button size="sm" className="h-8 px-3 text-sm" onClick={openCreateForm} disabled={creating}>
            ＋ 新建任务
          </Button>
        </div>
```

with:

```tsx
        <div className="ml-auto">
          <Button size="toolbar" variant="chunkyPrimary" onClick={openCreateForm} disabled={creating}>
            <Plus />
            新建任务
          </Button>
        </div>
```

(`Button` 已在 TaskBoard import 中;`Plus` 图标由 `[&_svg]:size-4` 自动定尺寸。)

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck` — 期望无新错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): use chunkyPrimary toolbar button for 新建任务"
```

---

### Task 3: 终端按钮 → TerminalToggleButton

**Files:**
- Modify: `src/components/terminal/TerminalToggleButton.tsx`

- [ ] **Step 1: 整体替换组件**

Replace the entire file body with:

```tsx
import { Terminal as TerminalIcon } from 'lucide-react';

import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
import { cn } from '../../lib/utils';
import { Button } from '../../shared/view/ui';

export function TerminalToggleButton({ className }: { className?: string }) {
  const { open, toggle } = useTerminalDrawer();
  return (
    <Button
      type="button"
      variant={open ? 'chunkyPrimary' : 'chunky'}
      size="toolbar"
      onClick={toggle}
      title="终端 (Ctrl+`)"
      aria-pressed={open}
      className={cn('gap-1.5', className)}
    >
      <TerminalIcon />
      <span className="hidden sm:inline">终端</span>
    </Button>
  );
}
```

(保留 `aria-pressed` 与 `title`;激活时切到主色厚板。)

- [ ] **Step 2: 跑该组件现有测试**

Run:
```bash
env -u TSX_TSCONFIG_PATH node --import tsx --test src/components/terminal/TerminalToggleButton.test.tsx
```
Expected: `# pass 1`(断言含「终端」文案仍通过)。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck` — 期望无新错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/terminal/TerminalToggleButton.tsx
git commit -m "feat(terminal): use chunky/chunkyPrimary toolbar button for terminal toggle"
```

---

### Task 4: 返回任务面板 / 返回主页 → TaskBackNav

**Files:**
- Modify: `src/components/tasks/TaskBackNav.tsx`

- [ ] **Step 1: 替换两个返回按钮组件**

Replace `BackToTasksButton` 与 `HomeButton` 两个函数(去掉蓝/琥珀色覆写):

```tsx
/** 「← 返回任务面板」chunky 按钮,供 OperatorSettingsPage 头部复用。 */
export function BackToTasksButton({ className }: { className?: string }) {
  const navigate = useNavigate();
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
}

/** 「返回主页」chunky 按钮。 */
export function HomeButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="chunky"
      size="toolbar"
      className={cn('gap-1.5', className)}
      onClick={() => navigate('/')}
    >
      <Home />
      返回主页
    </Button>
  );
}
```

`TaskBackNav` 组合部分保持不变(`<HomeButton className="hidden sm:inline-flex" />` 保留,移动端仍隐藏)。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck` — 期望无新错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/tasks/TaskBackNav.tsx
git commit -m "feat(tasks): unify back/home buttons to chunky variant"
```

---

### Task 5: 查看任务 / 转为任务 → MainContent

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`(import 行 + 约 72-95)

- [ ] **Step 1: 加图标 import**

Add after existing imports (alphabetical, near the `lucide`-less import block):

```tsx
import { Eye, RefreshCw } from 'lucide-react';
```

- [ ] **Step 2: 替换两个按钮**

Replace(约 72-95,两个互斥按钮):

```tsx
        {selectedProject && selectedSession && !linkedTask && (
          <button
            type="button"
            onClick={() => setConvertOpen(true)}
            className="ml-auto flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-3 text-sm text-foreground transition-colors hover:bg-accent"
            title="转为任务"
          >
            转为任务
          </button>
        )}
        {selectedProject && linkedTask && (
          <button
            type="button"
            onClick={() => navigate(`/task/${linkedTask.task_id}`)}
            className="ml-auto flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-3 text-sm text-foreground transition-colors hover:bg-accent"
            title="查看任务"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: STATUS_META[linkedTask.status].color }}
            />
            查看任务
          </button>
        )}
```

with:

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

并确保 `MainContent.tsx` 顶部 import 了 `Button`:

```tsx
import { Button } from '../../../shared/view/ui';
```

(若已存在则跳过;`ml-auto` 经 className 传入,把按钮推到 header 右侧。)

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck` — 期望无新错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/main-content/view/MainContent.tsx
git commit -m "feat(chat): unify 查看任务/转为任务 to chunky toolbar buttons"
```

---

### Task 6: 助手错误页返回按钮 → AssistantPanel

**Files:**
- Modify: `src/components/operators/AssistantPanel.tsx`

- [ ] **Step 1: 加 Button import**

Add at top:

```tsx
import { Button } from '../../shared/view/ui';
```

- [ ] **Step 2: 替换错误态按钮**

Replace:

```tsx
        <button
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          onClick={() => navigate('/tasks')}
        >
          返回任务面板
        </button>
```

with:

```tsx
        <Button variant="chunky" size="sm" onClick={() => navigate('/tasks')}>
          返回任务面板
        </Button>
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck` — 期望无新错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/operators/AssistantPanel.tsx
git commit -m "feat(operators): use chunky button for assistant error fallback"
```

---

### Task 7: 侧栏 Change Password / Sign Out 并排一行 → SidebarFooter

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`

- [ ] **Step 1: 加 Button import**

Add after the lucide import:

```tsx
import { Button } from '../../../../shared/view/ui';
```

- [ ] **Step 2: 替换鉴权块**

Replace(约 112-141 的 `{!IS_PLATFORM && (...)}` 内两个竖排 div):

```tsx
        <>
          <div className="px-2 pb-1">
            <button
              type="button"
              onClick={() => setShowChangePassword(true)}
              title={t('auth:changePassword.button')}
              aria-label={t('auth:changePassword.button')}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>{t('auth:changePassword.button')}</span>
            </button>
          </div>
          <div className="px-2 pb-2">
            <button
              type="button"
              onClick={logout}
              title={t('auth:logout.button')}
              aria-label={t('auth:logout.button')}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>{t('auth:logout.button')}</span>
            </button>
          </div>
```

with:

```tsx
        <>
          <div className="flex gap-1.5 px-2 pb-2">
            <Button
              type="button"
              variant="chunky"
              size="sm"
              onClick={() => setShowChangePassword(true)}
              title={t('auth:changePassword.button')}
              aria-label={t('auth:changePassword.button')}
              className="flex-1 px-2 text-xs"
            >
              <KeyRound />
              <span className="truncate">{t('auth:changePassword.button')}</span>
            </Button>
            <Button
              type="button"
              variant="chunky"
              size="sm"
              onClick={logout}
              title={t('auth:logout.button')}
              aria-label={t('auth:logout.button')}
              className="flex-1 px-2 text-xs"
            >
              <LogOut />
              <span className="truncate">{t('auth:logout.button')}</span>
            </Button>
          </div>
```

(`ChangePasswordDialog` 挂载行保持不变。)

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck` — 期望无新错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarFooter.tsx
git commit -m "feat(sidebar): put change password + sign out on one row as chunky buttons"
```

---

### Task 8: 全量校验

**Files:** 无新增

- [ ] **Step 1: 全量类型检查**

Run: `npm run typecheck` — 期望无错误。

- [ ] **Step 2: 跑全部测试**

Run:
```bash
env -u TSX_TSCONFIG_PATH node --import tsx --test $(find src -name '*.test.ts' -o -name '*.test.tsx')
```
Expected: 全部 PASS(至少包括 Button.test.tsx 与 TerminalToggleButton.test.tsx)。

- [ ] **Step 3: 手工核对(可选,开发模式)**

Run: `npm run dev`,人工检查六个按钮在浅色/深色下 hover/active 状态,以及侧栏两按钮并排一行的布局。

- [ ] **Step 4: 最终 Commit(若 Step 3 有微调)**

```bash
git add -A
git commit -m "style(ui): finalize chunky button unification"
```

---

## Self-Review

- **Spec 覆盖:** 六个按钮各对应 Task 2-6;鉴权行对应 Task 7;共享 Button 变体对应 Task 1;深色 `dark:` 适配已内嵌在 variant 字符串中。✓
- **占位符扫描:** 无 TBD/TODO,每个 step 均有完整代码或命令。✓
- **类型一致性:** 所有按钮统一用 `variant="chunky"|"chunkyPrimary"` + `size="toolbar"|"sm"`;图标由 Button 基础类 `[&_svg]:size-4` 统一 16px,调用处不再传尺寸 class。✓
