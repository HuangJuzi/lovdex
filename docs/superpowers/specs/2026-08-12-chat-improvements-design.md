# Chat 页四项体验改进 — 设计文档

> 状态：设计定稿 · 2026-08-12
> 定位：为 lovdex-cli 的 Chat 页补齐**文件上传（分析文件/日志）**、**消息渐进式加载修复**、**Task→Chat 恢复上次会话**、**手机端助手会话自动收起侧边栏**。
> 范围：lovdex-cli 前端 + lovdex-backend（文件上传新端点）；四个特性相互独立，可分开交付。

---

## 1. 背景与目标

当前 Chat 页存在四个痛点：

1. **只能传图片**：composer 的附件链路（`useChatComposerState.handleImageFiles` → `POST /api/assets/images` → multer fileFilter）硬编码为 `image/*`、上限 5MB。用户想上传日志/配置文件让 LLM 分析，没有入口。
2. **切换/刷新 session 会被历史刷屏**：初始加载其实已是「最近 20 + 滚动渐进 + 顶部 Load all」，但 3 处 `refreshFromServer()`（`useChatRealtimeHandlers.ts:304` complete 后、`ChatInterface.tsx:245` 重连后、`useChatSessionState.ts:591` externalMessageUpdate 后）**不带 limit 拉全量并整体替换** `serverMessages`，还顺带把 `hasMore` 置 false，渐进式加载被破坏。
3. **Task→Chat 丢会话**：Task 页 ViewSwitcher 点 chat 段 → `navigate('/')`，无 `sessionId` → `selectedSession=null` → 空状态。项目里没有任何「上次打开的 session」持久化。
4. **手机端助手会话不收侧边栏**：项目 session 点击走 `handleProjectSelect`/`handleSessionSelect` 会 `setSidebarOpen(false)`；Lovdex 助手 session 的 `openSession` 只 `navigate()`，抽屉不收起。

**目标**：
1. Chat composer 支持上传**任意类型文件（≤50MB，最多 5 个）**，存到**项目内临时目录**，发送时把文件绝对路径**拼在首条用户消息开头**，让代理知道文件在哪。
2. 让 `refreshFromServer` **有界化 + 合并**，任何路径都不再拉全量、不再破坏渐进加载。
3. **持久化「上次打开的 session」**，从 Task 页切回 Chat（非「打开会话」）时恢复，且跨浏览器刷新有效；「新建会话」清除。
4. 手机端点击助手 session 与项目 session 行为一致：**自动收起侧边栏**。

**不做的**（刻意排除）：
- 不为上传文件提供 HTTP 回读端点（代理直接读磁盘）；无 XSS/嗅探面。
- 不做全局/跨项目文件共享、文件历史、TTL 清理（项目删除时清理即可）。
- Feature 2 不改后端分页实现（`sliceTailPage` 已有），只改前端 store 刷新策略。
- Feature 3 不做「多 tab 同步 last-opened」（单浏览器 localStorage 即可）。

---

## 2. 方案选型

### Feature 1：文件上传
| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 项目内临时目录 + 路径注入（选）** | 上传到 `<项目路径>/.lovdex-tmp/`，首条消息开头拼 `[附件: <绝对路径>]` | ✅ 代理 cwd 内可直接读、无权限打扰；路径注入是纯文本，对所有 provider（Claude/Codex/Cursor/OpenCode/Sophcode）生效；聊天记录可见文件来源。❌ 项目目录里多一个隐藏文件夹（用内部 `.gitignore` 屏蔽）。 |
| B 全局上传目录 | 存 `~/.cloudcli/chat-uploads/` | ❌ 代理默认权限模式可能拒读 cwd 外的绝对路径；用户已明确选项目内。 |
| C 仅展示不注入 | 附件卡片展示，用户自行引用 | ❌ 与「首句带目录」需求不符。 |

**大小/类型**：任意 MIME、单文件 50MB、最多 5 个（用户确认）。

### Feature 2：渐进式加载
| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 有界刷新 + 按 id 合并（选）** | `refreshFromServer(sessionId, { limit })`，默认 `max(当前已加载, 20)` 上限 200；拉尾部页后保留旧前缀、新页覆盖尾部 | ✅ 滚动位置/渐进状态不丢；三个调用点零改动；已加载的旧消息在刷新后仍在。 |
| B 有界刷新 + 整体替换 | 同样有界，但直接替换 serverMessages | ❌ 用户滚上去加载过的旧消息刷新后缩到最近 200 条，体验倒退。 |
| C 去掉刷新 | 删除三处调用 | ❌ 失去 complete 后的服务端对账（realtime prune、编辑归一化）。 |

### Feature 3：恢复上次会话
| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 挂载时恢复（选）** | localStorage 存 `lovdex:last-opened-session`；`useProjectsState` 挂载且 URL 无 `sessionId` 时恢复 | ✅ `/tasks→/` 全新挂载命中恢复；`/session/:id→/`（新建会话）不重挂载且 key 已清，不误恢复；刷新也恢复；覆盖所有入口。 |
| B navigate state 标记 | 只有「从任务页点 chat 段」时带 state 恢复 | ❌ 范围太窄，刷新场景不生效，且要改 ViewSwitcher 调用。 |

### Feature 4：手机端助手会话收侧边栏
| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 专用回调（选）** | `useProjectsState` 新增 `handleAssistantSessionSelect`（navigate + isMobile 时收侧边栏），经 `sidebarSharedProps→Sidebar→SidebarContent→SidebarAssistant` 下发 `onOpenSession` | ✅ 与项目 session 行为对齐；不依赖助手 session 一定在 projects payload 里（实际在，双保险）。 |
| B 复用 handleSessionSelect | 把助手 session 构造成 ProjectSession 走同一入口 | ❌ 依赖构造的 session 字段齐全；语义混用。 |

---

## 3. 详细设计

### 3.1 Feature 1 — 文件上传

#### 后端（lovdex-backend）

**新增端点** `POST /api/assets/files?projectId=<project_id>`（挂在现有 `assets.routes.ts`，`authenticateToken` 已在 `/api/assets` 挂载处统一生效）。

- `multer.diskStorage.destination`：`projectsDb.getProjectPathById(projectId)` → `path.join(projectPath, '.lovdex-tmp')`。不存在则创建；首次创建时写入一个内部 `.gitignore`（内容 `*\n!.gitignore`），使上传文件不出现在用户仓库的 `git status`。
- 文件名：`{Date.now()}-{Math.round(Math.random()*1e9)}-{sanitized original}`（与图片一致，`originalname.replace(/[^a-zA-Z0-9.-]/g, '_')`）。
- `fileFilter`：放行任意 MIME。
- `limits`：`fileSize: 50 * 1024 * 1024`，`files: 5`。
- 响应：`{ files: [{ name, path, size, mimeType, projectId }] }`，`path` 为绝对路径。
- 错误：复用现有 `upload.array(...)(req, res, (err) => ...)` 包裹，Multer 超限/错误返回 400。

**新增 service** `modules/assets/services/file-assets.service.ts`：
- 常量 `PROJECT_TMP_DIR = '.lovdex-tmp'`。
- `ensureProjectTempDir(projectPath)`：mkdir（递归）+ 写入内部 `.gitignore`（幂等）。
- `buildStoredFileRecords(projectId, files)`：返回上面的记录数组。
- `removeProjectTempDir(projectPath)`：供项目删除时清理。

**项目删除挂钩**：`modules/projects/services/project-delete.service.ts` 在删除目录后调用 `removeProjectTempDir`（尽力而为，失败仅日志）。

#### 前端（lovdex-cli）

**`useChatComposerState.ts`**：
- 新增 `attachedFiles: File[]`、`uploadingFiles: Map<string, number>`、`fileErrors: Map<string, string>`。
- `handleFileFiles(files: File[])`：校验 size ≤ 50MB（超限写 `fileErrors`），最多 5 个。
- `handlePaste`：粘贴文件时按 `image/*` 分流到图片/文件。
- dropzone `accept` 放开为任意类型，`onDrop` 按 `file.type.startsWith('image/')` 分流。
- `handleSubmit`：若 `attachedFiles.length > 0`，先 `POST /api/assets/files?projectId=<selectedProject.projectId>`（FormData 字段 `files`），成功后：
  ```ts
  const prefix = uploadedFiles.map(f => `[附件: ${f.path}]`).join('\n');
  messageContent = prefix + (messageContent ? `\n\n${messageContent}` : '');
  ```
  失败则 `addMessage({ type: 'error', ... })` 并中断（与图片上传一致）。
- 提交成功后清空 `attachedFiles/uploadingFiles/fileErrors`。

**`ChatComposer.tsx`**：
- 图片按钮旁新增「附件」按钮（回形针 icon，`onClick` 打开文件选择器 `accept=""`）。
- `attachedFiles.length > 0` 时在输入框上方渲染文件 chips（文件名 + 大小 + 上传进度/错误 + 移除按钮）。
- 拖拽遮罩文案从「Drop images here」改为「Drop files here」。

**i18n**：`src/i18n/locales/en/chat.json` 增加附件相关文案（attachFiles / 文件过大 / 上传失败等）。当前 UI 仅打包英文资源（`i18n/config.js` `lng: 'en'`），沿用英文即可。

**渲染确认**：`[附件: /abs/path]` 为纯文本随 `content` 走 `chat.send`，不会被 `<images_input>`/`parseImagesInputTag` 剥离（那是 codex/cursor/opencode 对图片的包装）；Markdown 渲染为字面文本（无 `(url)` 不成链接）。

### 3.2 Feature 2 — 渐进式加载

**`stores/useSessionStore.ts` `refreshFromServer`**：

签名 `refreshFromServer(sessionId, opts?: { limit?: number })`。

```ts
const refreshFromServer = async (sessionId, opts = {}) => {
  const slot = getSlot(sessionId);
  const fetchTicket = ++slot._fetchSeq;
  // 有界化：默认 = max(当前已加载, MESSAGES_PER_PAGE)，上限 MAX_REFRESH_LIMIT
  const currentLen = slot.serverMessages.length;
  const limit = opts.limit ?? Math.min(Math.max(currentLen, 20), 200);
  const params = new URLSearchParams({ limit: String(limit), offset: '0' });
  ...
  const fetched = data.messages || [];
  if (fetchTicket <= slot._appliedFetchSeq) return;   // 陈旧响应丢弃
  slot._appliedFetchSeq = fetchTicket;

  // 按 id 合并：保留已加载的旧前缀（不在 fetched 里的），fetched 覆盖尾部
  const fetchedIds = new Set(fetched.map(m => m.id));
  const prefix = slot.serverMessages.filter(m => !fetchedIds.has(m.id));
  slot.serverMessages = [...prefix, ...fetched];
  seedWorkflowStateFromMessages(fetched);
  slot.total = data.total ?? slot.serverMessages.length;
  slot.hasMore = Boolean(data.hasMore);
  // offset 语义 = 「已从尾部消费的条数」（与 fetchFromServer/fetchMore 的累积一致）。
  // 合并后 serverMessages 是连续后缀，故 offset = 当前条数（封顶 total，防陈旧 total 越界）。
  slot.offset = Math.min(slot.serverMessages.length, slot.total);
  slot.fetchedAt = Date.now();
  slot.realtimeMessages = pruneRealtimeSupersededByServer(slot.serverMessages, slot.realtimeMessages);
  recomputeMergedIfNeeded(slot);
  notify(sessionId);
};
```

- `MAX_REFRESH_LIMIT = 200`（模块常量）。
- 三处调用点（`useChatRealtimeHandlers.ts:304`、`ChatInterface.tsx:245`、`useChatSessionState.ts:591`）**不改**，默认行为即修复。
- 若 `fetched.length === 0`（会话被清空等极端情况），合并后只剩 prefix，行为合理。
- 若 history 被 rewind/编辑导致尾部与旧前缀不衔接，`prefix` 中可能残留少数过期消息；可接受（Load all / 重新进入会话可纠正），不做更强对账。

**常量**：`MESSAGES_PER_PAGE` 保持 20；`MAX_REFRESH_LIMIT` 新增。

### 3.3 Feature 3 — 恢复上次会话

**`useProjectsState.ts`**：

- localStorage key 常量：`LAST_OPENED_SESSION_KEY = 'lovdex:last-opened-session'`。
- **写入 effect**（新增）：
  ```ts
  useEffect(() => {
    if (selectedSession?.id) {
      try { localStorage.setItem(LAST_OPENED_SESSION_KEY, selectedSession.id); } catch {}
    }
  }, [selectedSession?.id]);
  ```
- **清除**：`handleNewSession` 中 `localStorage.removeItem(LAST_OPENED_SESSION_KEY)`。
- **恢复 effect**（新增，与 URL 解析 effect 并列）：
  ```ts
  useEffect(() => {
    if (sessionId || projects.length === 0 || restoredOnceRef.current) return;
    let lastId = null;
    try { lastId = localStorage.getItem(LAST_OPENED_SESSION_KEY); } catch {}
    if (!lastId) return;
    for (const project of projects) {
      const match = project.sessions?.find(s => s.id === lastId);
      if (match) {
        const normalized = normalizeSessionProvider(match);
        setSelectedProject(project);
        setSelectedSession(normalized);
        restoredOnceRef.current = true;
        return;
      }
    }
    // 会话已删除 → 清掉无效 key
    try { localStorage.removeItem(LAST_OPENED_SESSION_KEY); } catch {}
  }, [sessionId, projects]);
  ```
- `restoredOnceRef = useRef(false)`：每次 `useProjectsState` 挂载只恢复一次（AppContent 从 `/tasks` 等非 AppContent 路由进入 `/` 时全新挂载）。
- 恢复时**只设置 state、不改 URL**（URL 保持 `/`）；`selectedSession` 一旦有值，`useChatSessionState` 正常加载该会话，后续行为与正常打开一致。
- 恢复后 `setSelectedProject`/`setSelectedSession` 会触发 `selectedSession?.id` 写入 effect（幂等）。

**行为矩阵**：
| 进入路径 | 挂载？ | URL sessionId | 结果 |
|---|---|---|---|
| `/tasks` → 点 chat 段 `navigate('/')` | 全新挂载 | 无 | 恢复 last-opened |
| 初始/刷新打开 `/` | 全新挂载 | 无 | 恢复 last-opened |
| 任务详情/看板「打开会话」→ `/session/:id` | 全新挂载 | 有 | URL 解析，不恢复 |
| 聊天内「新建会话」→ `/` | 不重挂载 | 无 | key 已清 + 不重挂载 → 空态 |
| 侧边栏点项目/助手 session → `/session/:id` | 不重挂载 | 有 | URL 解析，同时写入 last-opened |

### 3.4 Feature 4 — 手机端助手会话收侧边栏

**`useProjectsState.ts`**：
```ts
const handleAssistantSessionSelect = useCallback((targetSessionId: string) => {
  navigate(`/session/${targetSessionId}`);
  if (isMobile) setSidebarOpen(false);
}, [isMobile, navigate]);
```
- 加入 `sidebarSharedProps`（新增字段 `onAssistantSessionSelect`）并 return。

**`Sidebar` / `SidebarContent`**：`SidebarProps` 增加可选 `onAssistantSessionSelect`，`SidebarContent` 透传给 `SidebarAssistant`。

**`SidebarAssistant.tsx`**：新增可选 prop `onOpenSession?: (sessionId: string) => void`；`openSession` 改为：
```ts
const openSession = useCallback((sessionId: string) => {
  if (onOpenSession) { onOpenSession(sessionId); return; }
  navigate(`/session/${sessionId}`);
}, [onOpenSession, navigate]);
```
- 行点击逻辑不变（metaKey/ctrlKey 等修饰键仍走浏览器新开标签）。
- 助手 session 属 workspace 项目，URL 解析 effect 照常选中为 `selectedSession`。

---

## 4. 数据流

### 文件上传
```
Composer 选文件(任意类型, ≤50MB, ≤5) → handleFileFiles → 发送时 handleSubmit
  → POST /api/assets/files?projectId → multer 存 <project>/.lovdex-tmp/ + 内部 .gitignore
  → 返回 { files: [{ name, path, size, mimeType }] }
  → content = "[附件: path1]\n[附件: path2]\n\n" + 用户文字
  → chat.send { sessionId, content, options }
  → 代理 CLI 从 path 读文件分析 → 首条用户消息里可见路径
```

### 消息刷新
```
complete / reconnect / externalMessageUpdate
  → refreshFromServer(sid, { limit: 默认有界 })
  → GET /messages?limit≤200&offset=0 → 按 id 合并 serverMessages
  → hasMore 保留 → 滚动顶部继续 fetchMore → 渐进加载不破
```

---

## 5. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 上传非预期项目（projectId 无效/不存在） | 400；destination 回调 resolve 不到路径时 `cb(error)` |
| 文件超 50MB / 超过 5 个 | Multer `LIMIT_FILE_SIZE`/`LIMIT_FILE_COUNT` → 400，前端 chip 显示错误 |
| 上传失败 | composer `addMessage({ type: 'error' })`，不发送 chat.send（与图片一致） |
| 附件 + 空文本 | content 仅为附件行；会话摘要降级为文件名/「新会话」（沿用现状，不特殊处理） |
| 刷新时 old session 的 complete 乱序 | `_fetchSeq`/`_appliedFetchSeq` 陈旧丢弃逻辑已覆盖 |
| last-opened session 已删除 | 恢复时找不到 → 移除 localStorage key，空态 |
| 项目删除 | 顺带清理 `.lovdex-tmp`（尽力而为） |
| `.lovdex-tmp` 出现在 git status | 内部 `.gitignore`（`*` + `!.gitignore`）屏蔽 |

---

## 6. 测试

### 后端（vitest，现有测试基建）
- `file-assets.service.test.ts`：
  - `ensureProjectTempDir` 幂等、写入 `.gitignore`、返回正确目录。
  - `buildStoredFileRecords` 记录字段正确。
- `assets.files.routes.test.ts`（或并入现有 assets 测试）：
  - 上传任意 MIME 成功 → 文件落在 `projectPath/.lovdex-tmp/`，响应含绝对路径。
  - 超 50MB → 400。
  - projectId 无效 → 400/404。
  - 路径不逃逸（文件名净化，无 `../`）。

### 前端（vitest + testing-library，现有测试基建）
- `useChatComposerState`：
  - `handleFileFiles` 非图片文件进入 `attachedFiles`；超 50MB 进 `fileErrors`。
  - `handleSubmit` 带文件时 content 前缀为 `[附件: <path>]`，且上传后才发 `chat.send`；上传失败不发。
- `useSessionStore.refreshFromServer`：
  - 默认 limit 有界（≤200）；合并后旧前缀保留、尾部更新；`offset`/`hasMore`/`total` 重算正确。
  - 陈旧 fetch 返回时不覆盖。
- `useProjectsState`（新增恢复逻辑）：
  - 无 `sessionId` + 有 last-opened → 恢复 project+session；找不到 → 清 key。
  - `handleNewSession` 清 key。
- `SidebarAssistant`：`onOpenSession` prop 提供时调用它，否则 navigate。

---

## 7. 涉及文件清单

### lovdex-backend
- `server/modules/assets/assets.routes.ts`（新增 `/files` 端点）
- `server/modules/assets/services/file-assets.service.ts`（新增）
- `server/modules/projects/services/project-delete.service.ts`（挂钩清理）

### lovdex-cli
- `src/components/chat/hooks/useChatComposerState.ts`（attachedFiles + 上传 + 前缀）
- `src/components/chat/view/subcomponents/ChatComposer.tsx`（附件按钮/chips/drop 文案）
- `src/stores/useSessionStore.ts`（`refreshFromServer` 有界 + 合并）
- `src/hooks/useProjectsState.ts`（last-opened 持久化/恢复 + `handleAssistantSessionSelect`）
- `src/components/sidebar/view/Sidebar.tsx`、`subcomponents/SidebarContent.tsx`、`subcomponents/SidebarAssistant.tsx`（透传 `onOpenSession`）
- `src/i18n/locales/en/chat.json`（附件文案；UI 仅英文）

---

## 8. 交付顺序（建议）


1. Feature 2（渐进式加载）— 最小、独立、可立即验证刷屏修复。
2. Feature 4（手机收侧边栏）— 改动最小。
3. Feature 3（恢复上次会话）— 前端状态逻辑，含边界。
4. Feature 1（文件上传）— 跨前后端，量最大，最后做。

---

## 9. 变更记录

- **2026-08-12（实现后调整）**：
  - 第一版调整：消息加载默认量改为 5、取消滚动自动加载（见下）。
  - 最终版（用户确认）：**初始加载回到 20 条**（`MESSAGES_PER_PAGE`=20、`INITIAL_VISIBLE_MESSAGES`=20、刷新下限 `REFRESH_LIMIT_FLOOR`=20）；**「Load more」每次 +10 条**（新增 `LOAD_MORE_PAGE_SIZE`=10，仅用于 `loadOlderMessages` 的 fetchMore 与可见数递增）。
  - **取消滚动到顶部自动加载更早消息**（`handleScroll` 不再调用 `loadOlderMessages`）。更早消息只通过顶部 **「Load more」按钮**（点击加载 10 条）或既有 **「Load all」胶囊**（一次全拉）加载。
  - 「Scroll up to load more」被动提示改为可点击的 `Load more` 按钮（新增 i18n key `session.messages.loadMore`）。
