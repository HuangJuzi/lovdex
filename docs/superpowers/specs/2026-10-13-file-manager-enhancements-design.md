# 文件管理增强：多选、拖拽移动、文件夹上传

**日期**：2026-10-13
**状态**：已确认（方案 A：现有 FileTree 增量扩展）
**范围**：文件管理 tab（FileTree）。对话框上传限制明确**不改**（本次需求第一项在澄清中撤销）。

## 背景

文件管理（项目内 `files` tab）现状：

- 上传有「选文件」按钮和拖入上传，但拖拽目标永远是项目根；无「选文件夹」入口
- 所有操作（rename/delete/download）均为单条目；无多选、无移动
- `useFileTreeUpload.ts:444-454` 已实现 per-item dragOver/drop handler 但**未接线**到树节点
- 后端有 rename（同目录改名，跨目录 EXDEV→400）、无 move 路由；lite RPC 协议有 `fs/rename` 无 `fs/move`
- 文件树上传限制：10GB/文件、20 文件/批（`upload-limits.ts` ↔ `constants.ts` 双份常量）
- 批量 ZIP 下载已存在但仅限单文件夹（`downloadFolderAsZip`，纯前端 JSZip 逐文件拉取）

## 需求

1. 文件管理支持「上传文件夹」（按钮 + 保留拖拽入口）
2. 上传可指定子文件夹为目标
3. 多选（Ctrl/Cmd 追加、Shift 范围、点空白清除）
4. 批量删除 / 批量下载 ZIP / 批量移动
5. 拖拽移动（本地项目 + 远程项目都支持；同名冲突报错不覆盖）

## 设计

### 1. 多选模型

新 hook `web/src/components/file-tree/hooks/useFileTreeSelection.ts`：

- 状态：`Set<string>`（节点相对路径）+ 锚点路径（Shift 范围选的锚）
- 交互：
  - 普通点击 = 原有行为（打开文件/展开目录）+ 清除多选
  - Ctrl/Cmd+点击 = 仅切换单项选中，抑制打开/展开（标准文件管理器语义）
  - Shift+点击 = 仅范围选（锚点到点击项之间的可见扁平序列），抑制打开/展开
  - 点空白区域 / Esc 清空选中
- 选中项高亮样式与 hover/active 区分；选中数 > 0 时文件树头部下方浮现**批量操作条**：`删除`、`下载 ZIP`、`取消选择`（显示已选 N 项）。移动不放按钮，拖拽即移动入口。

**祖先包含规则**：选中集合含某文件夹时，其子孙自动视为已包含——批量删除/移动/下载时跳过被选中祖先包含的子孙项（避免重复删/包两份）。前端做一次，后端 move 兜底做一次。

### 2. 批量删除

复用现有单条 `DELETE /api/projects/:projectId/files`（已带项目根保护、递归删除），前端按祖先包含规则去重后循环调用，逐条收集失败结果，结束后汇总 toast + 刷新树。确认弹窗复用现有 `DeleteConfirmation` 交互，文案「删除这 N 项？」，条目名超量折叠显示。**零后端改动**。

### 3. 批量下载 ZIP

纯前端。把 `downloadFolderAsZip`（`useFileTreeOperations.ts:298`）泛化为 `downloadItemsAsZip(items)`：

- 顶层按选中集合 + 祖先包含规则去重
- 文件 → `readFileBlob` 入包；文件夹 → 递归收集入包；ZIP 内路径保持相对结构
- 文件名 `{选择集标识}-<时间戳>.zip`
- 已知限制（沿用现状）：远程项目单文件 > 32MB 会 413（remote-fs 读上限），该文件跳过并在 toast 列出跳过清单

### 4. 上传文件夹 + 上传到子文件夹

**上传文件夹按钮**（`FileTreeHeader.tsx`）：Upload 按钮旁新增 `FolderUp` 图标按钮，触发隐藏 `<input type="file" webkitdirectory>`。文件自带 `webkitRelativePath`（首段 = 所选文件夹名，保留），`getRelativePath` 已优先读取、`buildFormData` 已写入 `relativePaths`、后端已按相对路径 `mkdir -p` 落位（本地 index.js:1712 / 远程 1637-1685）——**主链路零改动**。

**超过 20 文件分批**：webkitdirectory 选中数 > `MAX_FILE_UPLOAD_COUNT` 时按 20 个一批顺序上传（批间串行，避免 staging 目录互挤），进度条按整体字节数聚合。≤ 20 时走现有单批路径。

**上传到子文件夹**：

- per-item drop 接线：把已实现的 `handleItemDragOver`/`handleItemDrop` 绑到目录节点，外部文件拖到目录行上时 `dropTarget` = 该目录路径，`targetPath` 走现有 `?targetPath=` query
- `handleFileSelect` 补可选 `targetPath` 参数；目录右键菜单加「上传到此文件夹」，复用隐藏 input、上传时带 `targetPath`

### 5. 拖拽移动

#### 前端交互

- 树节点 `draggable`；`dragStart` 写自定义类型 `application/x-lovdex-tree-items`（内容 = 选中集合或被拖单项 + 内部拖拽标记）
- 目录节点同时是 drop 目标：`dragOver` 读 `dataTransfer.types` 区分——含自定义类型 = 内部移动（高亮 + `effectAllowed='move'`）；仅 `Files` = 外部上传（现有逻辑）
- 松手 → `moveFiles` API → 成功刷新树、清空选中；**部分冲突整批不落盘**（后端先检后动）
- 拖到根容器空白 = 移到项目根
- 前端拦截：目标是选中项自身或其子孙 → 不高亮、松手 toast「不能移动到自身内部」

#### 后端 `POST /api/projects/:projectId/files/move`

body：`{ items: [{ path, type }], targetDir }`，一次批量、原子语义（先检后动）：

1. `items` 非空、≤ 100 条
2. 每项与 `targetDir` 过 `validatePathInProject`；`targetDir` 须存在
3. 同批去重（祖先包含规则兜底）
4. 新路径 = `join(targetDir, basename(oldPath))`；**任一新路径已存在 → 整批 409，响应列出全部冲突名**
5. 父移动到自身子孙 → 403（`newPath === oldPath || newPath.startsWith(oldPath + sep)`）
6. 本地执行：逐项 `fsPromises.rename`（项目内同 FS；EXDEV 仍映射 400）

#### 远程项目（lite RPC）

- `protocol.ts` 新增 `makeFsMoveParamsSchema`（`{ items, targetDir }`）
- `remote-agent/src/fs.ts` 新增 `move(items, targetDir)`：`resolveWithinRoots` 约束下的先检后动 + 逐项 `fsp.rename`，含同样的子孙/冲突校验
- `remote-agent/src/rpc-dispatch.ts` 白名单加 `fs/move`
- 主侧 `remote-fs.service.ts` 加 `move()` 客户端方法；move 路由的远程分支调它
- **版本兼容**：旧 lite 报 unknown method → 主侧捕获返回 501 +「远程主机 agent 需升级后才支持移动」

## 错误处理汇总

| 场景 | 行为 |
|---|---|
| 批量删除部分失败 | 逐条汇总，toast 列失败项，刷新树 |
| ZIP 下载远程 > 32MB 文件 | 跳过该文件，toast 列跳过清单 |
| move 目标同名冲突 | 整批 409，前端列出冲突名，不动盘 |
| move 父 → 子孙 | 前端拦截 + 后端 403 双保险 |
| move 到不存在的 targetDir | 404 |
| 远程 lite 过旧不支持 fs/move | 501 + 升级提示 |
| 文件夹上传 > 20 文件 | 前端自动分批，串行上传 |
| 上传仍超 10GB/文件 | 现有校验照常报错 |

## 测试

- **单元**（`node --test`，遵循现有 `*.test.ts` 并置惯例）：
  - `useFileTreeSelection` 的祖先包含去重、Shift 范围、Ctrl 切换（纯函数部分抽离可测）
  - 分批逻辑：21/40/1000 文件的切批边界
  - lite `fs.move`：冲突 409 整批不动、父→子孙 403、同批去重、rename 失败中途 → 报错（明确不做回滚补偿，错误即停，用户重试）
  - move 路由校验逻辑（可用现有路由测试的注入方式，若 index.js 路由不可单测则在 lite 端测同构逻辑 + 主侧靠 E2E）
- **E2E**（puppeteer，参考 `docs`/既有 remote e2e recipe）：多选 → 批量删除；拖拽移动到子文件夹（浏览器 DnD 事件合成）；webkitdirectory 无法真实模拟 → 用 `DataTransfer` + `webkitGetAsEntry` 拖拽路径覆盖同等递归逻辑
- **验收底线**：`npm run typecheck` 零新增错误（baseline 已有 pre-existing）；后端测试 `--tsconfig server/tsconfig.json`

## 明确不做

- 对话框上传限制调整（需求撤销）
- 图片附件限制（维持 5MB）
- 移动的撤销/回滚
- 跨项目移动
- 远程 32MB 读上限的放宽
- 上传断点续传
