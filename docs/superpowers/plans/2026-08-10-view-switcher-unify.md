# ViewSwitcher 三页统一位置 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「聊天 / 任务」切换器从侧边栏搬到一个三页共用的内容区顶栏，消除 chat / task / task-detail 三页之间切换器「跳位闪动」。

**Architecture:** 纯前端（lovdex-cli）UI 调整。ViewSwitcher 撤出 `SidebarHeader`，在 `MainContent`（chat）、`TaskBoard`（tasks）、`TaskDetail` 三处的 header 左上使用同一宽度规格（`w-40 sm:w-44`）渲染；三个 header 用同一间距/边框规格；右侧操作按钮（查看任务 / 新建任务）只统一尺寸为 `h-8 px-3 text-sm`，位置不动。无路由、无后端、无新依赖改动。

**Tech Stack:** React 18 + TS + Vite，Tailwind CSS（`cn` = `twMerge(clsx(...))`），`node:test` + `tsx`。

> TDD 说明：本改动纯 UI/布局，无纯逻辑可单测。每个任务的「验证」= `npm run typecheck`（捕获 JSX/import 错误）+ 末尾的端到端 DOM 位置校验（Task 5）。运行 tsx 测试前必须先 `unset TSX_TSCONFIG_PATH`（shell 泄漏了指向不存在路径的 `server/tsconfig.json`）。

---

### Task 1: 从 SidebarHeader 移除 ViewSwitcher

**Files:**
- Modify: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarHeader.tsx`

- [ ] **Step 1: 删除两处 `<ViewSwitcher active="chat" />` 及 import**

删除桌面端（`md:block` 块内）的整块：
```tsx
        {/* Primary view switch: chat workspace vs task board */}
        <div className="mt-2.5">
          <ViewSwitcher active="chat" />
        </div>
```
删除移动端（`md:hidden` 块内）的完全相同的整块。

删除 import 行：
```tsx
import { ViewSwitcher } from '../../../tasks/ViewSwitcher';
```

- [ ] **Step 2: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: 无错误（无未使用 import 报错——项目 tsconfig 若开了 `noUnusedLocals` 会报 ViewSwitcher 未使用，删除后即消除）。

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git add src/components/sidebar/view/subcomponents/SidebarHeader.tsx && git commit -m "refactor(sidebar): remove view switcher from sidebar, move to content header"
```

---

### Task 2: Chat 页 header 加切换器 + 统一「查看任务」尺寸

**Files:**
- Modify: `lovdex-cli/src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: 引入 ViewSwitcher**

在现有 import 区（`import { STATUS_META } from '../../tasks/taskStatus';` 附近）加：
```tsx
import { ViewSwitcher } from '../../tasks/ViewSwitcher';
```

- [ ] **Step 2: header 左容器内插入切换器**

将 header 左容器：
```tsx
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
            <MainContentTitle
              activeTab={activeTab}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              shouldShowTasksTab={false}
            />
          </div>
```
改为（在 `MobileMenuButton` 之后、`MainContentTitle` 之前插入）：
```tsx
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
            <ViewSwitcher active="chat" className="w-40 flex-shrink-0 sm:w-44" />
            <MainContentTitle
              activeTab={activeTab}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              shouldShowTasksTab={false}
            />
          </div>
```

- [ ] **Step 3: 统一「查看任务」按钮尺寸**

将按钮 className：
```tsx
              className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
```
改为：
```tsx
              className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-3 text-sm text-foreground transition-colors hover:bg-accent"
```

- [ ] **Step 4: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git add src/components/main-content/view/MainContent.tsx && git commit -m "feat(chat): show view switcher in chat header, unify task button size"
```

---

### Task 3: 看板页 header 统一规格 + 「新建任务」尺寸

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 统一 header 类 + 切换器宽度 + 按钮尺寸**

将 header 块：
```tsx
      <header className="flex items-center gap-2 px-3 py-3 sm:gap-4 sm:px-6 sm:py-4">
        <ViewSwitcher active="tasks" className="w-44 flex-shrink-0 sm:w-48" />
        <div className="ml-auto">
          <Button size="sm" onClick={toggleCreateForm}>
            ＋ 新建任务
          </Button>
        </div>
      </header>
```
改为：
```tsx
      <header className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <ViewSwitcher active="tasks" className="w-40 flex-shrink-0 sm:w-44" />
        <div className="ml-auto">
          <Button size="sm" className="h-8 px-3 text-sm" onClick={toggleCreateForm}>
            ＋ 新建任务
          </Button>
        </div>
      </header>
```
注：`Button size="sm"` 给 `h-9`，追加 `className="h-8 px-3 text-sm"` 经 `cn`(twMerge) 覆盖为 `h-8`。

- [ ] **Step 2: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git add src/components/tasks/TaskBoard.tsx && git commit -m "refactor(tasks): unify task board header with chat header, unify create button size"
```

---

### Task 4: 详情页加 header（含切换器），面包屑上移

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 引入 ViewSwitcher**

在 import 区加：
```tsx
import { ViewSwitcher } from './ViewSwitcher';
```

- [ ] **Step 2: 主 return 顶部加 sticky header，删内容区面包屑行**

将主 return 开头：
```tsx
    <div className="h-dvh overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/tasks')}
          >
            ← 返回任务面板
          </button>
          <span className="text-xs text-muted-foreground/50">·</span>
          <button
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/')}
          >
            返回主页
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-start gap-3">
```
改为（面包屑上移到 header，用 `sticky top-0` 保持滚动时可见）：
```tsx
    <div className="h-dvh overflow-y-auto bg-background">
      <header className="pwa-header-safe sticky top-0 z-10 flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <ViewSwitcher active="tasks" className="w-40 flex-shrink-0 sm:w-44" />
        <div className="ml-auto flex flex-shrink-0 items-center gap-2">
          <button
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/tasks')}
          >
            ← 返回任务面板
          </button>
          <span className="text-xs text-muted-foreground/50">·</span>
          <button
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/')}
          >
            返回主页
          </button>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6 sm:p-8">
        <div className="mt-4 flex flex-wrap items-start gap-3">
```

- [ ] **Step 3: 删除一个多余的闭合 `</div>`**

将文件末尾的闭合块：
```tsx
          </div>
        </div>
      </div>
    </div>
  );
}
```
改为（去掉最外层多出的一个 `</div>`，因为面包屑 div 已删，div 开闭数保持平衡：外层 `h-dvh`、`max-w-3xl`、`mt-4` 三个开，三个闭）：
```tsx
          </div>
        </div>
      </div>
  );
}
```

- [ ] **Step 4: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: 无错误。若 JSX 不平衡 typecheck 会报错，Step 3 需核对 div 开闭数。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git add src/components/tasks/TaskDetail.tsx && git commit -m "feat(tasks): add view switcher header to task detail page"
```

---

### Task 5: 端到端验证（DOM 位置一致性）

**Files:**
- Create: `/tmp/pw-verify/verify-switch-position.js`

- [ ] **Step 1: 确认 app 在跑**

Run: `curl -s -o /dev/null -w '%{http_code}' http://localhost:5187/`
Expected: `200`（supervisor 已在 :5187 跑 vite dev/HMR，改动已热更新）。

- [ ] **Step 2: 运行 Playwright 位置校验脚本**

写 `/tmp/pw-verify/verify-switch-position.js`：
```js
const { chromium } = require('playwright');

const FRONT = 'http://localhost:5187';
const TASK_ID = '312ea8b5-316d-474f-81c7-9c3dee52a920'; // 已知任务（此前会话用过）

async function switchBox(page) {
  // exact:true 避免误匹配「查看任务」
  return page.getByRole('button', { name: '任务', exact: true }).boundingBox();
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/home/zhijuhuang/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const pagesMeta = [
    ['chat', '/'],
    ['tasks', '/tasks'],
    ['detail', `/task/${TASK_ID}`],
  ];
  const boxes = {};
  for (const [label, url] of pagesMeta) {
    await page.goto(`${FRONT}${url}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    boxes[label] = await switchBox(page);
    console.log(label, 'switch box:', JSON.stringify(boxes[label]));
  }

  const ys = Object.values(boxes).map((b) => b && b.y).filter(Number.isFinite);
  const heights = Object.values(boxes).map((b) => b && b.height).filter(Number.isFinite);
  const yDiff = Math.max(...ys) - Math.min(...ys);
  const hDiff = Math.max(...heights) - Math.min(...heights);
  console.log('y max diff:', yDiff, '(expect <= 4)');
  console.log('height max diff:', hDiff, '(expect <= 4)');
  console.log('all three pages have switch:', Object.values(boxes).every(Boolean));

  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
```
Run: `cd /tmp/pw-verify && node verify-switch-position.js`
Expected:
- 三页都打印非 null 的 switch 位置（详情页此前没有切换器，现在必须有）。
- `y max diff <= 4`：三页切换器距视口顶部一致（chat/tasks/detail 都在 header 顶部同一 y）。
- `height max diff <= 4`：三页切换器尺寸一致。
- 注：`x` 在 chat 页会因侧边栏存在而偏右约一个侧边栏宽，这是方案 A 预期（切换器锚定内容区左上），不属于回归。

- [ ] **Step 3: 跑既有测试确认无回归**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/sidebar/view/subcomponents/SidebarResizeHandle.test.tsx src/components/tasks/TaskResultPanel.test.tsx`
Expected: 全部 pass（这些文件未被改动，确认改动未破坏共享依赖）。

- [ ] **Step 4: 汇总**

如三项全过，向用户报告：三页切换器位置/尺寸一致、右上按钮尺寸统一、详情页补上切换器；若 `y max diff > 4`，说明某页 header 间距未对齐，回查该 Task 的 header 类名。

（完成后是否需要合并推送，等用户指示。）