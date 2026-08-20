# HTML 文件渲染预览设计

日期：2026-08-20
状态：已确认

## 背景

chat 中出现的 `.html` 文件（如 agent 通过 Write 产出的页面）点击后会打开 `FilePreviewModal`，但 `classifyFile()` 把 `html` 归类为 `code`（Prism markup），只显示源码，无法看到渲染效果。`CodeEditor` 虽有 HTML 预览，但形式是「另开浏览器窗口 + iframe srcdoc + sandbox」（`web/src/components/code-editor/view/CodeEditor.tsx:88-104`），预览弹窗内没有渲染视图。

## 目标

在 `FilePreviewModal` 中为 `.html` / `.htm` 文件提供 iframe 渲染预览，形态复用 markdown 的「渲染 / 源码」切换模式。chat 内文件引用点击与文件树点击均走 `FilePreviewModal`，因此两处同时获益。

## 非目标（YAGNI）

- 不做 chat 消息流内的内联预览卡片。
- 不改动 `CodeEditor` 现有的「新窗口预览」。
- 不引入 DOMPurify（隔离由 iframe sandbox 承担；`rehype-raw` 维持不启用）。

## 方案对比（已选定方案 A）

- **A. 预览弹窗内 iframe 切换（选定）**：`FilePreviewModal` 增加「预览 / 源码」切换，默认预览。改动最小、与 markdown 体验统一。
- B. chat 内联渲染卡片：消息流中直接嵌入 iframe，交互更重，暂不需要。
- C. 两者都做：超出当前需求。

## 组件改动

### 1. `web/src/components/file-preview/filePreviewTypes.ts`

- `FileKind` 新增 `'html'`。
- `classifyFile()`：`html` / `htm` 扩展名返回 `{ kind: 'html', language: 'markup' }`（从 `CODE_LANG_MAP` 判断之前优先匹配；`CODE_LANG_MAP` 中的 `html` 条目移除）。
- 现有扩展名解析逻辑（`:line[:col]` 后缀剥离、大写转小写、点开头文件）不变，自动适用于 html。

### 2. `web/src/components/file-preview/FilePreviewBody.tsx`

- `html` 类文件渲染工具条：`预览 / 源码` 两个切换按钮（视觉复用 markdown 的 rendered/source 切换）。
- **预览（默认）**：`<iframe>` 占满弹窗内容区、白底、无边框：
  - `srcDoc={content}`
  - `sandbox="allow-scripts allow-forms allow-modals allow-popups"` — 与 CodeEditor 现有策略一致。**不允许** `allow-same-origin`：iframe 内脚本无法读取主应用的 cookie / localStorage / DOM。
  - `title={file name}`（可访问性）。
- **源码**：现有 Prism markup 高亮视图。
- 切换为组件局部 state，每次打开默认「预览」。

### 3. `web/src/components/file-preview/useFileContent.ts`

无需改动：html 类走现有文本读取路径（`readFile`），沿用 `MAX_PREVIEW_BYTES = 1.5MB` / `MAX_PREVIEW_LINES = 5000` 守卫——超限文件直接显示源码并提示截断，不渲染 iframe。

## 数据流

1. chat 中点击 `xxx.html`（或文件树点击 HTML 文件）→ `onFileOpen` → `MainContent.handleFileOpen` → `useFileOpenResolver` 解析完整路径。
2. 打开 `FilePreviewModal` → `useFileContent` 拉取文本内容。
3. `classifyFile()` 返回 `html` → `FilePreviewBody` 默认渲染 iframe 预览，用户可切换到源码视图。

## 安全策略

- iframe `sandbox` 允许脚本执行（AI 生成的 HTML 页面大多依赖 JS），但不给 `allow-same-origin`，页面脚本运行在 opaque origin，无法触达主应用凭证与存储。
- `srcDoc` 注入，内容不经过主应用 DOM，无需 HTML 消毒。

## 错误处理

- 文件读取失败 / 远程项目读取失败：沿用 `FilePreviewModal` 现有错误提示 UI。
- 超过大小/行数守卫：显示源码截断视图（复用现有截断提示），不提供 iframe 预览。
- iframe 内部脚本错误由 sandbox 天然隔离，不影响主应用，不做额外处理。

## 测试

- **单元测试**（`filePreviewTypes` 现有测试文件处扩展）：
  - `classifyFile('a/b/index.html')` → `{ kind: 'html', language: 'markup' }`
  - `classifyFile('page.htm')` → `html` 类
  - `classifyFile('PAGE.HTML')` → 大写扩展名 → `html` 类
  - `classifyFile('report.html:12:3')` → 带行列后缀 → `html` 类
  - 原有 `code` 类断言不受影响（`html` 不再落在 code）。
- **组件测试**（若仓库已有 FilePreview 组件测试模式则遵循，否则手动验证替代）：html 文件默认渲染带正确 sandbox 属性的 iframe；切换按钮可切到源码。
- **手动验证**：dev server（:5188）下在 chat 中点开一个 HTML 文件，确认默认渲染、切换源码正常、暗色主题下预览区为白底。

## 验收标准

- chat 中点击 `.html` / `.htm` 文件，弹窗默认显示渲染结果。
- 可切换到源码视图（Prism markup 高亮）。
- iframe 带 sandbox 且不含 `allow-same-origin`。
- 超限文件降级为源码视图。
- 前端测试零新增失败；typecheck/lint 零新增错误（仓库 baseline 本就不干净）。
