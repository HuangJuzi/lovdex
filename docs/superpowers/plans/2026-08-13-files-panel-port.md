# Files 面板移植（Phase 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 claudecodeui 的 Files 面板（文件树 + CodeMirror 6 编辑器）移植进 lovdex-cli，并在 MainContent 恢复 `activeTab === 'files'` 标签页。

**Architecture:** 组件级直接移植（两边 React 18 + Tailwind + lucide + 同构 `shared/view/ui` 与 `api.js`），加一个薄适配层：i18n 补 `codeEditor.json`、替换 `PaletteOpsContext` 引用、MainContent 装配 `FileTree` + `EditorSidebar` + 新标签切换。后端零改动（文件接口已存在）。

**Tech Stack:** React 18 / Vite / Tailwind / `@uiw/react-codemirror`（CodeMirror 6）/ `gzip`（文件夹下载）/ Node 内置 `node:test` + `tsx`。

**设计文档:** `docs/superpowers/specs/2026-08-13-files-source-control-port-design.md`（§3、§5）

---
## 前置与约定

- 源根（只读参考）：`CCUI=/home/zhijuhuang/workdir/claudecodeui/src`
- 目标前端根：`LOVDEX_CLI=/mnt/b/workdir/github/lovdex/lovdex-cli`
- git repo：`lovdex-cli/` 单独 git repo（在 `main`），提交直接落 main（符合本仓库习惯），每任务一提交。
- **环境坑**（memory `lovdex-tsx-env-gotcha`）：shell 全局 export 了 `TSX_TSCONFIG_PATH=server/tsconfig.json`，跑 cli 测试前必须 `unset TSX_TSCONFIG_PATH`。
- 测试命令（已实测）：`cd $LOVDEX_CLI && unset TSX_TSCONFIG_PATH && npx tsx --test <file>`。测试框架是 Node 内置 `node:test`，组件用 `renderToStaticMarkup`（无 jsdom，仓库无 vitest）。
- 验证命令：`npm run typecheck`、`npm run build`。
- 所有 `cp` 用 `cp -r`；目标路径的 `components/` 目录已存在。

---

## File Structure Map

**新建（从 claudecodeui 拷贝后适配）**
```
lovdex-cli/src/components/code-editor/          # 整个目录
lovdex-cli/src/components/file-tree/            # 整个目录
```
**新建（本项目手写）**
```
lovdex-cli/src/components/main-content/view/subcomponents/MainContentTabs.tsx   # chat/files/git 标签切换
lovdex-cli/src/components/file-tree/utils/fileTreeUtils.test.ts                 # 移植纯逻辑的测试
```
**修改**
```
lovdex-cli/package.json                          # +CodeMirror 组 + jszip
lovdex-cli/src/i18n/locales/en/codeEditor.json   # 从 claudecodeui 拷贝（新文件）
lovdex-cli/src/i18n/locales/en/common.json       # +fileTree.loadFailed
lovdex-cli/src/components/code-editor/view/CodeEditor.tsx   # PaletteOps → stub
lovdex-cli/src/components/main-content/view/MainContent.tsx # 恢复 files tab + EditorSidebar + MainContentTabs
```
**不改动**：后端任何文件；`useProjectsState.ts`；`ChatInterface`；`FilePreviewModal`。

---

### Task 1: 添加 npm 依赖

**Files:**
- Modify: `$LOVDEX_CLI/package.json`

- [ ] **Step 1: 往 dependencies 加依赖**

`package.json` 的 `"dependencies"` 对象（`react-dropzone` 附近）追加：

```json
    "@codemirror/lang-css": "^6.3.1",
    "@codemirror/lang-html": "^6.4.9",
    "@codemirror/lang-javascript": "^6.2.4",
    "@codemirror/lang-json": "^6.0.1",
    "@codemirror/lang-markdown": "^6.3.3",
    "@codemirror/lang-python": "^6.2.1",
    "@codemirror/merge": "^6.11.1",
    "@replit/codemirror-minimap": "^0.5.2",
    "@uiw/react-codemirror": "^4.23.13",
    "jszip": "^3.10.1",
```

- [ ] **Step 2: 安装**

Run: `cd $LOVDEX_CLI && npm install`
Expected: `added N packages`，无报错。

- [ ] **Step 3: 提交**

```bash
cd $LOVDEX_CLI && git add package.json package-lock.json && git commit -m "chore: add CodeMirror and jszip dependencies for Files panel"
```

---

### Task 2: 移植 i18n（codeEditor.json + fileTree.loadFailed）

**Files:**
- Create: `$LOVDEX_CLI/src/i18n/locales/en/codeEditor.json`
- Modify: `$LOVDEX_CLI/src/i18n/locales/en/common.json`

- [ ] **Step 1: 拷贝 codeEditor namespace**

Run:
```bash
cp $CCUI/i18n/locales/en/codeEditor.json $LOVDEX_CLI/src/i18n/locales/en/codeEditor.json
```

- [ ] **Step 2: 补 common.json 缺失 key**

在 `common.json` 的 `"fileTree"` 对象内（`"loadFailed"` 前）加：

```json
    "loadFailed": "Could not load file tree. Please try again.",
```

（保留其他已有 `fileTree.*` keys 不动；只缺这一个。）

- [ ] **Step 3: 验证 JSON 合法**

Run: `cd $LOVDEX_CLI && node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/en/codeEditor.json')); JSON.parse(require('fs').readFileSync('src/i18n/locales/en/common.json')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: 提交**

```bash
cd $LOVDEX_CLI && git add src/i18n/ && git commit -m "feat: add codeEditor i18n namespace and fileTree.loadFailed"
```

---

### Task 3: 移植 code-editor 组件树

**Files:**
- Create: `$LOVDEX_CLI/src/components/code-editor/**`（从 claudecodeui 整目录拷贝）
- Modify: `$LOVDEX_CLI/src/components/code-editor/view/CodeEditor.tsx`（PaletteOps 适配）

- [ ] **Step 1: 拷贝整目录**

Run:
```bash
cp -r $CCUI/components/code-editor $LOVDEX_CLI/src/components/code-editor
```

- [ ] **Step 2: 确认无 `PaletteOpsContext` 之外的跨目录缺口**

Run: `cd $LOVDEX_CLI/src/components/code-editor && grep -rn "from '.*contexts/PaletteOps'" .`
Expected: 只有 `view/CodeEditor.tsx:7` 一行（已确认两边 `shared/view/ui` 目录名逐一相同、`ThemeContext` 有 `useTheme`/`isDarkMode`、`utils/api` 有 `api`/`authenticatedFetch`、`types/app` 有 `Project`、`lib/utils` 有 `cn`——这些 import 均直接生效）。

- [ ] **Step 3: 替换 PaletteOps 引用为 stub**

编辑 `view/CodeEditor.tsx`：

把第 7 行
```tsx
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
```
替换为
```tsx
// PaletteOps doesn't exist in lovdex (settings modal is a simplified-edition
// leftover). Keep the editor's settings button a no-op.
const usePaletteOps = () => ({ openSettings: () => {} });
```

其余（第 44 行 `const paletteOps = usePaletteOps();`、第 261 行 `onOpenSettings={() => paletteOps.openSettings('appearance')}`）**不用改**，stub 签名兼容。

- [ ] **Step 4: 提交**

```bash
cd $LOVDEX_CLI && git add src/components/code-editor && git commit -m "feat: port CodeMirror-based code editor from claudecodeui"
```

---

### Task 4: 移植 file-tree 组件树

**Files:**
- Create: `$LOVDEX_CLI/src/components/file-tree/**`（从 claudecodeui 整目录拷贝）

- [ ] **Step 1: 拷贝整目录**

Run:
```bash
cp -r $CCUI/components/file-tree $LOVDEX_CLI/src/components/file-tree
```

- [ ] **Step 2: 确认无跨目录缺口**

Run: `cd $LOVDEX_CLI/src/components/file-tree && grep -rn "from '.*contexts/" . ; grep -rn "jszip" hooks/ | head -2`
Expected: 无 contexts 引用；`useFileTreeOperations.ts` 里 `jszip` import 存在（依赖已在 Task 1 装好）。

已知可用的外部依赖（无需改动）：`api`/`authenticatedFetch`（`utils/api`）、`Project`（`types/app`）、`cn`（`lib/utils`）、`Button`/`Input`/`ScrollArea`（`shared/view/ui`，两边目录逐一相同）、`react-dropzone`、`i18next`。图片查看器用 `react-markdown`+`rehype-katex`+`remark-gfm`+`remark-math`+`react-syntax-highlighter`（lovdex 均已装）。

- [ ] **Step 3: 提交**

```bash
cd $LOVDEX_CLI && git add src/components/file-tree && git commit -m "feat: port file tree panel from claudecodeui"
```

---

### Task 5: fileTreeUtils 纯逻辑测试（TDD）

**Files:**
- Create: `$LOVDEX_CLI/src/components/file-tree/utils/fileTreeUtils.test.ts`
- Subject: `fileTreeUtils.ts`（已随 Task 4 拷贝，含 `filterFileTree`、`formatFileSize`）

- [ ] **Step 1: 确认被测试源的真实签名**

源 `fileTreeUtils.ts` 实际导出（已核对）：

```ts
export function filterFileTree(items: FileTreeNode[], query: string): FileTreeNode[]
export function collectExpandedDirectoryPaths(items: FileTreeNode[]): string[]
export function formatFileSize(bytes?: number): string    // 0/undefined → '0 B'; 1024 → '1 KB'; 1536 → '1.5 KB'
```

- [ ] **Step 2: 写失败测试**

Create `src/components/file-tree/utils/fileTreeUtils.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { filterFileTree, formatFileSize } from './fileTreeUtils';
import type { FileTreeNode } from '../types/types';

const tree: FileTreeNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [
      { name: 'utils', path: 'src/utils', type: 'directory', children: [
        { name: 'format.ts', path: 'src/utils/format.ts', type: 'file' },
      ]},
      { name: 'index.ts', path: 'src/index.ts', type: 'file' },
    ],
  },
  { name: 'README.md', path: 'README.md', type: 'file' },
];

test('filterFileTree keeps ancestors of matches and drops unrelated branches', () => {
  const filtered = filterFileTree(tree, 'format');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, 'src');
  assert.equal(filtered[0].children?.length, 1);
  assert.equal(filtered[0].children?.[0].name, 'utils');
  assert.equal(filtered[0].children?.[0].children?.[0].name, 'format.ts');
});

test('formatFileSize formats bytes', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(undefined), '0 B');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
});
```

（`FileTreeNode` 类型字段以 `$LOVDEX_CLI/src/components/file-tree/types/types.ts` 实际声明为准——若 `children` 为空数组而非可选，构造树时适配。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd $LOVDEX_CLI && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/file-tree/utils/fileTreeUtils.test.ts`
Expected: FAIL（若构造函数与类型不符，`tsx` 会先报类型/语法错误——同样算失败信号）。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 3。
Expected: `# pass 2`、`# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd $LOVDEX_CLI && git add src/components/file-tree/utils/fileTreeUtils.test.ts && git commit -m "test: cover fileTreeUtils filter/format logic"
```

---

### Task 6: MainContent 集成（files tab + EditorSidebar + MainContentTabs）

**Files:**
- Create: `$LOVDEX_CLI/src/components/main-content/view/subcomponents/MainContentTabs.tsx`
- Modify: `$LOVDEX_CLI/src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: 新建标签切换组件 MainContentTabs**

Create `subcomponents/MainContentTabs.tsx`：

```tsx
import { FolderOpen, GitBranch, MessageSquare } from 'lucide-react';
import type { AppTab } from '../../../../types/app';
import { cn } from '../../../../lib/utils';

type Props = {
  activeTab: AppTab;
  onSelect: (tab: 'chat' | 'files' | 'git') => void;
  className?: string;
};

/**
 * Project-scoped tabs inside the main content area (chat / files / git).
 * Persisted via useProjectsState's activeTab. The chat<->tasks switcher
 * (ViewSwitcher) remains route navigation and is unchanged.
 */
export function MainContentTabs({ activeTab, onSelect, className }: Props) {
  const items = [
    { value: 'chat' as const, label: 'Chat', icon: MessageSquare },
    { value: 'files' as const, label: 'Files', icon: FolderOpen },
    { value: 'git' as const, label: 'Source Control', icon: GitBranch },
  ];
  return (
    <div className={cn('flex rounded-xl border border-border/70 bg-muted/50 p-0.5', className)}>
      {items.map(({ value, label, icon: Icon }) => {
        const isActive = activeTab === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isActive}
            onClick={() => !isActive && onSelect(value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-normal transition-all',
              isActive
                ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('h-3 w-3 flex-shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default MainContentTabs;
```

- [ ] **Step 2: MainContent 加 import**

编辑 `view/MainContent.tsx`，在现有 import 块加：

```tsx
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import FileTree from '../../file-tree/view/FileTree';
import MainContentTabs from './subcomponents/MainContentTabs';
```

- [ ] **Step 3: 接入 useEditorSidebar**

`MainContent` 函数体内、`handleFileOpen`（现有 resolver）上方加：

```tsx
  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen: handleEditorOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({ selectedProject, isMobile });
```

并新增 props 解构（从现有 props 里取 `setActiveTab`）。`MainContentProps` 已含 `activeTab: AppTab` 与 `setActiveTab: Dispatch<SetStateAction<AppTab>>`——在函数参数解构列表加 `setActiveTab`。

- [ ] **Step 4: 头部渲染 MainContentTabs**

在 `<ViewSwitcher active="chat" className="w-40 ..." />` 之后加：

```tsx
        <MainContentTabs
          activeTab={activeTab}
          onSelect={(tab) => setActiveTab(tab)}
          className="ml-1 w-56 flex-shrink-0"
        />
```

（`activeTab` 已是 props；`git` 会在 Phase 2 生效，Phase 1 内点击 git 目前是空内容——见 Step 6。）

- [ ] **Step 5: body 恢复 files 分支**

现有 `{isLoading ? ... : !selectedProject ? ... : (<div>...<ChatInterface/></div>)}` 的 chat 容器改为在 `activeTab === 'chat'` 时显示，并在其内新增两个按 tab 条件渲染的兄弟块（本文件无需新增 `cn` import，直接用模板字符串）：

```tsx
        <div className={`flex min-h-0 min-w-[200px] flex-1 flex-col overflow-hidden ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
          <div className="h-full">
            <ErrorBoundary showDetails>
              <ChatInterface ...（保持现有 props 不动） />
            </ErrorBoundary>
          </div>
        </div>

        {activeTab === 'files' && (
          <div className="h-full overflow-hidden">
            <FileTree selectedProject={selectedProject} onFileOpen={handleEditorOpen} />
          </div>
        )}

        {activeTab === 'git' && (
          <div className="h-full overflow-hidden">
            {/* Phase 2 会用真正的 GitPanel 替换此占位 */}
            <MainContentStateView mode="empty" isMobile={isMobile} />
          </div>
        )}
```

> 说明：chat 容器沿用现有 `hidden`/`block` 切换（claudecodeui 同款）；files/git 是条件渲染兄弟块。Phase 1 期 git tab 显示空态占位，Phase 2 换成真 GitPanel。`MainContentStateView` 已在本文件 import。

- [ ] **Step 6: 挂 EditorSidebar**

在 `FilePreviewModal` 之前、layout 根内加（props 与 `EditorSidebar.tsx` 实际声明一一对应；**注意是 `onCloseEditor`，不是 `onClose`**；`projectPath` 用 lovdex 的 `fullPath`——claudecodeui 用的是其 `Project.path` 可选别名，lovdex 没有）：

```tsx
      <EditorSidebar
        editingFile={editingFile}
        isMobile={isMobile}
        editorExpanded={editorExpanded}
        editorWidth={editorWidth}
        hasManualWidth={hasManualWidth}
        resizeHandleRef={resizeHandleRef}
        onResizeStart={handleResizeStart}
        onCloseEditor={handleCloseEditor}
        onToggleEditorExpand={handleToggleEditorExpand}
        projectPath={selectedProject?.fullPath}
        fillSpace={activeTab === 'files'}
      />
```

- [ ] **Step 7: 更新简化版注释**

`MainContent.tsx` 顶部注释 `// Simplified edition...` 补一句：`Files tab restored (Phase 1); git/shell/browser still removed.`

- [ ] **Step 8: typecheck**

Run: `cd $LOVDEX_CLI && unset TSX_TSCONFIG_PATH && npm run typecheck`
Expected: `error TS` 清零。若编辑器相关 props 有出入，按实际类型修正 Step 6 调用。

- [ ] **Step 9: 提交**

```bash
cd $LOVDEX_CLI && git add src/components/main-content && git commit -m "feat: restore Files tab with file tree and editor sidebar in MainContent"
```

---

### Task 7: 全量验证（typecheck + build + 测试）

**Files:**
- 无源码改动；跑通全部验证

- [ ] **Step 1: 全量 typecheck**

Run: `cd $LOVDEX_CLI && unset TSX_TSCONFIG_PATH && npm run typecheck`
Expected: 0 错误。

- [ ] **Step 2: 全量测试**

Run: `cd $LOVDEX_CLI && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/file-preview src/components/file-tree 2>/dev/null || find src -name "*.test.*" -not -path "*/node_modules/*" -exec npx tsx --test {} +`
Expected: 所有既有测试 + 新增 `fileTreeUtils` 测试 `# pass`、`# fail 0`。

- [ ] **Step 3: 生产构建**

Run: `cd $LOVDEX_CLI && npm run build`
Expected: vite build 成功，`dist/` 更新，无 import 报错（未解析的 @/ 或相对 import 都会在这里暴露）。

- [ ] **Step 4: lint**

Run: `cd $LOVDEX_CLI && npm run lint`
Expected: 无 error（若有 warning 可接受；新增文件若有 unused imports 等 error 修掉）。

- [ ] **Step 5: 提交（如有修正）**

```bash
cd $LOVDEX_CLI && git add -u && git commit -m "fix: resolve typecheck/lint issues in Files panel port"
```
（若无改动则跳过。）

---

### Task 8: 手工验证

**Files:** 无（验证 UI 行为）

- [ ] **Step 1: 启动 dev server**

Run: `cd $LOVDEX_CLI && npm run dev`
在浏览器打开 dev URL，选中任一项目。

- [ ] **Step 2: Files 面板主流程**

1. 点击头部 `Files` 标签 → 文件树按目录渲染，`node_modules/.git` 等被忽略目录不出现
2. 搜索框输入子串 → 只显示匹配项且自动展开祖先
3. 点一个文本文件 → 右侧 EditorSidebar 打开，可编辑
4. 改内容 → 保存 → 用编辑器头部关闭再重开该文件 → 内容持久
5. 点一个图片文件 → ImageViewer 正常
6. 右键一个文件 → 新文件/文件夹、重命名、删除、复制路径、下载均可（zip 下载可用）
7. 拖拽上传一个文件 → 上传进度出现、完成后树刷新
8. switch 项目 → 树随项目切换；`activeTab` 刷新页面后仍停在 Files

- [ ] **Step 3: 不回归检查**

1. `Chat` 标签 → 会话正常收发，消息里的文件引用仍走 `FilePreviewModal` 只读预览
2. `tasks`（ViewSwitcher）→ `/tasks` 路由正常
3. 终端抽屉、任务页、设置入口不被破坏

- [ ] **Step 4: 如有 bug 记录并修复**

有 bug 回 Task 6 之后的小提交修复，重新 typecheck/build。

- [ ] **Step 5: 完成提交（若已有修复）**

```bash
cd $LOVDEX_CLI && git add -A && git commit -m "fix: Files panel edge cases found in manual verification"
```
（无改动则跳过。）Phase 1 结束——后端零改动、无需重启。进入 Phase 2 时另行编写 `2026-08-13-source-control-port.md` 计划。