# 已建任务会话名回填 — 设计

日期：2026-08-12
状态：已批准（用户确认）
前置：`2026-08-12-task-session-name-design.md`（新任务执行会话已按任务标题命名）

## 概述

上一改动让**新任务**「开始执行」时，执行会话 `custom_name` 直接设为任务标题。但**已创建任务**的执行会话仍是旧状态：`custom_name` 为 NULL，侧边栏显示的是任务第一条 prompt 的长文。

本次改动：**后端启动时自动回填**——对「有会话、会话名空白/占位符」的任务，把会话 `custom_name` 设为任务标题，一次性补齐存量会话。

## 触发时机（用户确认）

后端启动时自动执行，仿现有 `reconcileFailedTasks` 模式。不做手动接口。

## 实现

### 1. `tasksService.backfillSessionNames()`（`server/modules/tasks/services/tasks.service.ts`）

在 `reconcileFailedTasks` 旁新增方法：

```ts
/**
 * 回填：把带会话且会话名空白/占位符的任务，会话 custom_name 设为任务标题。
 * 幂等——只填空白/占位符名，不覆盖用户手动重命名或 AI 已有标题。启动时调用。
 */
backfillSessionNames(): number {
  let changed = 0;
  for (const row of resolveDb.listTasks({})) {
    const title = row.title?.trim();
    if (!title || !row.session_id) continue;
    const session = resolveSession(row.session_id);
    if (!session) continue;
    const name = session.custom_name?.trim();
    if (name && name !== 'Untitled Claude Session' && name !== 'Untitled Codex Session') continue;
    opts.deps?.sessionsDb?.updateSessionCustomName(row.session_id, row.title);
    changed += 1;
  }
  return changed;
}
```

- 复用既有 `resolveSession`（= `opts.deps?.sessionsDb?.getSessionById ?? (() => null)`）。
- `custom_name` 为 NULL / 空白 / 占位符（`'Untitled Claude Session'`、`'Untitled Codex Session'`）时才填。占位符与 claude/codex 同步器的 `normalizeSessionName` fallback 一致。
- 写入 `row.title` 原文，与 `startExecution` 命名行为一致。
- 不 emit 任务事件（只改 session 名，任务行不变）。

### 2. 启动接线（`server/index.js`）

在启动时 `reconcileFailedTasks` 调用之后追加：

```js
try {
    const backfilled = tasksService.backfillSessionNames();
    if (backfilled > 0) {
        console.log(`[tasks] backfilled ${backfilled} session name(s) from task titles`);
    }
} catch (err) {
    console.error('backfillSessionNames on startup failed:', err);
}
```

## 语义与边界

- **幂等**：只填空白/占位符名；重复启动无副作用。
- **不覆盖**：非空白 `custom_name`（用户手动重命名、AI 已有 custom_title）不动。
- **与同步器共存**：回填后 claude/codex 同步器在「磁盘无 custom-title」时保留 DB custom_name，所以回填值稳定；若磁盘已有 custom-title（用户重命名），同步器以磁盘为准（仍符合「用户重命名最高优先」）。
- **会话不存在**：跳过（`getSessionById` 返回 null）。
- **任务无会话 / 标题空白**：跳过。

## 测试

`server/modules/tasks/tests/tasks.service.test.ts` 新增 `backfillSessionNames` 用例：

1. 会话 `custom_name` 为 NULL → 回填为任务标题，返回 1。
2. 会话已有自定义名（如 `'自定义'`）→ 跳过，返回 0。
3. 会话名是占位符（如 `'Untitled Claude Session'`）→ 回填，返回 1。
4. 任务无 `session_id` → 跳过。
5. 任务标题空白 → 跳过。

测试用 stub `sessionsDb`（`getSessionById` 返回带 `custom_name` 的行，`updateSessionCustomName` 记录调用）。

## 范围外

- 手动回填接口。
- 前端改动。
- 修改同步器优先级。
- 会话创建时命名行为（上一改动已覆盖）。
