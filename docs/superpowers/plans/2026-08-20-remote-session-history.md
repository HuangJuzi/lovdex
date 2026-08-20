# Remote 会话历史消息读取（claude + qoder）实现计划

> 2026-08-20 · 背景：`docs/superpowers/plans/2026-08-18-remote-projects.md` 里 `session/messages` 是 Phase 1 已知取舍（先回空数组、转历史留 Phase 2 补），线上 7 个远程 session 全部 `jsonl_path=null`，打开会话历史空白。本计划补上 claude + qoder 两条后端。
>
> 范围裁定（用户确认）：**claude + qoder**（纯 JSONL）；codex/opencode 因落盘方式特殊（codex 走同步器索引、opencode 是 sqlite 库）后续单独处理。

## 设计与现状差异

- 现状：`fetchHistory`（claude/qoder）只 `fs` 读**本地** `~/.claude|.qoder/projects/<encode(projectPath)>/<sid>.jsonl`；远端 transcript 只在远端机器，本地必然读不到 → 空历史。
- 方案（沿用设计文档的 `session/messages` 按需拉取 + 主侧复用归一化）：
  1. lite 新增 `session/messages` RPC：按 provider 解析远端 transcript 目录，把主 jsonl + `agent-*.jsonl` 内容整体返回（**lite 只读文件不回解析**，解析归一化全部留在主侧，杜绝双份逻辑漂移）。
  2. 主侧 `fetchHistory` 在 `getSessionMessages`（本地）之前先 `lookupRemoteHost(project_path)`：
     - 命中远程 host → `runtime.historyClient.fetchMessages(hostId, {provider, providerSessionId, projectPath})` → 拿回内容走**共享解析**。
     - 未命中 → 原本地路径不变。
  3. 把 claude/qoder 里近 200 行重复的「流式读 jsonl + agent 文件 + 排序」解析抽成**共享 content-based 模块**，本地与远程两条路径共用同一个解析核心。

## 文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `server/modules/providers/list/shared/transcript-history.ts` | 新增 | `parseJsonlRecords` / `filterProviderSessionRecords` / `parseAgentToolsContent` / `assembleHistoryRecords` / `readTranscriptDir` |
| `server/shared/agent-runtime/protocol.ts` | 改 | `makeSessionMessagesParamsSchema` + `RemoteSessionMessagesResult` |
| `server/modules/remote-agents/remote-history.service.ts` | 新增 | `createRemoteHistoryClient(getRegistry)` → `rpc('session/messages')` |
| `server/modules/remote-agents/runtime.ts` | 改 | runtime 缝加 `historyClient` |
| `server/index.js` | 改 | 构造 `remoteHistoryClient` 注入 `setRemoteAgentsRuntime` |
| `server/modules/providers/list/claude/claude-sessions.provider.ts` | 改 | 删本地 parseAgentTools/流式解析 → 共享模块；`fetchHistory` 远端分支 |
| `server/modules/providers/list/qoder/qoder-sessions.provider.ts` | 改 | 同上 |
| `backend/remote-agent/src/transcript.ts` | 新增 | 远端 provider 路径解析 + 读目录内容 |
| `backend/remote-agent/src/rpc-dispatch.ts` | 改 | `session/messages` handler（zod 校验 params） |

## 测试清单（TDD）

- `shared/tests/transcript-history.test.ts`：解析/过滤/agent 附加/排序/读目录。
- `claude/tests/claude-fetch-history-remote.test.ts`：注入假 runtime + `refreshRemoteProjectsIndex` 标远程 → fetchHistory 走 RPC 且归一化结果与本地一致；RPC 失败回退空。
- `qoder/tests/...`：远端分支等价的轻量用例。
- `backend/remote-agent/src/tests/transcript.test.ts`：目录解析、存在/缺失、agent 文件收集。
- 既有用例（claude-fetch-history-fallback / workflow-history：本地路径参考实现）保持绿 = 本地重构无回归。

## 验收

- 代码完成 + 自动化全绿（2026-08-20）：
  - lite 全套 92 测试通过（新增 transcript + rpc-dispatch-messages）。
  - server 全量 796 测试通过；remote-agents + providers 全套 220 通过。
  - typecheck 11 个错误全为已知基线，**零新增**。
  - 本地路径重构经 claude-fetch-history-fallback / workflow-history 回归确认无行为变化。
- 部署验证（待做，需用户确认后执行）：重新构建/部署 lite 到远端主机（bootstrap）→ 重启主后端（先征得同意，见项目记忆）→ 打开远程 session 历史应显示真实消息。注意 `TSX_TSCONFIG_PATH=server/tsconfig.json` 会污染 `backend/remote-agent` 下的 `npm test`，需 `TSX_TSCONFIG_PATH="" npm test`。