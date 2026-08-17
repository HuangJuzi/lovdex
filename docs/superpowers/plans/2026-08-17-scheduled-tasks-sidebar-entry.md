# 定时任务：侧边栏入口 + 后端接线 + 前端视图 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从侧边栏「定时任务」入口进入任务页的「⏰ 定时」视图，并真正可用——后端补 CRUD API 与调度器启动接线，前端补类型/api/hook/视图/侧边栏入口/定时徽标。

**Architecture:** 复用已写好的 `scheduler.service.ts`（15s tick + once/interval/cron + 错过聚合），只补 `scheduler.routes.ts`（薄路由）与 `index.js` 接线；前端任务页新增第三个 `viewMode='scheduled'`（URL `?view=scheduled` 选中），侧边栏加整行入口跳转。

**Tech Stack:** Node + Express + better-sqlite3 + croner（后端）；React + react-router + lucide-react（前端）。测试用 `node:test` + `tsx`（前后端一致，无 vitest/jest）。

**Spec:** `docs/superpowers/specs/2026-08-17-scheduled-tasks-sidebar-entry-design.md`

**仓库**：`/mnt/b/workdir/github/lovdex/lovdex`（monorepo：后端在 `backend/`，前端在 `web/`）。

**测试命令约定**（先 `unset TSX_TSCONFIG_PATH`，见记忆 lovdex-tsx-env-gotcha）：
- 后端单测：`cd backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test <file>`
- 前端单测：`cd web && unset TSX_TSCONFIG_PATH && npx tsx --test <file>`

---

### Task 1: 后端 `scheduler.routes.ts`（CRUD API）

**Files:**
- Create: `backend/server/modules/scheduler/scheduler.routes.ts`
- Modify: `backend/server/modules/scheduler/index.ts`
- Test: `backend/server/modules/scheduler/tests/scheduler.routes.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// backend/server/modules/scheduler/tests/scheduler.routes.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { buildSchedulerRouter } from '@/modules/scheduler/scheduler.routes.js';

async function startServer(svc: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled-tasks', buildSchedulerRouter(svc as never));
  const server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(r)) };
}

function makeSvc() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id) ?? null,
    create: (i: Record<string, unknown>) => {
      const row = { schedule_id: 's1', ...i, next_run_at: '2026-08-14T09:00:00.000Z' };
      rows.set('s1', row); return row;
    },
    update: (id: string, u: Record<string, unknown>) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, ...u }; rows.set(id, next); return next;
    },
    remove: (id: string) => { rows.delete(id); },
    runNow: (id: string) => rows.has(id) ? { ok: true } : null,
    setEnabled: (id: string, enabled: boolean) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, enabled: enabled ? 1 : 0 }; rows.set(id, next); return next;
    },
  };
}

test('POST / creates a scheduled task', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { schedule_id: string };
    assert.equal(body.schedule_id, 's1');
  } finally { await close(); }
});

test('POST / rejects invalid scheduleType', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scheduleType: 'bogus' }),
    });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('DELETE /:id removes', async () => {
  const svc = makeSvc(); svc.create({ title: 'x', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' });
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  } finally { await close(); }
});

test('POST /:id/disable toggles enabled off', async () => {
  const svc = makeSvc(); svc.create({ title: 'x', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z' });
  const { baseUrl, close } = await startServer(svc);
  try {
    const res = await fetch(`${baseUrl}/api/scheduled-tasks/s1/disable`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { enabled: number };
    assert.equal(body.enabled, 0);
  } finally { await close(); }
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/scheduler/tests/scheduler.routes.test.ts`
Expected: FAIL —— `Cannot find module '@/modules/scheduler/scheduler.routes.js'`。

- [ ] **Step 3: 实现路由**

```ts
// backend/server/modules/scheduler/scheduler.routes.ts
import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

export type SchedulerServiceLike = {
  list: (filter: { projectPath?: string; enabled?: boolean }) => unknown[];
  get: (scheduleId: string) => unknown;
  create: (input: Record<string, unknown>) => unknown;
  update: (scheduleId: string, updates: Record<string, unknown>) => unknown;
  remove: (scheduleId: string) => void;
  runNow: (scheduleId: string) => unknown;
  setEnabled: (scheduleId: string, enabled: boolean) => unknown;
};

export function buildSchedulerRouter(svc: SchedulerServiceLike) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
    const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined;
    res.json(svc.list({ projectPath, enabled }));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    res.status(201).json(svc.create((req.body ?? {}) as Record<string, unknown>));
  }));

  router.get('/:scheduleId', asyncHandler(async (req, res) => {
    const row = svc.get(String(req.params.scheduleId));
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.patch('/:scheduleId', asyncHandler(async (req, res) => {
    const row = svc.update(String(req.params.scheduleId), (req.body ?? {}) as Record<string, unknown>);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.delete('/:scheduleId', asyncHandler(async (req, res) => {
    svc.remove(String(req.params.scheduleId));
    res.json({ success: true });
  }));

  router.post('/:scheduleId/run-now', asyncHandler(async (req, res) => {
    const result = svc.runNow(String(req.params.scheduleId));
    if (!result) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(result);
  }));

  router.post('/:scheduleId/enable', asyncHandler(async (req, res) => {
    const row = svc.setEnabled(String(req.params.scheduleId), true);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.post('/:scheduleId/disable', asyncHandler(async (req, res) => {
    const row = svc.setEnabled(String(req.params.scheduleId), false);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  return router;
}

export default buildSchedulerRouter;
```

- [ ] **Step 4: barrel 补导出**——`backend/server/modules/scheduler/index.ts` 当前内容为：

```ts
export { createSchedulerService, computeNext, initialNextRun } from './services/scheduler.service.js';
export type { SchedulerDeps } from './services/scheduler.service.js';
```

在其末尾追加一行：

```ts
export { buildSchedulerRouter } from './scheduler.routes.js';
```

- [ ] **Step 5: 跑测试验证通过**

Run: 同 Step 2
Expected: PASS（4 个测试全绿）。

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/scheduler/scheduler.routes.ts backend/server/modules/scheduler/index.ts backend/server/modules/scheduler/tests/scheduler.routes.test.ts
git commit -m "feat(scheduled-tasks): CRUD routes for scheduler service"
```

---

### Task 2: `index.js` 接线（构造调度器 + 启动 + 挂路由）

**Files:**
- Modify: `backend/server/index.js`

- [ ] **Step 1: 扩展 import**

找到第 54 行（当前）：
```js
import { initializeDatabase, projectsDb, sessionsDb, tasksDb } from './modules/database/index.js';
```
改为：
```js
import { initializeDatabase, projectsDb, scheduledTasksDb, sessionsDb, tasksDb } from './modules/database/index.js';
```

在 `import { syncProviderEnv } from './modules/config/env-sync.js';`（约 67 行）之后追加两行：
```js
import { createSchedulerService, buildSchedulerRouter } from './modules/scheduler/index.js';
import { getOperatorConfig } from './modules/operators/operator.config.js';
```

- [ ] **Step 2: 构造调度器**

找到 `startTaskRun` 的 const 定义（结束于约 309 行的 `};`），在其后、`// Wire the operator headless run deps:` 注释之前，插入：

```js
// Scheduled tasks: 15s tick dispatch. Missed runs during downtime are skipped
// but surfaced as a single label=reminder task (see scheduler service). Reuses
// broadcastTask so scheduled_task_upserted/deleted reach every WS client.
const schedulerService = createSchedulerService({
    scheduledTasksDb: {
        ...scheduledTasksDb,
        operatorWorkspacePath: getOperatorConfig().workspace,
    },
    tasksService,
    createSession: createAppSession,
    startTaskRun,
    broadcast: broadcastTask,
});
```

- [ ] **Step 3: 挂路由**

找到：
```js
app.use('/api/tasks', authenticateToken, buildTasksRouter(tasksService, {
    createSession: createAppSession,
}));
```
在其后追加：
```js
app.use('/api/scheduled-tasks', authenticateToken, buildSchedulerRouter(schedulerService));
```

- [ ] **Step 4: 启动时 `start()`**

找到 `startServer()` 内的 `await initializeDatabase();`（约 1576 行），在其后追加：
```js
        // Scheduled tasks: start the 15s tick dispatch. Failure to start must
        // not block the server — surface the error and continue.
        try {
            schedulerService.start();
        } catch (error) {
            console.error('[scheduler] start failed:', error instanceof Error ? error.message : error);
        }
```

- [ ] **Step 5: 冒烟测试**

Run（终端 A）: `cd backend && unset TSX_TSCONFIG_PATH && AUTH_ENABLED=false npx tsx --tsconfig server/tsconfig.json server/index.js`
Expected: 服务启动，日志无 `[scheduler]` 错误。

终端 B 验证空列表：
```bash
curl -s http://localhost:<PORT>/api/scheduled-tasks
```
Expected: `[]`。然后停掉终端 A。

- [ ] **Step 6: Commit**

```bash
git add backend/server/index.js
git commit -m "feat(scheduled-tasks): wire scheduler service, routes and startup"
```

---

### Task 3: 前端类型 + label 元数据

**Files:**
- Modify: `web/src/types/app.ts`
- Modify: `web/src/components/tasks/taskStatus.ts`

- [ ] **Step 1: 扩展 `TaskLabel` 与 `Task`**

`web/src/types/app.ts` 第 92 行当前：
```ts
export type TaskLabel = 'bug' | 'feature' | 'optimization' | 'refactor' | 'docs' | 'other';
```
改为：
```ts
export type TaskLabel = 'bug' | 'feature' | 'optimization' | 'refactor' | 'docs' | 'other' | 'reminder';
```

在 `Task` 接口（`web/src/types/app.ts`，`remark: string | null;` 之后）加一列：
```ts
  remark: string | null;
  /** 定时任务来源：关联 scheduled_tasks.schedule_id（由定时任务创建的任务才有值）。 */
  source_schedule_id: string | null;
```

- [ ] **Step 2: 新增 `ScheduledTask` 类型**

在 `Task` 接口定义之后、`TaskUpsertedEvent` 之前（约 135 行），追加：
```ts
export type ScheduledTaskScheduleType = 'once' | 'interval' | 'cron';

export interface ScheduledTask {
  schedule_id: string;
  title: string;
  description: string | null;
  project_path: string | null;
  executor_provider: TaskEngine;
  executor_model: string | null;
  priority: TaskPriority;
  label: TaskLabel;
  is_operator: number; // 0 | 1
  auto_run: number;    // 0 | 1
  schedule_type: ScheduledTaskScheduleType;
  cron_expr: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  last_task_id: string | null;
  enabled: number;     // 0 | 1
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: `taskStatus.ts` 加 reminder**

`web/src/components/tasks/taskStatus.ts` 第 75 行当前：
```ts
export const LABEL_ORDER: TaskLabel[] = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other'];
```
改为：
```ts
export const LABEL_ORDER: TaskLabel[] = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder'];
```

`LABEL_META`（第 77-84 行）末尾加一项：
```ts
  other: { label: '其他', color: '#6b7280' },
  reminder: { label: '提醒', color: '#f59e0b' },
```

- [ ] **Step 4: 类型检查**

Run: `cd web && npm run typecheck`
Expected: 无类型错误（若有既有 fixture 缺 `source_schedule_id`，见 Task 11 回归统一处理）。

- [ ] **Step 5: Commit**

```bash
git add web/src/types/app.ts web/src/components/tasks/taskStatus.ts
git commit -m "feat(scheduled-tasks): frontend ScheduledTask type + reminder label"
```

---

### Task 4: 前端 api 层 `scheduledTasks` 端点

**Files:**
- Modify: `web/src/utils/api.js`

- [ ] **Step 1: 追加端点**

在 `web/src/utils/api.js` 的 `tasks: { ... },` 块结束（`bySession` 行之后、`  },` 之前）后追加：

```js
  scheduledTasks: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.projectPath) qs.set('projectPath', params.projectPath);
      if (params.enabled !== undefined) qs.set('enabled', params.enabled ? 'true' : 'false');
      const s = qs.toString();
      return authenticatedFetch(`/api/scheduled-tasks${s ? `?${s}` : ''}`);
    },
    create: (body) => authenticatedFetch('/api/scheduled-tasks', { method: 'POST', body: JSON.stringify(body) }),
    get: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}`),
    update: (scheduleId, body) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' }),
    runNow: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}/run-now`, { method: 'POST' }),
    enable: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}/enable`, { method: 'POST' }),
    disable: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}/disable`, { method: 'POST' }),
  },
```

- [ ] **Step 2: 语法检查**

Run: `cd web && node --check src/utils/api.js`
Expected: 无输出（语法通过）。

- [ ] **Step 3: Commit**

```bash
git add web/src/utils/api.js
git commit -m "feat(scheduled-tasks): api layer scheduledTasks endpoints"
```

---

### Task 5: `scheduleLabel` 工具 + 测试

**Files:**
- Create: `web/src/utils/scheduleLabel.ts`
- Test: `web/src/utils/scheduleLabel.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// web/src/utils/scheduleLabel.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ScheduledTask } from '../types/app';
import { cronLabel, intervalLabel, scheduleLabel } from './scheduleLabel';

function mkTask(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    schedule_id: 's1', title: 't', description: null, project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, schedule_type: 'once', cron_expr: null,
    interval_seconds: null, run_at: null, timezone: 'local',
    next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
    enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}

test('intervalLabel converts seconds to readable units', () => {
  assert.equal(intervalLabel(3600), '每 1 小时');
  assert.equal(intervalLabel(21600), '每 6 小时');
  assert.equal(intervalLabel(86400), '每 1 天');
  assert.equal(intervalLabel(1800), '每 30 分钟');
});

test('cronLabel humanizes common patterns and falls back to raw', () => {
  assert.equal(cronLabel('0 9 * * *'), '每天 09:00');
  assert.equal(cronLabel('0 9 * * 1'), '每周一 09:00');
  assert.equal(cronLabel('0 10 15 * *'), '每月 15 日 10:00');
  assert.equal(cronLabel('0 9,17 * * *'), '0 9,17 * * *');
});

test('scheduleLabel dispatches by schedule_type', () => {
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' })), '一次性');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'interval', interval_seconds: 86400 })), '每 1 天');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'cron', cron_expr: '0 9 * * 1-5' })), '0 9 * * 1-5');
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd web && unset TSX_TSCONFIG_PATH && npx tsx --test src/utils/scheduleLabel.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现工具**

```ts
// web/src/utils/scheduleLabel.ts
import type { ScheduledTask } from '../types/app';

/** interval_seconds → 可读中文（按分钟/小时/天就近取整）。 */
export function intervalLabel(seconds: number): string {
  if (seconds <= 0) return `每 ${seconds} 秒`;
  if (seconds < 60) return `每 ${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `每 ${minutes} 分钟`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `每 ${hours} 小时`;
  const days = Math.round(seconds / 86400);
  return `每 ${days} 天`;
}

const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 常见 cron 表达式 → 中文；无法 humanize 时原样返回。 */
export function cronLabel(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;
  const hhmm = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom === '*' && month === '*' && dow === '*') return `每天 ${hhmm}`;
  if (dom === '*' && month === '*' && /^[0-6]$/.test(dow)) return `每周${DOW_LABELS[Number(dow)]} ${hhmm}`;
  if (/^\d+$/.test(dom) && month === '*' && dow === '*') return `每月 ${Number(dom)} 日 ${hhmm}`;
  return expr;
}

/** 调度模板 → 人类可读描述；once 只显示「一次性」（具体时间由视图用 next_run_at 展示）。 */
export function scheduleLabel(s: ScheduledTask): string {
  switch (s.schedule_type) {
    case 'interval': return intervalLabel(s.interval_seconds ?? 0);
    case 'cron': return cronLabel(s.cron_expr ?? '');
    case 'once': return '一次性';
    default: return s.schedule_type;
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: 同 Step 2
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add web/src/utils/scheduleLabel.ts web/src/utils/scheduleLabel.test.ts
git commit -m "feat(scheduled-tasks): scheduleLabel humanize util"
```

---

### Task 6: `useScheduledTasks` hook

**Files:**
- Create: `web/src/hooks/useScheduledTasks.ts`

- [ ] **Step 1: 实现 hook**（仿 `useTasks.ts`，订阅 `scheduled_task_upserted/deleted`）

```ts
// web/src/hooks/useScheduledTasks.ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../utils/api';
import type { ScheduledTask } from '../types/app';

/** Realtime scheduled-task frame delivered by the WS `subscribe` API. */
export type ScheduledTaskEvent = {
  kind?: string;
  scheduledTask?: ScheduledTask;
  scheduleId?: string;
};

export function useScheduledTasks(
  options: { projectPath?: string; enabled?: boolean } = {},
  subscribe?: (cb: (event: ScheduledTaskEvent) => void) => () => void,
) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.scheduledTasks.list(options);
      if (!res.ok) throw new Error(`scheduledTasks.list failed: ${res.status}`);
      const data = (await res.json()) as ScheduledTask[];
      if (mounted.current) {
        setTasks(Array.isArray(data) ? data : []);
        setLoadError(false);
      }
    } catch (error) {
      console.error('Error fetching scheduled tasks:', error);
      if (mounted.current) setLoadError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [options.projectPath, options.enabled]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const upsert = useCallback((task: ScheduledTask) => {
    setTasks(prev => {
      const i = prev.findIndex(t => t.schedule_id === task.schedule_id);
      if (i === -1) return [...prev, task];
      const next = [...prev];
      next[i] = task;
      return next;
    });
  }, []);

  const remove = useCallback((scheduleId: string) => {
    setTasks(prev => prev.filter(t => t.schedule_id !== scheduleId));
  }, []);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.kind === 'scheduled_task_upserted' && event.scheduledTask) upsert(event.scheduledTask);
      else if (event.kind === 'scheduled_task_deleted' && event.scheduleId) remove(event.scheduleId);
      else if (event.kind === 'websocket_reconnected') void refresh();
    });
  }, [subscribe, upsert, remove, refresh]);

  return { tasks, loading, loadError, refresh, upsert, remove };
}
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npm run typecheck`
Expected: 无类型错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useScheduledTasks.ts
git commit -m "feat(scheduled-tasks): useScheduledTasks hook with WS subscribe"
```

---

### Task 7: 定时任务视图 + 表单

**Files:**
- Create: `web/src/components/tasks/ScheduledTasksView.tsx`
- Create: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Create: `web/src/components/tasks/ScheduledTasksPanel.tsx`
- Test: `web/src/components/tasks/ScheduledTasksView.test.tsx`

- [ ] **Step 1: 写失败测试**（renderToStaticMarkup + StaticRouter）

```tsx
// web/src/components/tasks/ScheduledTasksView.test.tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { ScheduledTask } from '../../types/app';
import { ScheduledTasksView } from './ScheduledTasksView';

const baseTask: ScheduledTask = {
  schedule_id: 's1', title: '每日站会', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

test('renders scheduled tasks rows', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView
        tasks={[baseTask]}
        projectOptions={[{ value: '/proj', label: 'proj' }]}
        onNew={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggle={() => {}}
        onRunNow={() => {}}
      />
    </StaticRouter>,
  );
  assert.match(html, /每日站会/);
  assert.match(html, /每天 09:00/);
});

test('renders empty state', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView tasks={[]} projectOptions={[]} onNew={() => {}} onEdit={() => {}} onDelete={() => {}} onToggle={() => {}} onRunNow={() => {}} />
    </StaticRouter>,
  );
  assert.match(html, /暂无定时任务/);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `ScheduledTasksView.tsx`**（纯展示，props 驱动）

```tsx
// web/src/components/tasks/ScheduledTasksView.tsx
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Pencil, Play, Plus, Power, Trash2 } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import type { ScheduledTask } from '../../types/app';
import { scheduleLabel } from '../../utils/scheduleLabel';
import type { TaskProjectOption } from './TaskCard';
import { formatAbsoluteTime } from './taskTimestamp';

export type ScheduledTasksViewProps = {
  tasks: ScheduledTask[];
  projectOptions: TaskProjectOption[];
  onNew: () => void;
  onEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask) => void;
  onRunNow: (task: ScheduledTask) => void;
};

function projectLabel(task: ScheduledTask, projectOptions: TaskProjectOption[]): string {
  if (task.is_operator === 1 || !task.project_path) return '🤖 Lovdex助手';
  const opt = projectOptions.find((o) => o.value === task.project_path);
  return opt?.label ?? task.project_path;
}

export function ScheduledTasksView({ tasks, projectOptions, onNew, onEdit, onDelete, onToggle, onRunNow }: ScheduledTasksViewProps) {
  const navigate = useNavigate();

  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <div className="text-sm text-muted-foreground">暂无定时任务</div>
        <Button size="toolbar" variant="chunkyPrimary" onClick={onNew}>
          <Plus />
          新建定时任务
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between px-3 py-2 sm:px-4">
        <span className="text-sm font-semibold text-foreground">⏰ 定时任务</span>
        <Button size="toolbar" variant="chunkyPrimary" onClick={onNew}>
          <Plus />
          新建
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4">
        <table className="w-full min-w-[900px] border-separate text-sm" style={{ borderSpacing: '0 7px' }}>
          <thead>
            <tr>
              {['标题', '调度', '项目', '自动执行', '下次触发', '上次触发', '操作'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 pb-1 text-left text-xs font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.schedule_id} className="bg-card shadow-sm">
                <td className="rounded-l-lg px-4 py-3 font-semibold text-card-foreground">{task.title}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <CalendarClock className="mr-1 inline h-3 w-3" />
                  {scheduleLabel(task)}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{projectLabel(task, projectOptions)}</td>
                <td className="px-4 py-3 text-xs">{task.auto_run === 1 ? '✅ 自动执行' : '🔔 仅提醒'}</td>
                <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{formatAbsoluteTime(task.next_run_at)}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {task.last_task_id ? (
                    <button className="text-primary underline" onClick={() => navigate(`/task/${task.last_task_id}`)}>查看</button>
                  ) : '—'}
                </td>
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button title="立即触发" aria-label="立即触发" onClick={() => onRunNow(task)} className="rounded-lg px-2 py-1 text-sky-600 hover:bg-sky-500/10"><Play className="h-3 w-3" /></button>
                    <button title={task.enabled === 1 ? '停用' : '启用'} aria-label="启停" onClick={() => onToggle(task)} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><Power className="h-3 w-3" /></button>
                    <button title="编辑" aria-label="编辑" onClick={() => onEdit(task)} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><Pencil className="h-3 w-3" /></button>
                    <button title="删除" aria-label="删除" onClick={() => onDelete(task)} className="rounded-lg px-2 py-1 text-red-500 hover:bg-red-500/10"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 实现 `ScheduledTaskForm.tsx`**（创建/编辑弹窗）

```tsx
// web/src/components/tasks/ScheduledTaskForm.tsx
import { useState } from 'react';
import type { ScheduledTask, ScheduledTaskScheduleType, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
import type { TaskProjectOption } from './TaskCard';

export type ScheduledTaskDraft = {
  title: string;
  description: string;
  projectPath: string;
  executorProvider: TaskEngine;
  priority: TaskPriority;
  label: TaskLabel;
  autoRun: boolean;
  scheduleType: ScheduledTaskScheduleType;
  cronExpr: string;
  intervalSeconds: string;
  runAt: string;
};

export const EMPTY_DRAFT: ScheduledTaskDraft = {
  title: '', description: '', projectPath: ASSISTANT_OPTION_VALUE, executorProvider: 'claude',
  priority: 'P2', label: 'other', autoRun: true, scheduleType: 'once',
  cronExpr: '', intervalSeconds: '3600', runAt: '',
};

const INTERVAL_PRESETS = [
  { value: '3600', label: '每 1 小时' },
  { value: '21600', label: '每 6 小时' },
  { value: '86400', label: '每天' },
  { value: '604800', label: '每周' },
];

function toDraft(initial?: ScheduledTask | null): ScheduledTaskDraft {
  if (!initial) return EMPTY_DRAFT;
  const runAt = initial.run_at ? new Date(initial.run_at).toISOString().slice(0, 16) : '';
  return {
    title: initial.title,
    description: initial.description ?? '',
    projectPath: initial.project_path ?? ASSISTANT_OPTION_VALUE,
    executorProvider: initial.executor_provider,
    priority: initial.priority,
    label: initial.label,
    autoRun: initial.auto_run === 1,
    scheduleType: initial.schedule_type,
    cronExpr: initial.cron_expr ?? '',
    intervalSeconds: String(initial.interval_seconds ?? 3600),
    runAt,
  };
}

export type ScheduledTaskFormProps = {
  open: boolean;
  initial?: ScheduledTask | null;
  projectOptions: TaskProjectOption[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (draft: ScheduledTaskDraft) => void;
};

export function ScheduledTaskForm({ open, initial, projectOptions, submitting, error, onClose, onSubmit }: ScheduledTaskFormProps) {
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => toDraft(initial));
  const [localError, setLocalError] = useState<string | null>(null);

  const set = <K extends keyof ScheduledTaskDraft>(key: K, value: ScheduledTaskDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = () => {
    setLocalError(null);
    if (!draft.title.trim()) { setLocalError('标题不能为空'); return; }
    if (draft.scheduleType === 'cron' && !draft.cronExpr.trim()) { setLocalError('请填写 cron 表达式'); return; }
    if (draft.scheduleType === 'once' && !draft.runAt) { setLocalError('请选择触发时间'); return; }
    if (draft.scheduleType === 'interval' && !(Number(draft.intervalSeconds) > 0)) { setLocalError('间隔必须大于 0 秒'); return; }
    onSubmit(draft);
  };

  const fieldCls = 'h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="max-h-[85vh] w-full max-w-lg overflow-y-auto">
        <DialogTitle>{initial ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">标题</label>
            <Input className="h-9 w-full" placeholder="触发时创建的任务标题" value={draft.title} onChange={(e) => set('title', e.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">描述</label>
            <Input className="h-9 w-full" placeholder="触发时创建的任务内容，可选" value={draft.description} onChange={(e) => set('description', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">项目</label>
            <select className={fieldCls} value={draft.projectPath} onChange={(e) => set('projectPath', e.target.value)}>
              <option value={ASSISTANT_OPTION_VALUE}>🤖 Lovdex助手</option>
              {projectOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">执行引擎</label>
            <select className={fieldCls} value={draft.executorProvider} onChange={(e) => set('executorProvider', e.target.value as TaskEngine)}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
              <option value="qoder">Qoder</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">优先级</label>
            <select className={fieldCls} value={draft.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Label</label>
            <select className={fieldCls} value={draft.label} onChange={(e) => set('label', e.target.value as TaskLabel)}>
              {LABEL_ORDER.map((l) => <option key={l} value={l}>{LABEL_META[l].label}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={draft.autoRun} onChange={(e) => set('autoRun', e.target.checked)} />
            自动执行（关闭则仅生成提醒任务）
          </label>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">调度类型</label>
            <select className={fieldCls} value={draft.scheduleType} onChange={(e) => set('scheduleType', e.target.value as ScheduledTaskScheduleType)}>
              <option value="once">一次性</option>
              <option value="interval">间隔</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </div>
          {draft.scheduleType === 'once' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">触发时间</label>
              <Input type="datetime-local" className="h-9 w-full" value={draft.runAt} onChange={(e) => set('runAt', e.target.value)} />
            </div>
          )}
          {draft.scheduleType === 'interval' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">间隔</label>
              <select className={fieldCls} value={draft.intervalSeconds} onChange={(e) => set('intervalSeconds', e.target.value)}>
                {INTERVAL_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          )}
          {draft.scheduleType === 'cron' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Cron 表达式</label>
              <Input className="h-9 w-full" placeholder="0 9 * * *" value={draft.cronExpr} onChange={(e) => set('cronExpr', e.target.value)} />
            </div>
          )}
          {(localError || error) && <div className="text-sm text-red-500">{localError ?? error}</div>}
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
            <Button size="sm" onClick={submit} disabled={submitting}>{submitting ? '保存中…' : '保存'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: 实现 `ScheduledTasksPanel.tsx`**（容器：数据 + CRUD）

```tsx
// web/src/components/tasks/ScheduledTasksPanel.tsx
import { useState } from 'react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useScheduledTasks } from '../../hooks/useScheduledTasks';
import type { ScheduledTask } from '../../types/app';
import { api } from '../../utils/api';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { ScheduledTaskForm, type ScheduledTaskDraft } from './ScheduledTaskForm';
import { ScheduledTasksView } from './ScheduledTasksView';
import type { TaskProjectOption } from './TaskCard';

function toApiBody(d: ScheduledTaskDraft) {
  const projectPath = d.projectPath === ASSISTANT_OPTION_VALUE || !d.projectPath ? null : d.projectPath;
  return {
    title: d.title,
    description: d.description || null,
    projectPath,
    executorProvider: d.executorProvider,
    priority: d.priority,
    label: d.label,
    autoRun: d.autoRun ? 1 : 0,
    scheduleType: d.scheduleType,
    cronExpr: d.scheduleType === 'cron' ? d.cronExpr : null,
    intervalSeconds: d.scheduleType === 'interval' ? Number(d.intervalSeconds) : null,
    runAt: d.scheduleType === 'once' ? (d.runAt ? new Date(d.runAt).toISOString() : null) : null,
  };
}

export function ScheduledTasksPanel({ projectOptions }: { projectOptions: TaskProjectOption[] }) {
  const { subscribe } = useWebSocket();
  const { tasks, loading, loadError, refresh } = useScheduledTasks({}, subscribe);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openNew = () => { setEditing(null); setError(null); setFormOpen(true); };
  const openEdit = (t: ScheduledTask) => { setEditing(t); setError(null); setFormOpen(true); };

  async function submit(draft: ScheduledTaskDraft) {
    setSubmitting(true);
    setError(null);
    const body = toApiBody(draft);
    try {
      const res = editing
        ? await api.scheduledTasks.update(editing.schedule_id, body)
        : await api.scheduledTasks.create(body);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message ?? `保存失败 (${res.status})`);
        return;
      }
      setFormOpen(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(t: ScheduledTask) {
    if (!window.confirm(`删除定时任务「${t.title}」？已生成的任务不会被删除。`)) return;
    await api.scheduledTasks.remove(t.schedule_id);
    void refresh();
  }

  async function toggle(t: ScheduledTask) {
    const res = t.enabled === 1
      ? await api.scheduledTasks.disable(t.schedule_id)
      : await api.scheduledTasks.enable(t.schedule_id);
    if (res.ok) void refresh();
  }

  async function runNow(t: ScheduledTask) {
    const res = await api.scheduledTasks.runNow(t.schedule_id);
    if (res.ok) void refresh();
  }

  if (loading) return <div className="px-3 text-sm text-muted-foreground sm:px-6">加载中…</div>;
  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <div className="text-sm text-muted-foreground">加载定时任务失败</div>
        <button className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90" onClick={() => void refresh()}>重试</button>
      </div>
    );
  }

  return (
    <>
      <ScheduledTasksView tasks={tasks} projectOptions={projectOptions} onNew={openNew} onEdit={openEdit} onDelete={(t) => void remove(t)} onToggle={(t) => void toggle(t)} onRunNow={(t) => void runNow(t)} />
      <ScheduledTaskForm key={editing?.schedule_id ?? 'new'} open={formOpen} initial={editing} projectOptions={projectOptions} submitting={submitting} error={error} onClose={() => setFormOpen(false)} onSubmit={(d) => void submit(d)} />
    </>
  );
}
```

- [ ] **Step 6: 跑测试验证通过**

Run: 同 Step 2
Expected: PASS（2 个测试全绿）。

- [ ] **Step 7: 类型检查**

Run: `cd web && npm run typecheck`
Expected: 无类型错误。

- [ ] **Step 8: Commit**

```bash
git add web/src/components/tasks/ScheduledTasksView.tsx web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTasksPanel.tsx web/src/components/tasks/ScheduledTasksView.test.tsx
git commit -m "feat(scheduled-tasks): scheduled tasks view + form + panel"
```

---

### Task 8: `TaskBoard` 加第三视图 + `?view=scheduled`

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: import 调整**

第 2 行当前：
```tsx
import { useNavigate } from 'react-router-dom';
```
改为：
```tsx
import { useNavigate, useSearchParams } from 'react-router-dom';
```

第 3 行当前：
```tsx
import { LayoutGrid, Plus, Table } from 'lucide-react';
```
改为：
```tsx
import { Clock, LayoutGrid, Plus, Table } from 'lucide-react';
```

在 `import { TaskFilterBar } from './TaskFilterBar';` 之后追加：
```tsx
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
```

- [ ] **Step 2: viewMode 类型 + 读 query 参数**

第 48 行当前：
```tsx
  const [viewMode, setViewMode] = useLocalStorage<'board' | 'table'>('taskViewMode', 'board');
```
改为：
```tsx
  const [viewMode, setViewMode] = useLocalStorage<'board' | 'table' | 'scheduled'>('taskViewMode', 'board');
  // 侧边栏「定时任务」入口带 ?view=scheduled 进来时，启动选中定时视图；仅在挂载时读一次。
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('view') === 'scheduled') setViewMode('scheduled');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

第 52 行当前：
```tsx
  const effectiveView = isMobile ? 'board' : viewMode;
```
改为（移动端默认看板，但显式选中定时视图时尊重它）：
```tsx
  const effectiveView = isMobile && viewMode !== 'scheduled' ? 'board' : viewMode;
```

- [ ] **Step 3: 分段控件加「⏰ 定时」按钮**

在「表格」按钮（`<Table ... />表格</button>`）之后、`</div>`（分段控件容器）之前，追加：
```tsx
          <button
            type="button"
            aria-pressed={effectiveView === 'scheduled'}
            onClick={() => setViewMode('scheduled')}
            className={cn(
              'hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all sm:flex',
              effectiveView === 'scheduled'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Clock className="h-3 w-3" />
            ⏰ 定时
          </button>
```

- [ ] **Step 4: 渲染定时视图**（两处精确替换）

**替换 A**——开头的三行（当前文件约 499-501 行）：
```tsx
        <div className="flex min-h-0 flex-1 flex-col">
          <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} />
          {effectiveView === 'table' ? (
```
改为：
```tsx
        <div className="flex min-h-0 flex-1 flex-col">
          {effectiveView === 'scheduled' ? (
            <ScheduledTasksPanel projectOptions={projectOptions} />
          ) : (
          <>
          <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} />
          {effectiveView === 'table' ? (
```

**替换 B**——结尾的 board 分支收尾（当前文件约 547-551 行，`STATUS_ORDER.map` 看板列之后）：
```tsx
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
```
改为（在看板 `)}` 之后补 `</>` 与闭合三元 `)}`）：
```tsx
              ))}
            </div>
          )}
          </>
          )}
        </div>
      )}
    </div>
  );
```

> 不要改动 `TaskTableView` 与看板列（`STATUS_ORDER.map(...)`）的内部内容，只做上述开/闭两处包裹。

- [ ] **Step 5: 类型检查 + lint**

Run: `cd web && npm run typecheck && npm run lint`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(scheduled-tasks): third scheduled view in task board"
```

---

### Task 9: 侧边栏「定时任务」入口

**Files:**
- Create: `web/src/components/sidebar/view/subcomponents/SidebarScheduledEntry.tsx`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx`

- [ ] **Step 1: 新建入口组件**

```tsx
// web/src/components/sidebar/view/subcomponents/SidebarScheduledEntry.tsx
import { useNavigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

/**
 * 「定时任务」侧边栏整行入口，置于 Lovdex助手 与项目列表之间。
 * 点击跳转任务页的「⏰ 定时」视图（/tasks?view=scheduled）。样式对齐 Lovdex助手 行。
 */
export default function SidebarScheduledEntry() {
  const navigate = useNavigate();
  return (
    <div className="flex-shrink-0 px-2 pt-1.5 md:px-1.5">
      <Button
        variant="ghost"
        className={cn('flex w-full justify-between p-2 h-auto font-normal hover:bg-muted', 'bg-primary/5')}
        onClick={() => navigate('/tasks?view=scheduled')}
        title="定时任务"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <CalendarClock className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">定时任务</span>
        </div>
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: 接入 `SidebarContent.tsx`**

在 `import SidebarProjectList, ...`（约 13 行）之后追加：
```tsx
import SidebarScheduledEntry from './SidebarScheduledEntry';
```

在 JSX 中，`<SidebarAssistant ... />`（约 130-133 行）之后、`<ScrollArea ...>`（约 135 行）之前，插入：
```tsx
      <SidebarScheduledEntry />
```

- [ ] **Step 3: 类型检查 + lint**

Run: `cd web && npm run typecheck && npm run lint`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/sidebar/view/subcomponents/SidebarScheduledEntry.tsx web/src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(scheduled-tasks): sidebar scheduled-tasks entry row"
```

---

### Task 10: 任务卡/详情的「⏰ 定时」徽标

**Files:**
- Modify: `web/src/components/tasks/TaskCard.tsx`
- Modify: `web/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: `TaskCard.tsx` 顶部标签条加徽标**

在顶部标签条（约 56-84 行）内、Label 徽标之后（`priority` 徽标之前或之后均可，放在 Label 之后），追加：
```tsx
        {task.source_schedule_id && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-600 dark:text-amber-400">
            ⏰ 定时
          </span>
        )}
```

- [ ] **Step 2: `TaskDetail.tsx` 标题旁加徽标**

> 注意：该文件工作区有未提交改动（header 已改为 `HomeButton`）。下面的插入点与那些改动不重叠。

在标题区「🤖 Lovdex助手」徽标（约 502-506 行）之后，追加：
```tsx
            {task.source_schedule_id && (
              <button
                className="mt-1 ml-2 inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
                onClick={() => navigate('/tasks?view=scheduled')}
              >
                ⏰ 定时
              </button>
            )}
```

- [ ] **Step 3: 类型检查 + 既有前端测试回归**

Run: `cd web && npm run typecheck && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskCard.test.tsx`
Expected: 无类型错误；TaskCard 测试 PASS（fixture 已含 `source_schedule_id` 则为 null，徽标不渲染，不影响断言）。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/tasks/TaskCard.tsx web/src/components/tasks/TaskDetail.tsx
git commit -m "feat(scheduled-tasks): scheduled badge on task card and detail"
```

---

### Task 11: 全量回归

- [ ] **Step 1: 后端测试**

Run: `cd backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/scheduler/tests/scheduler.routes.test.ts server/modules/scheduler/tests/scheduler.service.test.ts server/modules/database/tests/scheduled-tasks.db.test.ts`
Expected: 全 PASS。

- [ ] **Step 2: 前端测试 + 类型 + lint + build**

Run: `cd web && unset TSX_TSCONFIG_PATH && npx tsx --test src/utils/scheduleLabel.test.ts src/components/tasks/ScheduledTasksView.test.tsx src/components/tasks/TaskCard.test.tsx`
Expected: 全 PASS。

Run: `cd web && npm run typecheck && npm run lint && npm run build`
Expected: 无错误，build 成功。

> 若既有 fixture（`TaskCard.test.tsx`、`TaskTableView.test.tsx`、`TaskDetail` 相关）因 `Task` 新增必填字段 `source_schedule_id` 报类型错误，给这些 fixture 的 `baseTask` 补 `source_schedule_id: null` 即可。

- [ ] **Step 3: 手动端到端验证**

后端起服（`cd backend && unset TSX_TSCONFIG_PATH && AUTH_ENABLED=false npx tsx --tsconfig server/tsconfig.json server/index.js`），然后：
```bash
# 建一条每 10 秒的定时（autoRun=0 避免真跑）
curl -s -X POST http://localhost:<PORT>/api/scheduled-tasks -H 'Content-Type: application/json' \
  -d '{"title":"冒烟-每10秒","scheduleType":"interval","intervalSeconds":10,"autoRun":0,"projectPath":"<一个已登记项目路径>"}'
curl -s http://localhost:<PORT>/api/scheduled-tasks
```
Expected: 列表有该模板；约 10 秒后 `GET /api/tasks` 出现 `source_schedule_id` 非空的任务。侧边栏「定时任务」入口进入 `?view=scheduled` 视图可见该模板。清理测试模板与生成的任务。

- [ ] **Step 4: 推送分支**

```bash
git status  # 确认无并发会话改动（尤其 web/src/components/tasks/TaskBackNav.tsx / TaskDetail.tsx 的既有未提交改动需先决定去留）
git checkout -b feat/scheduled-tasks
git push origin feat/scheduled-tasks
```

> 若后续要合入 main，走 PR / `--ff-only`，勿直接 reset。
