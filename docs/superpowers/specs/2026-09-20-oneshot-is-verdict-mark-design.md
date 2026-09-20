# 一次性 LLM 会话打 is_verdict 标记 — 设计

日期：2026-09-20
状态：已批准

## 问题

「最近任务」侧边栏出现大量垃圾条目，标题形如：

> 判断任务 9c727d85-…（…）在 session 里的实际完成度。【最终输出】…

根因链（已逐环验证）：

1. 非operator 会话每轮结束触发 auto-verdict；生产配置 `verdict_mode: 'llm'`（commit 76c2e5b），走 `runOneShotClaudeText`（`backend/server/claude-sdk.js`）做一次性 headless 判定。
2. SDK 的 cwd 在 `~/.lovdex/operator-workspace`，Claude CLI 为这次调用写 transcript JSONL，首条 user 消息即判定提示词全文。
3. 文件 watcher 触发 `ClaudeSessionSynchronizer` 索引该 transcript，从尾部 `last-prompt` 事件取 summary → sessions 表里出现一条 summary=提示词原文的会话行。
4. **缺口**：`markSessionAsVerdict` 只在老 provider 通道 `runOperatorHeadless` 里调用；LLM 通道整条链路不打 `is_verdict`。生产库 `is_verdict=1` 计数为 0。
5. 前端 `getRecentSessions` 只过滤 `is_verdict !== 1`，泄漏条目全部进「最近任务」。任务每轮 completed 判定一次 → 一条垃圾/轮。

同路径泄漏源还有两个：任务取名 job（`generateTitle`，summary=`为下面的任务需求起一个标题。…`）与任务上下文压缩 job（summary 模式）。三者共用 `runOneShotClaudeText`。

## 方案：函数内部打标（已选定）

三个候选调用方共用一个 headless 入口，session_id 只能从它内部的 SDK 流里拿到，所以打标放在 `runOneShotClaudeText` 内部——一处改动覆盖全部现有与未来调用方。

### 改动点：`runOneShotClaudeText`（claude-sdk.js:1411）

- 消费流循环里顺带捕获 `message.session_id`（与 `runOperatorHeadless` 在同文件 1382-1386 行的做法同构）。
- 流结束后调用 `sessionsDb.markSessionAsVerdict(sessionId, cfg.workspace)`：
  - `cfg.workspace` 函数内已有（cwd 取自它）；`sessionsDb` 已在文件顶部 import——零新增依赖；
  - 函数签名与返回值不变（仍 `string | null`）；
  - 新增可选 `markVerdictSession` 测试缝（照抄 `runOperatorHeadless` 的 seam 模式），默认 `sessionsDb.markSessionAsVerdict(sid, cfg.workspace)`；
  - mark 失败只 `console.error` 不抛——打标失败只影响侧栏过滤，绝不能让取名/判定本身失败。
- 时序安全：`markSessionAsVerdict` 是 upsert（sessions.db.ts:208-212），watcher 先索引到也只会在已有行上刷 `is_verdict=1`；后 mark 则插入即带标志。`createSession` 重索引分支不碰 `is_verdict`，标志不被冲掉。

### 存量数据修复（一次性运维操作）

```sql
UPDATE sessions SET is_verdict = 1
WHERE project_path = '/home/zhijuhuang/.lovdex/operator-workspace'
  AND is_verdict = 0 AND is_operator = 0
  AND (summary LIKE '判断任务 %' OR summary LIKE '为下面的任务需求起一个标题%');
```

- 命中 18 行（12 判定 + 6 取名），已逐条核实；不误伤同目录 17 条 `is_operator=1` 助手交互会话。
- 改前 `cp` 备份 DB。单条 UPDATE 原子，与后端并发写安全，无需重启。

### 测试

`run-one-shot-claude-text.test.ts` 增 3 例：

1. 流里出现 `session_id` → marker 被调用且参数为 `(sessionId, cfg.workspace)`；
2. 流里无 `session_id` → marker 不被调用；
3. marker 抛错 → 不影响文本返回（reject 不外泄）。

现有 6 例回归不动（签名未变）。

## 不做的事

- 不改 verdict-llm / task-title / task-context 三模块的 deps 接口与 index.js 接线。
- 不清理 transcript JSONL 文件本身（磁盘 transcript 保留无副作用；重索引会带着 `is_verdict=1`）。
