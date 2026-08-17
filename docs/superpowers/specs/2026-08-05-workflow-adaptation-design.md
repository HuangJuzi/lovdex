# Workflow 完整适配设计

- 日期:2026-08-05
- 范围:`lovdex-backend` + `lovdex-cli`
- 目标水位:C(完整)—— 实时进度卡片 + 三层进度树 + scriptPath 重跑/resume + 历史回放 + settings 开关
- 仅处理 `taskType === 'local_workflow'`;`remote_agent`(CCR)走 Default 渲染,本次不动。

---

## 1. 背景与现状

### 1.1 SDK 已原生支持 Workflow

`@anthropic-ai/claude-agent-sdk@0.3.210`:

- `sdk.d.ts:5241` `disableWorkflows?`、`5253` `enableWorkflows?`、`5259` `workflowKeywordTriggerEnabled?`
- `sdk-tools.d.ts:2498` `WorkflowInput` / `3504` `WorkflowOutput`(`taskId`/`taskType`/`workflowName`/`runId`/`scriptPath`/`transcriptDir`/`summary`)
- `sdk.d.ts:4332` `SDKTaskNotificationMessage`、`4350` `SDKTaskProgressMessage`、`4370` `SDKTaskStartedMessage`、`4393` `SDKTaskUpdatedMessage`、`2844` `SDKBackgroundTasksChangedMessage`、`4418` `SDKToolProgressMessage`
- `sdk.d.ts:3916` `SDKMessage` 联合已包含上述全部类型
- `sdk.d.ts:725` `GetSessionMessagesOptions.includeSystemMessages` 默认 false

### 1.2 后端现状(缺口)

- `server/claude-sdk.js:204` `sdkOptions.tools = { type:'preset', preset:'claude_code' }` → Workflow 默认在工具集里,**能跑**。
- `shared/types.ts:183` 声明了 `'task_notification'` kind,**但无任何 producer**。
- `claude-sessions.provider.ts:normalizeMessage()` 只处理 `content_block_delta/stop`、user-role、`thinking`、`tool_use`、`tool_result`、assistant-role;**不识别 `type:'system'` 与 `type:'tool_progress'`** → Workflow 实时进度被静默丢弃。
- `fetchHistory()` 调 `getSessionMessages()` 未传 `includeSystemMessages` → 历史 JSONL 里的 system/task_* 记录读不到。
- `claude-session-synchronizer.provider.ts:38-46` 已知子 agent transcript 路径(`<session>/subagents/agent-<id>.jsonl`),目前 `synchronize()` skip 它们(避免污染主 session 行)。
- `transformMessage()`(`claude-sdk.js:289`)只透传 `parent_tool_use_id`,不识别 `task_type`/`task_id`。

### 1.3 前端现状(缺口)

- `useChatMessages.ts:224` 有 `task_notification` 渲染分支(渲染成普通 assistant 文本气泡)→ 对 Workflow 是死代码(后端不发)。
- `toolConfigs.ts` **无 `Workflow` 条目** → `getToolConfig('Workflow')` 落到 `Default`(`toolConfigs.ts:528`,`getToolConfig` :555)→ 折叠 JSON 框。
- `Task` 工具(Agent 子代理)有 `SubagentContainer.tsx` + `toolConfigs.ts:379`,靠 `parentToolUseId`/`subagentTools` 聚合(`useChatRealtimeHandlers.ts:659` 附近注入)→ 可参考但 Workflow 父子链不同。
- `useChatSessionState.ts:73` / `useSessionStore.ts:31` 已登记 `task_notification`。

### 1.4 关键约束

- 根目录 `/mnt/b/workdir/github/lovdex` **非 git 仓库**;backend(`feat/resume-overlay`)与 cli(`main`)是两个独立 repo。
- `remote_agent`(CCR 远程派发)的 resume 句柄是 CCR session URL,本次不处理。

---

## 2. 架构:镜像 SDK 事件体系

### 2.1 新增 / 复用 kind

在 `shared/types.ts` 的 `MessageKind` 联合新增 4 个,复用已有的 `task_notification`:

| kind | SDK 源 | 性质 | 用途 |
|---|---|---|---|
| `task_started` | `system/task_started` | edge | Workflow 卡片创建,挂到 `tool_use_id` 对应的 Workflow 工具根 |
| `task_progress` | `system/task_progress` | edge | agent 级进度行(`description`/`usage`/`last_tool_name`) |
| `tool_progress` | `tool_progress`(非 system) | edge | 三层树叶节点(具体工具调用) |
| `background_tasks_changed` | `system/background_tasks_changed` | level(REPLACE) | 全量任务面板,独立于卡片 |
| `task_notification`(已有) | `system/task_notification` | edge | Workflow 终态(completed/failed/stopped)+ summary + usage |

**level vs edge**:`background_tasks_changed` 是 level 信号(REPLACE 语义:客户端用 payload 替换本地集合,不与 edge 配对);其余 4 个是 edge 信号。混用时按 SDK 注释(`sdk.d.ts:2844` 附近)约束:level 不与 edge 相关性关联。

### 2.2 三层树父子链

```
Workflow tool_use (toolId = TU_root)
  └─ task_started {task_id=T1, tool_use_id=TU_root, workflow_name}      ← 锁根
      └─ task_progress {task_id=T1, description, usage, last_tool_name} ← agent 节点
          └─ tool_progress {tool_use_id=TU_leaf, parent_tool_use_id=TU_agent, tool_name} ← 叶子
  └─ task_notification {task_id=T1, status, summary}                    ← 终态
```

- `task_started.tool_use_id` → 锁定 Workflow `tool_use` 根。
- `task_progress.task_id` 与 `task_started.task_id` 相同 → agent 节点。
- `tool_progress.parent_tool_use_id` 指向某 agent 的 `tool_use_id`;SDK 同时在 `tool_progress.task_id` 带 `task_id` → 后端用它桥接 agent 节点(避免前端反查 parent 链)。
- 前端按 `tool_use_id`(根)+ `task_id`(agent)+ `tool_use_id`(叶)三层聚合。

### 2.3 与现有 Task(Agent)工具的区别

Task 工具的父子链是 `parentToolUseId` + `subagentTools`(单层);Workflow 是 `task_id` + `tool_use_id` 双键三层。不复用 `SubagentContainer`,新建 `WorkflowContainer`。

---

## 3. 后端设计

### 3.1 SDK 选项与开关(`server/claude-sdk.js`)

- `buildSdkOptions` / `mapCliOptionsToSDK`:显式读 env 传入 `enableWorkflows` / `workflowKeywordTriggerEnabled`(见 §6)。`tools` preset 保持。
- `transformMessage()`(:289):新增对 `type === 'tool_progress'` 的透传(它非 `system`,当前会被原样 return,但 normalize 不识别 → 丢弃)。给它加一个标记字段(如 `isToolProgress: true` + 原 `tool_use_id`/`tool_name`/`parent_tool_use_id`/`task_id`/`elapsed_time_seconds`)供 normalize 识别。

### 3.2 normalize 适配器(`claude-sessions.provider.ts:normalizeMessage`)

在 `content_block_*` 分支之后、user-role 分支之前插入:

```ts
if (raw.type === 'system') {
  switch (raw.subtype) {
    case 'task_started':
      return [createNormalizedMessage({
        kind: 'task_started',
        taskId: raw.task_id,
        toolUseId: raw.tool_use_id ?? null,
        taskType: raw.task_type ?? null,        // 'local_workflow' | 其它
        workflowName: raw.workflow_name ?? null,
        subagentType: raw.subagent_type ?? null,
        description: raw.description ?? '',
        skipTranscript: raw.skip_transcript ?? false,
        sessionId, provider: PROVIDER, timestamp: ts, id: baseId,
      })];
    case 'task_progress':
      return [createNormalizedMessage({
        kind: 'task_progress',
        taskId: raw.task_id,
        toolUseId: raw.tool_use_id ?? null,
        description: raw.description ?? '',
        usage: raw.usage ?? null,
        lastToolName: raw.last_tool_name ?? null,
        summary: raw.summary ?? null,
        sessionId, provider: PROVIDER, timestamp: ts, id: baseId,
      })];
    case 'task_notification':
      return [createNormalizedMessage({
        kind: 'task_notification',
        taskId: raw.task_id,
        toolUseId: raw.tool_use_id ?? null,
        status: raw.status,                     // 'completed'|'failed'|'stopped'
        summary: raw.summary ?? '',
        usage: raw.usage ?? null,
        outputFile: raw.output_file ?? null,
        sessionId, provider: PROVIDER, timestamp: ts, id: baseId,
      })];
    case 'background_tasks_changed':
      return [createNormalizedMessage({
        kind: 'background_tasks_changed',
        tasks: (raw.tasks ?? []).map(t => ({ taskId: t.task_id, taskType: t.task_type, description: t.description })),
        sessionId, provider: PROVIDER, timestamp: ts, id: baseId,
      })];
    default:
      return [];   // thinking_tokens / commands_changed / 其它 system 暂不处理
  }
}

if (raw.type === 'tool_progress') {
  return [createNormalizedMessage({
    kind: 'tool_progress',
    toolUseId: raw.tool_use_id,
    toolName: raw.tool_name,
    parentToolUseId: raw.parent_tool_use_id ?? null,
    taskId: raw.task_id ?? null,
    elapsedTimeSeconds: raw.elapsed_time_seconds ?? 0,
    sessionId, provider: PROVIDER, timestamp: ts, id: baseId,
  })];
}
```

### 3.3 NormalizedMessage 扩字段(`shared/types.ts`)

在现有 `subagentTools?` / `toolUseResult?` 等基础上新增(全部 optional):

```ts
taskId?: string;
taskType?: 'local_workflow' | 'remote_agent' | string;
workflowName?: string;
subagentType?: string;
skipTranscript?: boolean;
lastToolName?: string;
elapsedTimeSeconds?: number;
outputFile?: string;
runId?: string;
scriptPath?: string;
transcriptDir?: string;
parentToolUseId?: string;   // 已在 claude-sdk.js 注入,这里正式入类型
tasks?: Array<{ taskId: string; taskType: string; description: string }>;  // level payload
```

### 3.4 WorkflowOutput 解析(`tool_result` 分支)

`claude-sessions.provider.ts:532`(`raw.type === 'tool_result'`)与 `:350`(user-content 内 `part.type === 'tool_result'`)两处:若 `raw.toolUseResult?.taskType === 'local_workflow'`(SDK `WorkflowOutput`),把 `runId/scriptPath/workflowName/taskId/transcriptDir/summary` 提到 msg 顶层字段。这样前端 Workflow 卡片能从 `tool_result` 拿到 `scriptPath`/`runId`。

### 3.5 历史回放(`fetchHistory`)

- `claude-sessions.provider.ts:592` 调用改为 `getSessionMessages(sessionId, providerSessionId, null, 0, { includeSystemMessages: true })`。注意 `getSessionMessages` 当前签名是 `(sessionId, providerSessionId?, limit?, offset?)`;需确认第 5 参数 `options` 是否被本地 wrapper 接受——若 wrapper 未透传,加一层。
- 现有 `toolResultMap`(:617)扩展为多 map 聚合:
  - `taskStartedByToolUseId: Map<toolUseId, task_started msg>`
  - `taskProgressByTaskId: Map<taskId, task_progress msg[]>`
  - `toolProgressByParentToolUseId: Map<parentToolUseId, tool_progress msg[]>`
  - `taskNotificationByTaskId: Map<taskId, task_notification msg>`
- 第二轮遍历 normalized 时,把 `kind === 'tool_use' && toolName === 'Workflow'` 的 msg 上挂 `workflowState` 字段(根 → agents[] → tools[])。`workflowState` 形状见 §4C。
- **子 agent transcript 索引(stretch goal)**:历史默认只到 agent 级(`task_progress` 已带 `last_tool_name`,够用)。若要补全叶子,按 §3.6 读取 `<session>/subagents/agent-<id>.jsonl`。**默认不做**,留作 v2。

### 3.6 子 agent transcript 索引(可选,默认关闭)

- 路径已知(`claude-session-synchronizer.provider.ts:38`):`<claudeHome>/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`。
- 不动 `synchronize()` 的 skip 逻辑(保持主 session 行不被污染)。仅在 `fetchHistory` 里,**当某 `task_started`/`task_progress` 的 `task_id` 关联到子 agent transcript 时**,按需读取该 transcript 文件,normalize 其中的 `tool_use`/`tool_progress` 作为叶子挂到 `workflowState`。
- 风险:子 agent transcript 的 `sessionId` 与父相同,需用 `task_id` 而非 `sessionId` 关联。
- **本设计默认不实现**,仅记录路径与关联键,留作后续迭代。

### 3.7 chat-run-registry

无需改:`claude-sdk.js:723` `for (const msg of normalized) ws.send(msg)` 已逐条转发,新 kind 自动透传到 WS。

### 3.8 后端只读 endpoint(§4E 编辑脚本用)

新增 `GET /api/sessions/:sessionId/workflow-script?path=<abs>`:

- 白名单:`path` 必须解析后落在该 session 的 `transcriptDir`(或 `<claudeHome>/projects/<encoded-cwd>/<session-id>/`)下;否则 403。
- 返回 `{ content: string, path: string }`。
- 路由文件:`server/routes/`(按现有 routes 目录结构新增),复用现有 auth middleware。
- 用途:前端「编辑脚本」按钮拉取 `scriptPath` 内容。

---

## 4. 前端设计

### 4.1 `toolConfigs.ts` 新增 `Workflow` 条目

```ts
Workflow: {
  input: {
    type: 'collapsible',
    title: (input) => {
      const name = input?.name || input?.scriptPath?.split('/').pop() || 'workflow';
      return `Workflow · ${name}`;
    },
    defaultOpen: true,
    contentType: 'workflow',            // 新增 contentType 值
    getContentProps: (input) => ({
      script: input?.script,
      scriptPath: input?.scriptPath,
      name: input?.name,
      resumeFromRunId: input?.resumeFromRunId,
      args: input?.args,
      workflowState: undefined,         // 由 useWorkflowState 注入
    }),
  },
  result: {
    type: 'collapsible',
    contentType: 'workflow',
    getContentProps: (result) => {
      const r = result?.toolUseResult || result;
      return {
        scriptPath: r?.scriptPath,
        runId: r?.runId,
        workflowName: r?.workflowName,
        taskId: r?.taskId,
        summary: r?.summary,
        workflowState: undefined,
      };
    },
  },
},
```

`ToolDisplayConfig.input.contentType` 类型联合新增 `'workflow'`。

### 4.2 新组件 `WorkflowContainer.tsx`

位置:`src/components/chat/tools/components/WorkflowContainer.tsx`。仿 `SubagentContainer.tsx` 结构。

Props:
```ts
interface WorkflowContainerProps {
  toolInput: any;
  toolResult?: any;
  workflowState?: WorkflowState;   // 见 §4C;实时注入,历史也注入
}
```

渲染区块:
1. **标题行**:`Workflow · {workflowName || 'untitled'}` + `ToolStatusBadge`(running/completed/failed/stopped)。
2. **三层进度树**:
   - 根:`Workflow`
   - agent 节点(来自 `workflowState.agents[]`):显示 `subagentType || taskType` + `description` + usage tokens(`usage.total_tokens`)+ `lastToolName`(若有)。
   - 叶子(来自 `agent.tools[]`):`toolName` + `elapsedTimeSeconds`s + chevron 展开看 `tool_use` 详情(复用 `ToolRenderer`?)。
3. **终态行**(来自 `workflowState.notification`):`status` + `summary` + usage(`duration_ms`/`tool_uses`/`total_tokens`)。
4. **按钮区**(终态或 `async_launched` 时显示):
   - `[编辑脚本]` → 调 `GET /api/sessions/:id/workflow-script?path=scriptPath`,把内容塞进编辑器(可复用 `ToolDiffViewer` 同款 code 面或新弹窗)。
   - `[以 scriptPath 重跑]` → `sendMessage`(自然语言:"用 scriptPath `<path>` 重跑这个 workflow"),Claude 触发 `Workflow({scriptPath})`。
   - `[resume 续跑]` → `sendMessage`("用 scriptPath `<path>` + resumeFromRunId `<runId>` 续跑"),Claude 触发 `Workflow({scriptPath, resumeFromRunId})`。
   - 三个按钮在 `scriptPath`/`runId` 缺失时各自禁用并带 tooltip 说明原因。

### 4.3 `WorkflowState` 数据结构

```ts
interface WorkflowAgentNode {
  taskId: string;
  subagentType?: string;
  taskType?: string;
  description: string;
  lastToolName?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  tools: Array<{              // 叶子,来自 tool_progress
    toolUseId: string;
    toolName: string;
    elapsedTimeSeconds: number;
  }>;
}

interface WorkflowState {
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'async_launched';
  workflowName?: string;
  agents: WorkflowAgentNode[];   // 来自 task_progress,按 taskId 去重合并
  notification?: {               // 来自 task_notification
    status: 'completed' | 'failed' | 'stopped';
    summary: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  };
}
```

### 4.4 实时聚合 hook `useWorkflowState.ts`

位置:`src/components/chat/hooks/useWorkflowState.ts`(或并入 `useChatRealtimeHandlers.ts`)。

职责:维护 `Map<toolUseId, WorkflowState>`(以 `task_started.tool_use_id` 为根键)。每收一条 edge 事件:
- `task_started`:建根条目,status=`running`,`workflowName` 取 `workflow_name`。
- `task_progress`:按 `task_id` 找到(或新建)agent 节点,合并进 `agents[]`(同 `task_id` 多次到达则更新 `description`/`usage`/`lastToolName`)。
- `tool_progress`:按 `task_id` 找到 agent 节点,push 到 `agent.tools[]`(同 `tool_use_id` 重复到达则更新 `elapsedTimeSeconds`)。
- `task_notification`:置根条目 `notification` + `status`。

聚合结果注入方式:**`useWorkflowState` 暴露一个 `getWorkflowState(toolUseId)` 查询函数**;`ToolRenderer` 在渲染 `Workflow` 工具时调用它(经 props 或 context 传入),把结果作为 `workflowState` prop 传给 `WorkflowContainer`。不在 store 里给每条 tool_use msg 挂字段(避免重复渲染时 stale)。`background_tasks_changed` 单独存到 session store(`useSessionStore`),供(可选)任务面板用;本次不做面板 UI,仅存数据。

### 4.5 `ToolRenderer.tsx` 路由

- `getToolCategory`(:42)加 `if (toolName === 'Workflow') return 'workflow'`。
- `CollapsibleDisplay` 的 `colorScheme`/border 可在 `CollapsibleDisplay.tsx:25` 附近加 `workflow: 'border-l-blue-500 ...'`(选个区别于 task/agent 的色)。
- `displayConfig.type === 'collapsible'` 的 switch 里加 `case 'workflow'` → `<WorkflowContainer {...contentProps} workflowState={workflowStateByToolId?.(toolId)} />`。

### 4.6 `useChatMessages.ts` 调整

- `task_notification` 分支(:224)目前渲染成 assistant 文本气泡。改为:**若该 `task_notification` 的 `toolUseId` 能匹配到一个 Workflow tool_use**(说明是 Workflow 终态),则**不单独渲染气泡**,仅作为状态注入(由 `useWorkflowState` 处理);**否则**保持现有行为(非 Workflow 的后台任务,如普通 background bash)。
- 新增 `task_started`/`task_progress`/`tool_progress`/`background_tasks_changed` 分支:**不渲染为独立消息**,全部走 `useWorkflowState` 聚合(它们是 Workflow 卡片的子事件,不是对话消息)。

---

## 5. settings / env 开关(§6 承诺)

### 5.1 `.env.example` / `.env`(backend)

新增(默认值见 §6 决策):
```
WORKFLOWS_ENABLED=true
ULTRACODE_KEYWORD_TRIGGER=true
```

不暴露 `disableWorkflows`(与 `enableWorkflows` 互斥,冗余)。

### 5.2 `mapCliOptionsToSDK`(`claude-sdk.js`)

读取并传入:
```js
if (process.env.WORKFLOWS_ENABLED !== undefined) {
  sdkOptions.enableWorkflows = process.env.WORKFLOWS_ENABLED !== 'false';
}
if (process.env.ULTRACODE_KEYWORD_TRIGGER !== undefined) {
  sdkOptions.workflowKeywordTriggerEnabled = process.env.ULTRACODE_KEYWORD_TRIGGER !== 'false';
}
```

---

## 6. 决策记录(来自 brainstorming)

| 决策点 | 选择 | 理由 |
|---|---|---|
| 目标水位 | C(完整) | 实时卡片 + 三层树 + 重跑/resume + 历史回放 + 开关 |
| 重跑/resume | 卡片内置编辑+重跑 | 一键 `sendMessage` 触发 `Workflow({scriptPath})`;编辑需后端只读 endpoint |
| 进度树事件源 | task_* + tool_progress 凑三层 | 信息量最大;后端转发 tool_progress 并做 parent 链 |
| remote_agent | 仅 local_workflow | 避免触达 CCR/远程会话 URL |
| settings 开关 | 暴露 | 便于运维关闭特性 |
| 历史回放 | 历史也重建 | `includeSystemMessages=true` + normalize system 分支 + workflowState 挂载 |
| 架构 | A 镜像 | 新增 4 kind 复用 task_notification;保留 level/edge 区分;最正确 |
| 子 agent transcript 索引 | stretch goal(默认不做) | 历史只到 agent 级;留 v2 |
| 编辑脚本后端 API | 加最小只读 endpoint | 白名单到 session transcript 目录 |
| 开关默认值 | 均 true | 与 SDK 默认一致,零配置可用 |

---

## 7. 测试

### 7.1 后端 unit(`server/modules/providers/list/claude/tests/`)

新增 `workflow-normalize.test.ts`,用从 `sdk.d.ts` 形状构造的真实样例覆盖:
- `task_started`(local_workflow)→ `kind:'task_started'` + 字段映射
- `task_progress` → `kind:'task_progress'` + usage
- `task_notification`(completed/failed/stopped)→ `kind:'task_notification'`
- `background_tasks_changed` → `kind:'background_tasks_changed'` + tasks 数组
- `tool_progress` → `kind:'tool_progress'` + parent 链
- `tool_result` with `toolUseResult.taskType='local_workflow'` → `runId`/`scriptPath` 提顶
- 非 local_workflow(remote_agent)tool_result → 不提顶(走 Default)

### 7.2 后端 history(`server/modules/providers/list/claude/tests/`)

`workflow-history.test.ts`:fixture JSONL 含 system/task_* + Workflow tool_use/tool_result,断言 `fetchHistory` 返回的 Workflow msg 上 `workflowState` 子树结构正确(根 → 1 agent → 2 叶)。

### 7.3 前端 unit(`src/components/chat/tools/components/`)

- `WorkflowContainer.test.tsx`:渲染三层树 + 终态 + 三按钮(缺 scriptPath/runId 时禁用)。
- `useWorkflowState.test.ts`:多事件序列(task_started → 2× task_progress → tool_progress ×2 → task_notification)→ 正确 `WorkflowState`。

### 7.4 手动 e2e

起 backend + cli,在 cli 里发"用 workflow 跑一个 review"(prompt 含 `ultracode` 或显式要求),观察:
- 实时:Workflow 卡片出现 → agent 节点逐个出现 → 叶子工具出现 → 终态。
- 历史:切到别的会话再切回,卡片 + 子树仍在。
- 重跑:点「以 scriptPath 重跑」→ 新 Workflow 卡片。
- resume:点「resume 续跑」→ 新 Workflow 卡片(命中缓存)。

---

## 8. 不在本次范围(YAGNI)

- `remote_agent`(CCR)卡片化 + CCR session URL 入口。
- `background_tasks_changed` 的全量任务面板 UI(仅存数据)。
- 子 agent transcript 历史叶子级补全(stretch goal)。
- `disableWorkflows` 开关(与 `enableWorkflows` 互斥,冗余)。
- `task_updated`/`task_progress` 之外 system 子类型(thinking_tokens/commands_changed 等)的处理。

---

## 9. 改动文件清单(预估)

### 后端 `lovdex-backend`
- `server/shared/types.ts` — MessageKind 新增 4 kind + NormalizedMessage 扩字段
- `server/claude-sdk.js` — `transformMessage` tool_progress 标记 + `mapCliOptionsToSDK` env 开关
- `server/modules/providers/list/claude/claude-sessions.provider.ts` — normalize system/tool_progress 分支 + WorkflowOutput 提顶 + `fetchHistory` includeSystemMessages + workflowState 聚合
- `server/routes/`(新增 workflow-script 路由文件)+ 路由注册
- `.env` / `.env.example` — 两个新开关
- `server/modules/providers/list/claude/tests/workflow-normalize.test.ts`(新增)
- `server/modules/providers/list/claude/tests/workflow-history.test.ts`(新增)

### 前端 `lovdex-cli`
- `src/components/chat/tools/configs/toolConfigs.ts` — `Workflow` 条目 + contentType `'workflow'`
- `src/components/chat/tools/components/WorkflowContainer.tsx`(新增)
- `src/components/chat/tools/components/index.ts` — 导出
- `src/components/chat/tools/ToolRenderer.tsx` — `getToolCategory` + switch case
- `src/components/chat/tools/components/CollapsibleDisplay.tsx` — workflow colorScheme
- `src/components/chat/hooks/useWorkflowState.ts`(新增)
- `src/components/chat/hooks/useChatRealtimeHandlers.ts` — 接入 useWorkflowState
- `src/components/chat/hooks/useChatMessages.ts` — task_notification 路由调整 + 新 kind 不渲染独立气泡
- `src/stores/useSessionStore.ts` — background_tasks_changed 存储
- `src/components/chat/tools/components/WorkflowContainer.test.tsx`(新增)
- `src/components/chat/hooks/useWorkflowState.test.ts`(新增)

---

## 10. 风险与待确认

1. **`getSessionMessages` options 透传**:`claude-sessions.provider.ts:592` 现调用是位置参数,需确认本地 wrapper(经 `sessions.service.ts` / `session-synchronizer.service.ts`)是否接受并透传 `includeSystemMessages`。若不透传,加一层 wrapper。→ 实现阶段先验证。
2. **`tool_progress` 与 agent 的关联**:SDK 注释未明确 `tool_progress.parent_tool_use_id` 是否一定等于某 agent 的 `tool_use_id`(而非 Workflow 根的 `tool_use_id`)。若 SDK 把 `parent_tool_use_id` 指向 Workflow 根而非 agent,三层树退化为二层(Workflow → tools[])。→ 实现阶段用真实运行样本验证父子键;若退化,`WorkflowAgentNode` 仍可作为占位(单 agent = workflow 根本身)。
3. **`task_started.tool_use_id` 缺失**:SDK 标 `tool_use_id?` optional。若缺失,Workflow 卡片无法挂到 tool_use 根 → fallback:用 `task_id` 作根键,前端 `useWorkflowState` 也支持以 `taskId` 为根(当 `toolUseId` 缺失)。→ §4C 已留 `taskId` 字段。
4. **编辑器组件复用**:`ToolDiffViewer` 是 diff 面板,不适合纯文本编辑。→ 实现阶段决定:复用现有 code 面做只读+复制,或新做一个轻量 textarea 弹窗。倾向后者(MVP)。
5. **根目录非 git 仓库**:本 spec 文件位于 workspace `docs/`,不在任何 repo 内,无法 `git commit`。→ 仅写文件,不提交;后续 plan/实现按子 repo 各自提交。
