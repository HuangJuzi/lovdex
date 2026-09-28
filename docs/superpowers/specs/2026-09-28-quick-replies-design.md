# 常用语（快速回复）设计

日期：2026-09-28
状态：已确认，待出实施计划

## 1. 背景与目标

会话里反复输入同样的几句话（「继续」「跑一下相关测试，失败就修到通过为止」「先别改代码，讲一下这块的实现原理」）是高频动作，目前只能每次手打或从别处复制。

目标：在会话聊天输入框的工具栏提供一个「常用语」入口，一键把预存的话填进输入框，并且能在同一个浮层里增删改这些常用语。

非目标（明确不做）：

- 只服务**会话聊天输入框**，不覆盖任务创建/编辑的 prompt 输入框、定时任务 prompt 输入框。（将来要接时，`useQuickReplies` + `buildQuickReplyInput` 可直接复用，本轮不为它预留抽象。）
- 不做多端冲突解决、不做跨设备同步协议；靠后端单表，天然多浏览器一致。
- 不做分类、标签、搜索、快捷键绑定（条目量级预期在几十条内）。
- 不做「一键收藏当前输入」的快捷捕获（方案 C 有此能力，本轮不选）。

## 2. 交互决策（已与用户逐条确认）

| 决策点 | 结论 |
|---|---|
| 生效范围 | 仅会话聊天输入框 |
| 唤出方式 | 工具栏一个独立图标按钮（不做斜杠别名） |
| 存储位置 | 后端数据库 |
| 点击后行为 | 填入输入框，**不自动发送**，用户自己按 Ctrl+Enter |
| 输入框已有内容时 | 空则直接填入；非空则**追加到末尾**（中间加一个空格） |
| 增删改入口 | 就在输入框浮层里完成，**不跳设置页** |
| 字段 | 只有正文，无标题 |
| 排序 | 按最后使用时间倒序；从未用过的排在最后 |
| 浮层形态 | **方案 A：紧凑行列表** —— 一条一行、超长截断，悬停行浮出「改 / 删」，编辑在浮层内**内联**成小 textarea，不弹 Dialog |

方案 A 的取舍：最轻、最贴近聊天工具的快速回复体感；代价是长正文在列表里被截断（放宽靠悬停 title 提示），以及编辑态需要自己处理浮层失焦关闭。因此**不引入** `QuickReplyDialog` 组件。

## 3. 数据设计

新表 `quick_replies`，DDL 以 `export const QUICK_REPLIES_TABLE_SCHEMA_SQL` 定义在 `backend/server/modules/database/schema.ts`（与 `NOTIFICATIONS_TABLE_SCHEMA_SQL` 同构，便于单测直接 `db.exec` 建表），同时加入两处：

- `INIT_SCHEMA_SQL`（新建库走这里，`initializeDatabase()` 执行）
- `migrations.ts` 的 `runMigrations()`（存量库升级走这里）

两处都要写，理由与 notifications 一致：只写前者，老库升级后不会有这张表。

```sql
CREATE TABLE IF NOT EXISTS quick_replies (
  quick_reply_id TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_last_used ON quick_replies(last_used_at);
```

- 主键用应用层 `randomUUID()`，跟随业务表（notifications / scheduled_tasks）惯例，不用 AUTOINCREMENT。
- 时间戳用裸 `CURRENT_TIMESTAMP`，与全库一致；前端解析一律走 `parseBackendTimestamp`（后端时间戳是裸 UTC）。
- **不建 `user_id` 列**：现有业务表（tasks / notifications / scheduled_tasks / sessions）都没有，数据是单用户事实模型。加它只会制造一个永远为 1 的列。

## 4. 后端接口

新模块 `backend/server/modules/quick-replies/`，形状对齐 notifications：

| 文件 | 职责 |
|---|---|
| `quick-replies.db.ts` | `createQuickRepliesDb(connection?)` DI 工厂；默认 `getConnection()`，测试传 `:memory:` 库。方法：`list / get / create / update / remove / touch` |
| `quick-replies.service.ts` | `createQuickRepliesService(db)`；校验与业务规则（空内容、重复内容） |
| `quick-replies.routes.ts` | `buildQuickRepliesRouter(svc)`；`express.Router()` + `asyncHandler`，错误 `throw new AppError(msg, {code, statusCode})` |
| `index.ts` | 唯一公共出口（`eslint-plugin-boundaries` 要求模块间只经 index.ts 互访） |

路由挂载与实例化位置，都在 `backend/server/index.js`：

```js
// 在 startServer() 内，await initializeDatabase() 之后
const quickRepliesDb = createQuickRepliesDb();
const quickRepliesService = createQuickRepliesService(quickRepliesDb);
app.use('/api/quick-replies', authenticateToken, buildQuickRepliesRouter(quickRepliesService));
```

**必须放在 `initializeDatabase()` 之后**：`createQuickRepliesDb` 里的 `prepare` 会在模块加载期校验表存在，提前调用会抛 `no such table` 并崩掉启动（notifications 踩过这个坑）。

### 接口清单

| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/api/quick-replies` | — | `{ items: QuickReply[] }` | 全部，不分页（量级小） |
| POST | `/api/quick-replies` | `{content}` | `QuickReply` (201) | 新建 |
| PUT | `/api/quick-replies/:id` | `{content}` | `QuickReply` | 改正文，刷新 `updated_at` |
| DELETE | `/api/quick-replies/:id` | — | `{success:true}` | 删除；不存在 → 404 |
| POST | `/api/quick-replies/:id/use` | — | `QuickReply` | 只刷新 `last_used_at` |

`QuickReply` 的线上形状（camelCase，与前端一致）：

```ts
{ quickReplyId: string; content: string; createdAt: string; updatedAt: string; lastUsedAt: string | null }
```

列表排序 SQL 显式写：

```sql
ORDER BY last_used_at IS NULL, last_used_at DESC, created_at DESC
```

第一键 `last_used_at IS NULL` 不能省：SQLite 的 `DESC` 虽然默认把 NULL 放最后，但依赖这个隐式行为太脆，显式写出来并由测试守住「从未使用的条目永远沉底」。

### 业务规则

- `content` trim 后为空 → 400 `QUICK_REPLY_EMPTY`
- `content` 与已有条目完全相同（trim 后比较）→ 409 `QUICK_REPLY_DUPLICATE`，提示「该常用语已存在」
- 不设长度上限（正文本身就是自由文本，输入框自己能滚）
- `PUT` / `DELETE` / `use` 目标 id 不存在 → 404 `QUICK_REPLY_NOT_FOUND`

重复内容为何拒绝：条目没有标题，两条一模一样的正文在列表里完全无法区分，允许重复是纯负担。

## 5. 前端设计

### 5.1 请求层

`web/src/utils/api.js` 增加 `api.quickReplies` 命名空间：`list / create / update / remove / touch`。跟随现有手写 fetch 封装（`authenticatedFetch`），方法返回原始 `Response`，由调用方判断 `res.ok`。不引入任何新依赖。

### 5.2 数据 hook

新文件 `web/src/components/chat/hooks/useQuickReplies.ts`，在 `useChatComposerState` 内以会话级单实例挂载（**不是**每个按钮一个实例），返回：

```ts
{
  items: QuickReply[];
  isLoading: boolean;
  error: string | null;
  create(content: string): Promise<void>;
  update(id: string, content: string): Promise<void>;
  remove(id: string): Promise<void>;
  markUsed(id: string): Promise<void>;
}
```

- 首次挂载拉一次列表。
- 写操作一律「请求成功后重拉列表」，**不做乐观更新**：服务端要按 `last_used_at` 重排，乐观插入/移动会让列表抖动，得不偿失。
- `markUsed` 是「发出去不阻塞」的旁路调用：不 await 在插入路径上，失败只吞掉（下一次 GET 会纠正顺序）。这样点一条常用语的填入是零延迟的。

### 5.3 组件

新组件 `web/src/components/chat/view/subcomponents/QuickRepliesMenu.tsx`（跟随 ChatComposer 的 subcomponents 目录约定），props：

```ts
{
  items, isLoading, error,
  anchorRef: RefObject<HTMLElement>,   // 工具栏按钮，用于定位
  onClose(): void,
  onSelect(item): void,
  onCreate(content): Promise<void>,
  onUpdate(id, content): Promise<void>,
  onRemove(id): Promise<void>,
}
```

结构（方案 A）：

- 窄浮层，顶部 header「常用语 / ＋ 新建」，下面一行一条。
- 每行：单行正文，`truncate` + `title={content}` 供悬停看全文。
- 悬停行时行尾浮出「改 ✎」「删 🗑」两个图标按钮（`opacity-0 group-hover:opacity-100`）。
- 点「改」该行原地换成一个小 `<textarea>` + 保存/取消；保存走 `onUpdate`。
- 点「删」直接删；因为条目轻量且是本地单用户，不做二次确认。
- 顶部「＋ 新建」在列表第一行位置展开一个空 textarea，保存走 `onCreate`。
- 空列表态：一行居中提示「还没有常用语」，下方仍是「＋ 新建」。

浮层定位与关闭，复用同文件 Effort 下拉的现成写法（`ChatComposer.tsx:535-597`）：

- `position: fixed` + `createPortal(..., document.body)`，`z-[100]`
- `transform: translateY(-100%)`，`top` 取按钮的 `getBoundingClientRect().top`，向上弹（输入框在屏幕底部，向下必然出屏）
- 打开时 `updatePosition()` 算一次；`maxHeight` 按按钮上方可用空间算，超出内部滚动
- 点外部关闭：照抄 `ChatComposer.tsx:252-253` 的 `contains` 判断，把浮层 ref 和按钮 ref 都排除

### 5.4 接线

`ChatComposer.tsx` 工具栏：在斜杠命令按钮（`ChatComposer.tsx:601`，`MessageSquareIcon`）**左边**插一个 `PromptInputButton`，图标用 lucide `Zap`（语义「快速」，需加进该文件已有的 `lucide-react` import 行），`tooltip` 文案「常用语」。

两个明确的小决定：**不带数量角标**（斜杠命令按钮的角标是命令条数，常有几十个，需要提示；常用语是用户自己攒的，数量没信息量），**不禁用移动端**（不加 `hidden sm:flex`，它是主要入口，窄屏也要能点）。

新增的两组 props 由 `ChatComposer` 透传，数据源在 `ChatInterface.tsx`（它已经在把 `useChatComposerState` 的一堆返回值往 `ChatComposer` 上铺）：

- `quickReplies` — 给菜单的 items/loading/error 与三个写操作
- `onInsertQuickReply(content: string)` — 由 `useChatComposerState` 提供

### 5.5 插入逻辑（纯函数）

新文件 `web/src/components/chat/utils/quickReplyInsert.ts`：

```ts
export function buildQuickReplyInput(current: string, content: string): string
```

规则：`current` trim 后为空 → 返回 `content`；否则 → `current + ' ' + content`。（不做「插入到光标处」——已确认是追加语义。）

抽成独立 `.ts` 纯函数是为了可测：前端测试没有 DOM 环境，只有纯函数能被 `node:test` 直接覆盖。

`onInsertQuickReply` 在 `useChatComposerState` 里做的事：

1. `setInput(buildQuickReplyInput(input, content))`
2. 关掉浮层
3. 把光标移到文本末尾，并重新自适应 textarea 高度（复用现有 `resizeTextarea`）
4. 调一次 `markUsed(id)`，不 await

**不自动发送**：用户改完再自己 Ctrl+Enter。

## 6. 测试

两边都是 `node:test`，均无 `test` npm script，显式跑文件（`npx tsx --test <file>`；后端需 `--tsconfig server/tsconfig.json`）。验收标准是「零新增失败」——两个仓库的 baseline 本身都不干净。

| 测试文件 | 覆盖 |
|---|---|
| `backend/server/modules/quick-replies/tests/quick-replies.db.test.ts` | `:memory:` + 直接 `db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL)`；create / list 排序（含「从未使用的沉底」「用过的最新在前」）/ update 刷新 `updated_at` / remove / touch 刷新 `last_used_at` |
| `backend/server/modules/quick-replies/tests/quick-replies.service.test.ts` | 空内容 → 400 `QUICK_REPLY_EMPTY`；重复内容（含前后空格差异）→ 409 `QUICK_REPLY_DUPLICATE` |
| `web/src/components/chat/utils/quickReplyInsert.test.ts` | 空输入 → 原样；非空 → 追加且单空格分隔；`current` 有尾随空格 → 不产生双空格 |

不做 E2E（浏览器自动化成本高，且本轮逻辑面窄，纯函数 + 仓储单测已覆盖风险点）。浮层视觉验收靠人工看一眼。

## 7. 提交拆分

1. `feat(quick-replies): 后端常用语表与 CRUD API`
   schema.ts（两处）+ migrations.ts + `modules/quick-replies/*` + `server/index.js` 挂载 + 两个后端测试
2. `feat(chat): 输入框常用语浮层`
   `utils/api.js` + `useQuickReplies.ts` + `QuickRepliesMenu.tsx` + `ChatComposer.tsx` 接线 + `ChatInterface.tsx` 透传 + `useChatComposerState` 插入逻辑 + `quickReplyInsert.ts` 及其测试

## 8. 已知风险与遗留

- **浮层与斜杠命令菜单的互斥**：两个都是从工具栏按钮弹的浮层。若同时打开会叠在一起。实现时打开常用语浮层要先关掉斜杠菜单（`onCloseCommandMenu` 已存在），反之亦然。这一条在实施计划里作为显式步骤，不留给实现者临场决定。
- **内联编辑态与「点外部关闭」冲突**：编辑 textarea 时点浮层内其他区域不应关闭浮层。关闭判断限定为「浮层 ref 之外」，编辑态不额外处理（textarea 在浮层内，天然被排除）。
- **游标操作依赖 DOM**：`setInput` 后移光标需要等 React 提交，用 `requestAnimationFrame` 或 `useEffect` 在 `input` 变化后置位。web 测试无 DOM，这条不做自动测试，靠人工验收。
- `last_used_at` 的写入是「用即打点」的旁路，若请求失败顺序会短暂不准，下次 GET 纠正。可接受。
- **同一秒内的 MRU 排序会退化**（2026-09-28 终审实测确认，经用户决定不修、只记录）。`last_used_at` / `created_at` 都是 `CURRENT_TIMESTAMP`（秒精度，全库惯例），并列时排序退化为 `created_at DESC`，再并列则退化为扫描序：
  - 同一秒内先点 C 再点 A（两次 `touch`）：两行 `last_used_at` 相同，实际顺序是 `C, A, B`，而 MRU 承诺应是 `A, C, B` —— **最后点的不在最前**。
  - 同一秒内连续 `create` 三条：`created_at` 相同，`list()` 返回插入正序 `A, B, C` —— **最新的排在最后**，与 `created_at DESC` 的意图相反。
  - 影响：手测清单「刚点过的那条排最前」「连建两条」在同一秒内会看到非预期顺序。不丢数据、不崩，跨秒后自愈。
  - 将来若要修，两个方向：把两列写入改成 `strftime('%Y-%m-%d %H:%M:%f','now')` 拿毫秒精度（改动集中在仓储层 3 处 SQL）；或在 `ORDER BY` 末尾补 `rowid DESC` 做 tie-break（只能解决「后建/后改的在前」，两次 `touch` 同秒仍分不出先后）。

## 9. 实施记录（2026-09-28）

按 `docs/superpowers/plans/2026-09-28-quick-replies.md` 执行完毕，12 个提交（`010b622`..`e5649be` 区间内的 quick-replies 相关提交）。实施中相对本 spec 的偏离与修正：

1. **接口返回 snake_case，不是本 spec §4 写的 camelCase。** 仓库同类小表 API（`notifications`、`scheduled-tasks`）都是直接透出行，前端 `inboxStore` 消费的就是 `notification_id`；跟惯例走省掉了整层映射。这是 spec 写错了，以实现为准。
2. **`buildQuickReplyInput` 两端做 `trim()`。** 本 spec §5.5 的正文（「非空则 `current + ' ' + content`」）与 §6 的测试要求（「尾随空格 → 不产生双空格」）自相矛盾，以 §6 为准。
3. **`update` 目标不存在时优先 404。** 初版实现把「重复内容检查」放在「id 存在性检查」之前，导致用一个已存在的正文去 PUT 一个不存在的 id 会误报 409。已修（`949b519`）。
4. **编辑器行需要按「正在编辑哪一条」加 key。** 从一个条目的编辑态直接点另一条的「改」，React 会复用同位置的 `EditorRow`，而它的 textarea 值是组件内部 state（只由 `initialContent` 初始化一次），会留住上一条的文本。已修（`92a88a8`）。
5. **新增态编辑行渲染在列表最前面**（与 §5.3 一致），行尾「改 / 删」按钮补了 `focus:opacity-100`（键盘可达）。已修（`e5649be`）。
6. **`refresh()` 失败改为抛错，并加刷新代际计数。** 写成功但紧随的列表 GET 失败时，原先会静默关掉编辑框而列表仍是旧数据；同时 `markUsed` 的旁路刷新与写操作的刷新并发时，乱序返回的旧响应会短暂冲掉刚建的条目。已修（`651c2a5`）。

## 10. 尚未验证的部分

**浏览器交互尚未验证。** 后端重启后已在运行实例上验过接口与建表（见下），但浮层的真实交互（Escape、互斥、窄屏、视觉）还没在浏览器里过一遍。重启后端后 `curl http://127.0.0.1:3188/api/quick-replies` 应从 404 变为 401，并在浏览器过一遍计划 Task 9 的 14 条手工清单——重点：Escape 关浮层**不触发会话中断**、浮层与斜杠菜单互斥、窄屏 ⚡ 按钮可见、同秒排序按上面记录的预期表现。

### 已验（重启后实测）

- 路由已加载：`/api/quick-replies` 返回 401（与 `/api/scheduled-tasks`、`/api/notifications` 一致）。
- 生产库 `~/.lovdex/data/new-auth.db` 建出了 `quick_replies` 表，列与索引 `idx_quick_replies_last_used` 齐全。
- 带 JWT 走了一遍完整 CRUD：建（201）、重复内容（409）、空内容（400）、改（200）、打点（200）、删（200）、重复删（404）、列表（`{items:[...]}`，snake_case 字段齐全）。测试数据已清理，库里回到 0 行。

### 新发现：错误响应的形状是错的，且**不是本功能引入的**

实测发现 **所有 `AppError` 的响应体都是 HTML、不是 JSON**：

```
HTTP/1.1 409 Conflict
Content-Type: text/html; charset=utf-8
<!DOCTYPE html>...<pre>AppError: 常用语已存在<br> at normalizeContent (...)</pre>
```

状态码是对的（409/404/400 都正确），但 body 是 express 默认错误页，还带上服务端堆栈。根因是 `backend/server/index.js` 里模块级的全局错误中间件（**2012 行**）在 `startServer()` 里挂的**所有**路由之前注册（`app.use('/api/notifications', ...)` 在 2261、`app.use('/api/quick-replies', ...)` 在 2266）。Express 按注册顺序匹配，请求先命中这些路由，错误中间件永远轮不到。**`/api/notifications` 同样如此**（实测其 404 也是 HTML），所以这是既有的架构顺序问题，不是本功能引入的。

对用户可见的影响：新建重复常用语时是显式成功路径，浮层依赖后端的中文文案「该常用语已存在」提示（`QuickRepliesMenu` 的 `handleSave` catch 后用 `err.message`），而 `readErrorMessage` 解析 HTML 会失败，退化成兜底的「请求失败（409）」。**功能不会坏，但文案提示会退化。** 修法是把错误中间件移到 `startServer()` 之内、所有路由挂载之后（`server.listen` 之前）。这会影响全后端所有路由的错误响应形状，**属于本功能范围之外的改动，完成前需要单独确认**。
