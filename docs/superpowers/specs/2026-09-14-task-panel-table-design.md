# 任务面板（表格视图）设计

- 日期：2026-09-14
- 状态：设计稿（待审阅）

## 0. 文档目的与读者

本文定义一套**任务面板**的完整规格：数据模型、状态模型、REST API、前端组件与交互、错误处理、测试清单。读者是实现者（人或 agent），可直接按本文写代码，不需要参考任何其他项目。

**范围**：只做**表格视图**，不做看板；**不含执行引擎**（不把任务跑起来，不做引擎/模型选择）。**含**一项上下文能力：新建任务时可指定上下文来源，并选择是否压缩、如何压缩。

**本文不覆盖**：技术栈选型、部署、鉴权系统的具体实现（只要求"任务路由必须挂在鉴权之后"）、视觉设计稿（表格视觉见 §7.1 的样式要点）。

## 1. 范围

### 1.1 包含

1. 任务表格视图：列、排序、分组、状态筛选、行内操作、批量删除
2. 新建任务对话框
3. 任务数据模型与迁移
4. 任务 REST API：增删改查、状态流转、批量删除
5. 筛选栏：项目多选 + 日期范围
6. 状态模型：单层 `status`，5 个值，全部人工流转
7. 上下文来源与压缩模式：不压缩 / 摘要 / 原文（§6）

### 1.2 不包含

| 项 | 说明 |
|---|---|
| 看板视图 | 只做表格；`position` 列仍保留（服务端排序键），但无拖拽 |
| 执行引擎 | 不含引擎/模型选择、可用性探测、任务启动、运行状态联动 |
| 任务详情页 | 本次不做；表格整行点击可先留空 |
| 定时任务 | 视图与 API 都不做 |
| 子状态（`sub_status`） | 整层不做，见 §4.3 |
| 助手 / 机器人任务 | 无此概念 |
| 多 provider | 只有一个执行入口，写死在配置里，不建列 |
| 实时推送 | 可选；无推送时用轮询兜底，见 §6.6 |
| 上下文的消费侧 | 本文只负责**产出与入库**；产物如何被使用由实现方自行决定（§6.7） |
| 摘要的人工编辑 UI | 不做 |
| 多来源拼接 / 来源排序 | 只支持单个来源会话 |
| 按模型窗口动态计算上下文预算 | 只做字符数截断（§6.5） |

## 2. 术语

| 术语 | 含义 |
|---|---|
| **任务（Task）** | 一条待办记录，有状态、优先级、截止日期等属性 |
| **上下文来源** | 新建任务时可选的一个已有会话，作为新任务的背景信息来源 |
| **压缩模式** | 上下文来源的处理方式：不压缩（无上下文）/ 摘要 / 原文 |

## 3. 数据模型

### 3.1 `tasks` 表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `task_id` | TEXT | PRIMARY KEY NOT NULL | UUID |
| `project_path` | TEXT | NOT NULL | 归属项目的唯一标识（绝对路径或项目 ID，只要能唯一区分项目） |
| `title` | TEXT | NOT NULL | 名称 |
| `description` | TEXT | NULL | **任务提示词**，表单主输入 |
| `status` | TEXT | NOT NULL DEFAULT `'todo'` | CHECK 见 §4.1 |
| `priority` | TEXT | NOT NULL DEFAULT `'P2'` | CHECK `('P0','P1','P2','P3')` |
| `deadline` | TEXT | NULL | 严格 `YYYY-MM-DD`，含日历日真实性校验（§5.3） |
| `label` | TEXT | NOT NULL DEFAULT `'other'` | CHECK `('bug','feature','optimization','refactor','docs','other','reminder')` |
| `remark` | TEXT | NULL | 备注 |
| `position` | REAL | NOT NULL DEFAULT 0 | 同状态组内排序；新建时取该组 `MAX(position) + 1` |
| `started_at` | DATETIME | NULL | 写入规则见 §4.2 |
| `completed_at` | DATETIME | NULL | 写入规则见 §4.2 |
| `created_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | |
| `updated_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | 任何字段更新都要刷新 |
| `context_source_session_id` | TEXT | NULL | 上下文来源引用 |
| `context_mode` | TEXT | NOT NULL DEFAULT `'none'` | CHECK `('none','summary','raw')` |
| `context_status` | TEXT | NULL | CHECK `('pending','ready','failed')`；`none` 模式下为 NULL |
| `context_summary` | TEXT | NULL | `summary` 模式 `ready` 后的压缩产物 |
| `context_raw` | TEXT | NULL | `raw` 模式 `ready` 后的原始转录文本 |

**索引**：`(project_path, status)`；若有轮询未完成上下文任务的需求，加 `(context_status)`。

**不在本设计中的字段**（列出以免被误加）：运行会话关联、执行入口/模型、AI 摘要与判定结论、定时任务来源、子状态、助手标记。

### 3.2 时间字段的存储与传输

**存储**：若使用 SQLite，`CURRENT_TIMESTAMP` 写入的是**不带时区后缀的 UTC 字符串**（形如 `2026-09-14 03:21:00`）。直接按本地时间解析会导致整体时间偏移，必须按 UTC 解析。若使用带时区的类型（如 PostgreSQL `timestamptz`），此问题不存在。

**传输（硬性契约）**：`created_at` / `updated_at` / `started_at` / `completed_at` 在**进入 API 响应前**一律归一化为 ISO 8601 UTC 字符串，形如 `2026-09-14T03:21:00.000Z`。前端只按 ISO 解析，不关心存储格式。

### 3.3 迁移

新增列用**幂等的"不存在才加"**判据（先查列名快照，再 `ADD COLUMN`）。

**若使用 SQLite**：它不支持修改 CHECK 约束，改约束需走整表重建 —— `RENAME` 旧表 → 建新表 → `INSERT INTO ... SELECT`（含必要的值变换）→ `DROP` 旧表 → 重建索引，全程包在事务里并临时关闭外键。因此 `context_mode` / `context_status` 的取值集合一旦确定，应尽量不再变更。若使用支持 `ALTER ... DROP CONSTRAINT` 的数据库，则不受此限。

## 4. 状态模型

### 4.1 `status`（唯一一层）

```
todo → in_progress → in_review → done → archived
```

| 值 | 展示名 | 展示色 |
|---|---|---|
| `todo` | 待办 | `#fbbf24` |
| `in_progress` | 进行中 | `#60a5fa` |
| `in_review` | 评审 | `#a78bfa` |
| `done` | 完成 | `#34d399` |
| `archived` | 已归档 | `#9ca3af` |

**流转约束**：

- 禁止以 `archived` 创建任务。
- `archived` 只能从 `done` 进入，且只能退回 `done`（取消归档）。
- `archived` 只能由**用户操作**触发，不接受任何自动化路径写入。

### 4.2 时间戳写入规则

| 从 → 到 | `started_at` | `completed_at` |
|---|---|---|
| 任意 → `in_progress` | 写当前时间 | — |
| 任意（非 `archived`）→ `done` | — | 写当前时间 |
| `done` → 非 `done` 且非 `archived` | — | **清空** |
| `done` ↔ `archived` 互转 | — | **不动** |
| 同状态重复设置（`from === to`） | — | 不写任何时间戳 |

无论走哪条分支，`updated_at` 都刷新。

### 4.3 为什么不做子状态

常见的第二层细粒度状态（运行中 / 等待回答 / 待你验收 / 阻塞 / 待评审 等）全部由执行引擎或 AI 判定产出。本设计不含执行引擎，这一层没有任何值的产生者，因此**不建列、不展示**。

> 若将来需要"人工子标签"（例如"阻塞"），应作为新功能重新设计值域，而不是复用一套为引擎设计的枚举。

## 5. REST API 契约

### 5.1 通用约定

- 任务路由**必须挂在鉴权中间件之后**，未鉴权不可达。
- 响应体为裸对象/数组，不套 `{ data: ... }` 信封。
- 错误体统一：`{ success: false, error: { code: string, message: string } }`。
- 时间字段一律 ISO 8601 UTC 字符串（§3.2）。

### 5.2 端点

| 方法 + 路径 | 请求 | 成功响应 | 错误 |
|---|---|---|---|
| `GET /api/tasks` | query `projectPath?`、`status?` | `200` + `Task[]`，`ORDER BY position ASC, created_at ASC` | — |
| `POST /api/tasks` | 见 §5.3 | `201` + `Task` | §5.4 |
| `GET /api/tasks/:taskId` | — | `200` + `Task`（含上下文全文） | `TASK_NOT_FOUND` 404 |
| `PATCH /api/tasks/:taskId` | `{ status }` **或** 字段集，**不可同时** | `200` + `Task` | §5.4 |
| `DELETE /api/tasks/:taskId` | — | `200` + `{ success: true }`，**幂等**：不存在也返回 200 | — |
| `POST /api/tasks/batch-delete` | `{ taskIds: string[] }`，1–500 个非空字符串 | `200` + `{ success: true, deleted: number }` | `INVALID_REQUEST` 400 |

`PATCH` 的字段白名单：`title`、`description`、`projectPath`、`priority`、`deadline`、`label`、`remark`。改 `status` 与改字段**不能出现在同一请求**。

**路由注册顺序（易错）**：字面量路径必须优先于通配路径匹配，例如 `GET /api/tasks/:taskId` 不能挡住任何字面量路径。多数框架按字面量优先匹配，但**必须实测确认** `batch-delete` 这类路径能命中。

### 5.3 `POST /api/tasks` 请求体

```jsonc
{
  "projectPath": "/abs/path",        // 必填
  "title": "修复登录超时",            // 必填（前端留空时会先本地提炼，见 §7.3.1）
  "description": "……",               // 任务提示词
  "status": "todo",                  // 可选，默认 todo；禁止 archived
  "priority": "P2",                  // 可选，默认 P2
  "deadline": "2026-09-30",          // 可选，null 或合法 YYYY-MM-DD
  "label": "bug",                    // 可选，默认 other
  "remark": "来自周会",               // 可选
  "contextSourceSessionId": "s-123", // 可选
  "contextMode": "summary"           // 可选，'none' | 'summary' | 'raw'，默认 none
}
```

**校验规则**：

- `status === 'archived'` → `INVALID_STATUS` 400
- `priority` 不在枚举 → `INVALID_PRIORITY` 400
- `label` 不在枚举 → `INVALID_LABEL` 400
- `deadline` 非法 → `INVALID_DEADLINE` 400。判定：正则 `^\d{4}-\d{2}-\d{2}$` **且**该日历日真实存在（用 `new Date('<value>T00:00:00Z')` round-trip 比对）。必须拒绝 `2026-02-30`
- `projectPath` 不存在 → `PROJECT_NOT_FOUND` 404
- `contextMode !== 'none'` 时：`contextSourceSessionId` 必填且存在 → 否则 `SESSION_NOT_FOUND` 404；该会话必须归属此 `projectPath` → 否则 `SESSION_PROJECT_MISMATCH` 409
- `contextMode === 'none'` 时：忽略 `contextSourceSessionId`，5 个 `context_*` 列全部 NULL

### 5.4 错误码

| code | HTTP | 触发场景 |
|---|---|---|
| `TASK_NOT_FOUND` | 404 | 任务不存在 |
| `PROJECT_NOT_FOUND` | 404 | `projectPath` 不存在 |
| `SESSION_NOT_FOUND` | 404 | 上下文来源会话不存在 |
| `SESSION_PROJECT_MISMATCH` | 409 | 来源会话不属于所选项目 |
| `INVALID_STATUS` | 400 | 状态值非法；以 `archived` 创建；对归档任务做非法流转 |
| `INVALID_PRIORITY` | 400 | 优先级非法 |
| `INVALID_LABEL` | 400 | Label 非法 |
| `INVALID_DEADLINE` | 400 | 截止日期格式或日历日非法 |
| `INVALID_REQUEST` | 400 | 同一请求既改 `status` 又改字段；`taskIds` 为空 / 超过 500 / 含非字符串 |
| `INTERNAL_ERROR` | 500 | 兜底 |

### 5.5 响应对象 `Task`

```ts
type Task = {
  task_id: string;
  project_path: string;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'archived';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  deadline: string | null;        // YYYY-MM-DD
  label: 'bug' | 'feature' | 'optimization' | 'refactor' | 'docs' | 'other' | 'reminder';
  remark: string | null;
  position: number;
  started_at: string | null;      // ISO 8601 UTC
  completed_at: string | null;    // ISO 8601 UTC
  created_at: string;             // ISO 8601 UTC
  updated_at: string;             // ISO 8601 UTC
  context_source_session_id: string | null;
  context_mode: 'none' | 'summary' | 'raw';
  context_status: 'pending' | 'ready' | 'failed' | null;
  context_summary: string | null;
  context_raw: string | null;
};
```

**大字段传输规则**：`context_summary` 与 `context_raw` 体积可能很大（摘要 KB 级，原文可达十万字符），全量返回会使列表响应膨胀。

- `GET /api/tasks` 返回的每一项，`context_summary` 与 `context_raw` **恒为 `null`**（其余字段照常）
- `GET /api/tasks/:taskId` 返回**完整值**
- 前端需要展示摘要/原文全文时，按需单拉详情接口（§7.2）

## 6. 上下文来源与压缩模式

### 6.1 三种模式

| `context_mode` | 表单呈现 | 语义 | 产物列 |
|---|---|---|---|
| `none` | 来源选「（无）白纸开始」 | **不压缩**：不带任何上下文 | 全 NULL |
| `summary` | 选了会话 + 方式「摘要」（默认） | **摘要**：压缩成固定模板摘要 | `context_summary` |
| `raw` | 选了会话 + 方式「原文」 | **原文**：不压缩，直接用来源会话完整转录 | `context_raw` |

**UI 形态**：两个控件，不是单个三选下拉 ——

1. 「上下文来源」select：`（无）白纸开始` + 会话列表（数据来源见 §7.3.2）
2. 「压缩方式」select：`摘要` / `原文`，**仅当来源不是「（无）」时出现**，默认 `摘要`

单下拉无法表达「会话 × 压缩方式」的二维组合，且两控件不会出现"选了摘要但没选来源"的非法态。

### 6.2 建任务流程

```
POST /api/tasks { contextSourceSessionId, contextMode }
   │
   ├─ 校验（§5.3）
   ├─ 同步写行：context_mode / context_source_session_id / context_status='pending'
   ├─ 立即返回 201（不等待压缩）
   │
   └─ 后台异步任务：
        raw     → 读来源转录 → 截断至 MAX_RAW_CHARS → 写 context_raw,  status='ready'
        summary → 读来源转录 → 精简 → 截断至 60000 字符 → LLM 压缩 → 写 context_summary, status='ready'
        任一步失败 → status='failed'，记日志；任务本身照常存在，状态与其余字段不受影响
```

**必须异步**：压缩要读转录并调用 LLM，耗时秒级到分钟级，同步会阻塞「创建」操作。

### 6.3 转录读取契约

实现方提供一个读取接口，签名等价于：

```
fetchHistory(sessionId, { limit, offset }) → { messages: Message[] }
```

`summary` 与 `raw` 都取**最近 `200` 条**消息（`limit=200, offset=0`）。

### 6.4 `summary` 模式

**输入预处理**（两种模式共用）：

- 逐行拼接为文本：普通消息 → `[role] <text>`；本地命令 → `[role] /<commandName>`；工具结果 → `[tool <toolName>] <结果前 300 字符>`
- user 与 assistant 的文本各自截断到 `1200` 字符
- 无任何内容时用 `(empty transcript)`

**LLM 调用**：

- System prompt（逐字）：
  > 你是任务上下文压缩助手。你只负责把给定的会话转录压缩为固定模板的中文上下文摘要，供新任务开始执行前注入使用。只输出摘要正文，不要任何解释、前后缀、代码块包裹标记。若某个板块无信息，写"（无）"。
- User prompt（逐字，`<title>` 与 `<transcript>` 为占位）：
  > 任务：`<title>`
  >
  > 以下是来源会话转录（已精简，可能截断）：
  >
  > `<transcript>`
  >
  > 请按以下固定模板输出任务的新开始上下文：
  > `## 项目背景 / 决策`
  > `## 前序任务交接`
  > `## 环境详情`
  > `## 注意事项 / 约束`
- 聚合文本截断至 `60_000` 字符后再送入
- 超时 `120_000` ms，超时即判失败
- 模型：配置里指定的一个固定模型

**四个板块的含义**（供 prompt 调优）：项目背景/决策 = 代码结构、技术栈、约定、方案取舍理由；前序任务交接 = 上一任务的产物、结论、待办；环境详情 = 端口、凭据位置、主机等环境事实；注意事项/约束 = 其他跨项目常识。

### 6.5 `raw` 模式

- 转录来源与预处理器与 `summary` 完全相同，但**不调用 LLM**
- 仍做精简转换（`[role] <text>` 拼接 + 逐条截断），不能把原始结构化日志直接塞进一列
- **上限 `MAX_RAW_CHARS = 200_000`**，超出则在尾部追加 `…（已截断）`
- 失败同样置 `context_status='failed'`

**约束**：200k 字符约等于 50k–100k tokens。若将来会在任务执行时把 `context_raw` 全量注入 prompt，需确认不超模型上下文窗口；若会超，应按目标模型窗口反推调小 `MAX_RAW_CHARS`（建议留 50% 余量给任务本身）。本设计只做字符数截断。

### 6.6 幂等与完成通知

**幂等**：按 `taskId` 维护一个内存 in-flight 集合，同一任务的并发触发只执行一次，结束后从集合移除。**持久化"已处理"标记不做** —— 失败后重新触发是唯一的补救手段。

**完成通知**：

- 首选：项目已有的推送通道（WebSocket / SSE）推送任务更新事件
- 无推送通道时用**轮询兜底**：创建带来源的任务后，前端在 **5s / 15s / 30s** 各重新拉一次列表；一旦该任务 `context_status` 变为 `ready` 或 `failed` 即停止轮询

### 6.7 消费侧

本文只负责**产出入库**。`context_summary` / `context_raw` 由谁消费、如何消费不在范围内。

若将来接入消费：`summary` 适合作为任务首条消息的前缀注入；`raw` 建议作为独立上下文块或附件传递，不要直接拼进消息正文（体积与可读性都不可控）。

## 7. 前端规格

### 7.1 表格视图

**列定义**（左起），9 列 + 可选勾选列：

| # | 列 | 可排序 | 内容 |
|---|---|---|---|
| 1 | 标题 | ✅ | 主行 `title`（粗体）；副行 = Label 徽章 |
| 2 | 项目 | ✅ | `todo` 状态显示为内联 select（可改项目）；其余状态显示文本 |
| 3 | 状态 | ✅ | 色点 + 状态名 |
| 4 | 优先级 | ✅ | 带底色的 pill，文案 `P0 紧急` / `P1 高` / `P2 中` / `P3 低` |
| 5 | 上下文 | ❌ | 见 §7.2 |
| 6 | 截止日期 | ✅ | `YYYY-MM-DD`；逾期时红色加粗 |
| 7 | 创建时间 | ✅ | `YYYY-MM-DD HH:mm`（本地时区） |
| 8 | 最近活动 | ✅ | `updated_at`，格式同上 |
| 9 | 操作 | ❌ | 右对齐，见 §7.4 |

**排序交互**：点击可排序表头即排序；再点同列切换升/降序（表头显示 `↑` / `↓`）；切到新列时，`创建时间` / `最近活动` 默认降序，其余默认升序。

**排序实现要求**：

- **不得修改入参数组**（先拷贝再排）
- 等值时回退：先按 `created_at` 降序，再按 `task_id` 字典序 —— 保证结果稳定可测
- `标题` / `项目` 用 `localeCompare`（中文按拼音、大小写符合直觉），其余按值比较
- `状态` / `优先级` 按**枚举声明顺序**比大小，不是字母序

**分组**：数据按 `status` 分组渲染，**只渲染非空分组**，每组前有组标题行（色点 + 状态名 + 计数 pill + 一条水平分隔线）。

**空态**：整个列表为空 → 居中「暂无任务」；有数据但当前筛选无可见行 → 表格内一行 colspan 的「暂无任务」。

**状态筛选 pills**（表格内顶部，固定不随横向滚动）：

- `全部` pill + 每个状态一个 pill（色点 + 名称 + 计数）
- **归档状态仅在「显示归档」打开时出现**，否则会显示一个恒为 0 的「已归档」pill，是误导

**视觉要点**：表格容器为圆角卡片 + 阴影；用行间距（而非边框线）分隔行 —— 若用 `<table>`，可用 `border-separate` + `border-spacing: 0 7px`；每行单元格同底色 + 微阴影，首格左边框为 `3px solid <状态色>`，首/末格圆角；表格设最小宽度（约 1080px）以触发横向滚动。

### 7.2 「上下文」列

Badge 内容由 `context_mode` + `context_status` 决定：

| `context_mode` | `context_status` | 展示 | 色 |
|---|---|---|---|
| `none` | NULL | `—` | 灰 |
| `summary` | `pending` | `摘要·生成中…` | 蓝 |
| `summary` | `ready` | `摘要` | 绿 |
| `summary` | `failed` | `摘要·失败` | 红 |
| `raw` | `pending` | `原文·读取中…` | 蓝 |
| `raw` | `ready` | `原文` | 绿 |
| `raw` | `failed` | `原文·失败` | 红 |

**交互**：`ready` 且产物非空时，badge 可点/hover 查看全文（摘要几百字可直接 tooltip；原文几万字应开对话框）。因 §5.5 规定列表接口的大字段恒为 `null`，此处必须按需单拉 `GET /api/tasks/:taskId`。

**兜底**：`context_mode !== 'none'` 但 `context_status` 为 NULL（旧数据或异常写入）→ 按 `—` 渲染，不得报错。

### 7.3 新建任务对话框

**控件顺序（自上而下）**：

| 字段 | 控件 | 必填 | 默认 | 备注 |
|---|---|---|---|---|
| 任务提示词 | textarea，`autoFocus`，`rows=2`，可纵向拉伸，placeholder「发给 agent 执行的内容」 | ✅ | 空 | 提交时 `trim()` |
| 名称 | 单行输入，placeholder「可选，留空自动提炼」 | ❌ | 空 | 留空走 §7.3.1 |
| 项目 | select | ✅ | 列表第一项 | 切换时**清空上下文来源** |
| 上下文来源 | select | ❌ | `（无）白纸开始` | §6.1 |
| 压缩方式 | select：`摘要` / `原文` | ❌ | `摘要` | **仅来源非「（无）」时渲染** |
| 优先级 | select | ❌ | `P2` | |
| 截止日期 | `input[type=date]` | ❌ | 空 | |
| Label | select | ❌ | `other` | |
| 备注 | 单行输入，placeholder「需求来源等，可选」 | ❌ | 空 | |

**提交行为**：「创建」按钮在提示词为空时 disabled。成功后关闭对话框、清空表单、刷新列表。**若新建的任务被当前筛选排除，必须显示提示条**（文案：任务「X」已创建，但当前筛选未包含它）+「清除筛选」按钮 + 关闭按钮 —— 否则用户会以为没建上。

**取消 / 关闭**：重置表单。

#### 7.3.1 名称提炼规则

提示词填写但名称留空时，**本地提炼，不调模型**：

1. 取提示词按换行切分后的**第一个非空行**，两端去空白
2. 行内连续空白折叠为单个空格
3. 按**字素**（grapheme，不是 UTF-16 code unit）计数，超过 `50` 则截断到 50、去掉尾部空白后追加 `…`

用字素计数是为了正确处理 emoji 与组合字符。

#### 7.3.2 上下文来源的候选列表

「上下文来源」下拉的候选是该**所选项目**下的会话列表，按最近活动时间降序，每项显示会话标题（标题为空时回退到 id 的前 8 位）。

候选数据由实现方提供的接口给出，契约等价于每项含 `{ id, title, updatedAt }`。

### 7.4 行内操作（「操作」列）

| 条件 | 按钮 | 行为 |
|---|---|---|
| `status === 'in_review'` | `✓ 标记完成` | `PATCH { status: 'done' }` |
| `status === 'done'` | `🗄 归档` | `PATCH { status: 'archived' }` |
| `status === 'archived'` | `↩ 取消归档` | `PATCH { status: 'done' }` |

- 按钮区需阻止点击事件冒泡，避免触发整行的"打开任务"
- **整行点击** → 打开任务详情；暂无详情页时可先留空（不做无意义跳转）
- **项目列内联改项目**：仅 `todo` 状态可改，改前需**二次确认**（文案示例：「修改后该任务将归属新项目，此操作不可恢复。是否继续？」）

### 7.5 筛选栏

**两个维度（AND 关系）**：

1. **项目多选**：显示 `全部` / 单个项目名 / `N 个项目`。空数组 = 不过滤
2. **日期**：先选字段（`创建时间` / `截止时间` / `最近活动`），再选范围
   - 快捷项：`今天` / `本周` / `本月` / `今年` / `全部`（默认）
   - 自定义 `从 ~ 至` **优先级高于**快捷项；只设一侧时另一侧无界
   - 边界：`from` = 当天 `00:00:00.000`，`to` = 当天 `23:59:59.999`（本地时区）
   - 「本周」按**周一起算**（周日视为上一周的最后一天）
   - 「截止时间」字段按该天 `23:59:59.999` 计算
   - 该字段缺失或无法解析的任务 → **被过滤掉**（不是保留）
3. **显示归档**开关：关闭（默认）时 `archived` 任务一律不出现

**移动端**（窄屏）：折叠成一行「筛选」按钮 + 一句话摘要（如 `项目：全部 · 日期：今天`），展开后显示全部控件；有筛选生效时按钮旁显示一个小圆点。桌面端始终展开。

**持久化**：筛选状态存本地存储。**必须做归一化函数**：把存储里的脏数据（未知枚举值、缺字段、旧版本形状）兜底为默认值，不得因本地存储被手改而崩溃。

**时间边界刷新**：用每分钟刷新一次的 `now` 重算"今天/本周"的边界，避免页面跨午夜后边界停留在旧值。

### 7.6 模块划分

| 模块 | 职责 |
|---|---|
| `TaskTableView` | 表格渲染、排序、状态 pills 筛选、分组、行内操作、批量勾选 |
| `taskTable` | 排序纯函数（`sortTasks`） |
| `taskStatus` | `STATUS_ORDER` / `STATUS_META` / `PRIORITY_ORDER` / `PRIORITY_META` / `LABEL_ORDER` / `LABEL_META` / `groupByStatus` / `toggleStatus` |
| `taskFilter` + `TaskFilterBar` | 筛选状态模型与归一化 + 筛选 UI |
| `ProjectMultiSelect` | 项目多选下拉 |
| `taskName` | `deriveTaskName`（§7.3.1） |
| `taskTimestamp` | `formatAbsoluteTime` / `formatRelativeTime` / 按状态取时间标签 |
| `taskDeadline` | 截止日期信息（剩余天数 / 逾期判定） |
| `CreateTaskDialog` | 新建任务对话框（§7.3） |
| `ContextBadge` | 上下文徽章（§7.2） |
| `useTasks` | 列表加载 + 本地 upsert / remove + （可选）推送订阅 |
| API client | `list` / `create` / `get` / `update` / `remove` / `removeMany` |

### 7.7 批量删除

- 表格首列勾选框（可启用/停用）+ 表头全选
- 选中数 > 0 时，列表顶部出现操作条：`已选 N 项` / `取消选择` / `删除`（红色）
- 点「删除」先二次确认（文案示例：「确定删除选中的 N 个任务？此操作不可恢复。」）
- 删除中按钮显示 `删除中…` 并 disabled
- 成功后就地移除行并清空选择；**失败不得从 UI 移除行**（会与后端不一致）

## 8. 错误处理

所有失败路径都必须给用户**可见反馈**，不允许只写控制台。

| 场景 | 处理 |
|---|---|
| 列表加载失败 | 显示「加载任务失败」+「重试」按钮 |
| 创建失败 | 展示后端 `error.message`；**保留表单内容不清空** |
| 改状态 / 改项目失败 | 展示错误；从服务端重新拉取列表，消除本地乐观状态 |
| 删除失败 | 展示错误；不移除本地行 |
| 上下文压缩失败 | `context_status='failed'`，表格显示「·失败」；**不阻断任务创建、不影响任务状态** |
| 来源会话不存在 / 不匹配 | 创建请求返回 404 / 409，表单内提示，让用户重选 |
| 来源转录读取失败 | 同压缩失败，置 `failed` 并记日志 |

## 9. 测试清单

### 9.1 后端

- 创建：默认值正确（`status=todo`、`priority=P2`、`label=other`、`position` = 组内最大值 +1）
- 创建：`status='archived'` 被拒（`INVALID_STATUS`）
- 创建：`deadline` 拒 `2026-02-30`、拒 `2026-9-1`；接受 `2026-09-30`、接受 `null`
- 创建：`priority` / `label` 越界被拒
- 创建：`projectPath` 不存在 → `PROJECT_NOT_FOUND`
- 上下文：`contextMode='none'` → 5 个 `context_*` 列全 NULL，且不触发任何压缩
- 上下文：`contextMode='summary'` + 有效来源 → 立即 201 且 `context_status='pending'`；后台完成后 `ready` 且 `context_summary` 非空
- 上下文：`contextMode='raw'` → 同上，产物落 `context_raw`，且**不调用 LLM**（用 stub 断言）
- 上下文：压缩抛错 → `context_status='failed'`，任务 `status` 与其余字段不变
- 上下文：`summary` 但来源不存在 → `SESSION_NOT_FOUND`；来源不属该项目 → `SESSION_PROJECT_MISMATCH`
- 上下文：`raw` 超 `MAX_RAW_CHARS` → 截断且尾部有 `…（已截断）`
- 上下文：同一 `taskId` 并发触发只执行一次
- 状态流转：`archived` 只能从 `done` 进、只能退回 `done`
- 时间戳：逐条覆盖 §4.2 五行规则，**特别是 `done ↔ archived` 互转不动 `completed_at`**
- 时间戳：同状态重复 `PATCH` 不写 `started_at` / `completed_at`
- `PATCH`：同请求既带 `status` 又带字段 → `INVALID_REQUEST`
- `PATCH`：改字段刷新 `updated_at`
- `DELETE`：不存在的 id 也返回 200
- `batch-delete`：1 个 / 500 个 / 501 个（拒）/ 空数组（拒）/ 含非字符串（拒）；`deleted` 等于实际删除数
- 列表接口：`context_summary` / `context_raw` 恒为 `null`；详情接口有完整值
- 时间归一化：存储层的 UTC 裸字符串出 API 后是带 `Z` 的 ISO

### 9.2 前端

- 排序：**不改入参**；等值回退稳定；状态/优先级按枚举序而非字母序
- 分组：pills 计数与分组一致；「显示归档」关闭时归档分组不渲染
- 上下文列：§7.2 表格中 7 种组合的文案与颜色
- 空态：整列表为空 vs 筛选后为空，两种文案
- 表单：来源选「（无）」→ 提交体**不含** `contextSourceSessionId`，`contextMode` 可省略（服务端默认 `none`）
- 表单：来源非空 + 「摘要」→ 提交体带 `contextMode: 'summary'`；「原文」→ `'raw'`
- 表单：切换项目 → 来源被清空、压缩方式控件消失
- 表单：提示词为空时「创建」disabled
- 表单：名称留空 → 走提炼规则（多行取首个非空行、超 50 字素截断加 `…`、emoji 计数正确）
- 表单：新建的任务被筛选排除 → 提示条出现；调整筛选使其可见 → 提示条消失
- 筛选：项目多选 + 日期 AND 语义；自定义范围优先于快捷项；只设一侧时另一侧无界；「本周」周一起算
- 筛选：本地存储里是脏数据（未知枚举值 / 缺字段 / 旧形状）→ 归一化后不崩
- 批量删除：确认框取消 → 不发请求；成功后选择集清空

### 9.3 手工验收

1. 不选上下文来源建任务 → 表格该行「上下文」列为 `—`
2. 选来源 + 「摘要」→ 表格先显示「摘要·生成中…」，数秒后变「摘要」
3. 选来源 + 「原文」→ 最终显示「原文」，产物是转录文本而非模板摘要
4. 让压缩服务必然抛错 → 表格显示「摘要·失败」，且该任务仍可正常改状态、改项目、删除
5. 关闭「显示归档」→ 归档任务消失；打开 → 重新出现
6. 窗口缩到窄屏 → 筛选栏折叠成一行，表格横向滚动

## 10. 关键决策记录

| 议题 | 决定 |
|---|---|
| 视图范围 | 只做表格视图 |
| 执行引擎 | 不含；执行入口单值写死在配置，不建列 |
| 子状态 | 整层不做（值的产生者不存在） |
| 状态层 | 单层 `status`，5 个值，全部人工流转 |
| 上下文三选一 | 不压缩（无上下文）/ 摘要 / 原文 |
| 三选一的 UI | 两个控件：来源下拉 + 压缩方式下拉（后者条件渲染） |
| 压缩产物列 | `context_summary` 与 `context_raw` 分列，不混存 |
| `context_status` | 单独建列，用于区分「生成中」与「失败」 |
| 压缩时机 | 创建后异步，不阻塞响应 |
| 压缩失败 | 不影响任务创建与状态，置 `context_status='failed'` |
| `raw` 上限 | `MAX_RAW_CHARS = 200_000`，超出截断 |
| 完成通知 | 优先推送；无推送通道时 5s/15s/30s 三轮询兜底 |
| 大字段传输 | 列表接口的 `context_summary` / `context_raw` 恒为 `null`；全文走详情接口 |
| 失败反馈 | 所有失败路径必须有用户可见反馈 |
