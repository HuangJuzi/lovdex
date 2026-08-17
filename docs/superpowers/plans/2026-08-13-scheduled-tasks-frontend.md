# Lovdex 定时任务 — 前端实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 lovdex-cli 任务页加第三个 "⏰ 定时" 视图：定时任务列表 + 创建/编辑表单 + 启停/删除/立即触发，任务卡/详情显示 `⏰ 定时` 徽标，WS 实时刷新。

**Architecture:** 纯展示组件 `ScheduledTasksView`（props 驱动，可测）+ 容器 `useScheduledTasks`（拉 `GET /api/scheduled-tasks` + WS 订阅 `scheduled_task_upserted/deleted`）+ `TaskBoard` 的 viewMode 扩为 `'board'|'table'|'scheduled'`。遵循代码库惯例：任务区文案硬编码中文（不用 i18n t()）。

**Tech Stack:** React + TS + Tailwind + node:test + `renderToStaticMarkup`。

**Spec:** `docs/superpowers/specs/2026-08-13-scheduled-tasks-design.md`
**Backend plan:** `docs/superpowers/plans/2026-08-13-scheduled-tasks-backend.md`（先完成后端 API，前端消费它）

**仓库**：`/mnt/b/workdir/github/lovdex/lovdex-cli`。测试命令：`npx tsx --test <file>`（无 test script；先 `unset TSX_TSCONFIG_PATH`，见记忆 lovdex-tsx-env-gotcha）。

---

### Task 1: 类型 + label 映射 + API 层 + scheduleLabel 工具

**Files:**
- Modify: `src/types/app.ts`
- Modify: `src/components/tasks/taskStatus.ts`（LABEL_ORDER / LABEL_META 加 `reminder`）
- Modify: `src/utils/api.js`（scheduledTasks 端点）
- Create: `src/utils/scheduleLabel.ts`
- Test: `src/utils/scheduleLabel.test.ts`

- [ ] **Step 1: `src/types/app.ts`**——`Task` 加 `source_schedule_id`，`TaskLabel` 加 `'reminder'`，新增 `ScheduledTask` 接口

```ts
export type TaskLabel = 'bug' | 'feature' | 'optimization' | 'refactor' | 'docs' | 'other' | 'reminder';

// Task interface 内，放在 session_id 附近：
  source_schedule_id: string | null;

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
  is_operator: number;
  auto_run: number;
  schedule_type: ScheduledTaskScheduleType;
  cron_expr: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  last_task_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: `taskStatus.ts`**——`LABEL_ORDER` 与 `LABEL_META` 加 reminder

```ts
export const LABEL_ORDER: TaskLabel[] = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder'];

export const LABEL_META: Record<TaskLabel, { label: string; color: string }> = {
  // …现有 6 项不动…
  reminder: { label: '提醒', color: '#f59e0b' },
};
```

- [ ] **Step 3: `src/utils/api.js`**——`tasks` 后面追加 `scheduledTasks` 端点

```js
  // Scheduled-task endpoints — the 定时 view (schedule templates).
  scheduledTasks: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.projectPath) qs.set('projectPath', params.projectPath);
      if (params.enabled !== undefined) qs.set('enabled', String(params.enabled));
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

- [ ] **Step 4: 写失败测试 `src/utils/scheduleLabel.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleLabel } from './scheduleLabel';

const base = {
  schedule_id: 's1', title: 't', description: null, project_path: null,
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 1, auto_run: 0, timezone: 'local', next_run_at: '2026-08-14T01:00:00.000Z',
  last_run_at: null, last_task_id: null, enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

test('once schedule shows 一次性 + local time', () => {
  const label = scheduleLabel({ ...base, schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z', cron_expr: null, interval_seconds: null });
  assert.match(label, /一次性/);
  assert.match(label, /2026\/08\/14/);
});

test('interval schedule humanizes', () => {
  const label = scheduleLabel({ ...base, schedule_type: 'interval', interval_seconds: 3600, cron_expr: null, run_at: null });
  assert.equal(label, '每 1 小时');
});

test('cron daily humanizes to 每天', () => {
  const label = scheduleLabel({ ...base, schedule_type: 'cron', cron_expr: '0 9 * * *', interval_seconds: null, run_at: null });
  assert.equal(label, '每天 09:00');
});

test('unrecognized cron falls back to raw expression', () => {
  const label = scheduleLabel({ ...base, schedule_type: 'cron', cron_expr: '*/13 3 5 7 1', interval_seconds: null, run_at: null });
  assert.equal(label, '*/13 3 5 7 1');
});
```

- [ ] **Step 5: 跑测试验证失败**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsx --test src/utils/scheduleLabel.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 6: 实现 `src/utils/scheduleLabel.ts`**

```ts
import type { ScheduledTask } from '../types/app';

function fmtLocal(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `每 ${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}

const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
const WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* (\d)$/;
const HOURLY = /^(\d{1,2}) \* \* \* \*$/;

function cronHuman(expr: string): string | null {
  const m = expr.trim().split(/\s+/);
  if (m.length !== 5) return null;
  const hour = m[1], minute = m[0];
  const pad = (v: string) => v.padStart(2, '0');
  if (DAILY.test(expr)) return `每天 ${pad(hour)}:${pad(minute)}`;
  const weekly = WEEKLY.exec(expr);
  if (weekly) {
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    return `每周${days[Number(weekly[3])]} ${pad(weekly[1])}:${pad(weekly[2])}`;
  }
  if (HOURLY.test(expr)) return `每小时 ${pad(minute)} 分`;
  return null;
}

export function scheduleLabel(s: ScheduledTask): string {
  if (s.schedule_type === 'once') return `一次性 ${fmtLocal(s.run_at)}`;
  if (s.schedule_type === 'interval') return fmtInterval(s.interval_seconds ?? 0);
  return cronHuman(s.cron_expr ?? '') ?? s.cron_expr ?? '';
}

export function nextRunLabel(s: ScheduledTask): string {
  return fmtLocal(s.next_run_at);
}
```

- [ ] **Step 7: 跑测试验证通过** → **Step 8: Commit**

Run: 同 Step 5 → PASS
```bash
git add src/types/app.ts src/components/tasks/taskStatus.ts src/utils/api.js src/utils/scheduleLabel.ts src/utils/scheduleLabel.test.ts
git commit -m "feat(scheduled-tasks): types, api layer, schedule label util"
```

---

### Task 2: `useScheduledTasks` hook

**Files:**
- Create: `src/hooks/useScheduledTasks.ts`
- Modify: `src/hooks/useTasks.ts` 的 fixture（若 `Task` 加字段导致编译错，补 `source_schedule_id: null`）

- [ ] **Step 1: 实现 hook**（仿 `useTasks.ts` 结构，但订阅 `scheduled_task_upserted/deleted`）

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../utils/api';
import type { ScheduledTask } from '../types/app';

export type ScheduledTaskEvent = {
  kind?: string;
  scheduledTask?: ScheduledTask;
  scheduleId?: string;
};

export function useScheduledTasks(
  options: { projectPath?: string; enabled?: boolean } = {},
  subscribe?: (cb: (event: ScheduledTaskEvent) => void) => () => void,
) {
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.scheduledTasks.list({
        projectPath: options.projectPath,
        enabled: options.enabled,
      });
      if (!res.ok) throw new Error(`scheduledTasks.list failed: ${res.status}`);
      const data = (await res.json()) as ScheduledTask[];
      if (mounted.current) {
        setScheduledTasks(Array.isArray(data) ? data : []);
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
    return () => { mounted.current = false; };
  }, [refresh]);

  const upsert = useCallback((st: ScheduledTask) => {
    setScheduledTasks((prev) => {
      const i = prev.findIndex((s) => s.schedule_id === st.schedule_id);
      if (i === -1) return [...prev, st];
      const next = [...prev];
      next[i] = st;
      return next;
    });
  }, []);

  const remove = useCallback((scheduleId: string) => {
    setScheduledTasks((prev) => prev.filter((s) => s.schedule_id !== scheduleId));
  }, []);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.kind === 'scheduled_task_upserted' && event.scheduledTask) upsert(event.scheduledTask);
      else if (event.kind === 'scheduled_task_deleted' && event.scheduleId) remove(event.scheduleId);
      else if (event.kind === 'websocket_reconnected') void refresh();
    });
  }, [subscribe, upsert, remove, refresh]);

  return { scheduledTasks, loading, loadError, refresh, upsert, remove };
}
```

- [ ] **Step 2: 编译检查**——`source_schedule_id` 加字段后，`mkTask`/`baseTask` 等 fixture 需要补 `source_schedule_id: null`（grep 到哪个加哪个）

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsc --noEmit`
Expected: 无 `source_schedule_id` 相关错误。

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useScheduledTasks.ts src/components/tasks/TaskCard.test.tsx src/components/tasks/TaskTableView.test.tsx src/components/tasks/TaskFilterBar.test.tsx
git commit -m "feat(scheduled-tasks): useScheduledTasks hook"
```

---

### Task 3: `ScheduledTasksView` 展示组件

**Files:**
- Create: `src/components/tasks/ScheduledTasksView.tsx`
- Test: `src/components/tasks/ScheduledTasksView.test.tsx`
- Modify: `src/components/tasks/index.ts`（re-export）

- [ ] **Step 1: 写失败测试**（`renderToStaticMarkup` 纯 props 驱动）

```tsx
// src/components/tasks/ScheduledTasksView.test.tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScheduledTask } from '../../types/app';
import { ScheduledTasksView } from './ScheduledTasksView';

const mkS = (over: Partial<ScheduledTask> & { schedule_id: string }): ScheduledTask => ({
  title: '定时任务', description: null, project_path: null,
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 1, auto_run: 0, schedule_type: 'once', cron_expr: null,
  interval_seconds: null, run_at: '2026-08-14T01:00:00.000Z', timezone: 'local',
  next_run_at: '2026-08-14T01:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
  ...over,
});

test('renders schedule rows with humanized label', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScheduledTasksView, {
      scheduledTasks: [mkS({ schedule_id: 's1', title: '每日提醒' })],
      projectOptions: [],
      onToggle: () => {}, onDelete: () => {}, onRunNow: () => {}, onOpenTask: () => {},
    }),
  );
  assert.match(html, /每日提醒/);
  assert.match(html, /一次性/);
  assert.match(html, /定时/);
});

test('renders empty state', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScheduledTasksView, { scheduledTasks: [], projectOptions: [], onToggle: () => {}, onDelete: () => {}, onRunNow: () => {}, onOpenTask: () => {} }),
  );
  assert.match(html, /暂无定时任务/);
});

test('disabled schedule shows 已停用 and toggle label 启用', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScheduledTasksView, {
      scheduledTasks: [mkS({ schedule_id: 's2', enabled: 0 })],
      projectOptions: [], onToggle: () => {}, onDelete: () => {}, onRunNow: () => {}, onOpenTask: () => {},
    }),
  );
  assert.match(html, /已停用/);
  assert.match(html, /启用/);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现 `ScheduledTasksView.tsx`**（纯展示；徽标样式仿 `TaskTableView` 的表格 + `TaskCard` 的 pill）

```tsx
import type { Project, ScheduledTask } from '../../types/app';
import { LABEL_META } from './taskStatus';
import { nextRunLabel, scheduleLabel } from '../../utils/scheduleLabel';

type Props = {
  scheduledTasks: ScheduledTask[];
  projectOptions: Project[];
  onToggle: (s: ScheduledTask) => void;
  onDelete: (s: ScheduledTask) => void;
  onRunNow: (s: ScheduledTask) => void;
  onOpenTask: (taskId: string) => void;
};

export function ScheduledTasksView({ scheduledTasks, onToggle, onDelete, onRunNow, onOpenTask }: Props) {
  if (scheduledTasks.length === 0) {
    return <div className="py-12 text-center text-xs text-muted-foreground">暂无定时任务</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3 sm:px-4 sm:pb-4">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-semibold">标题</th>
            <th className="py-2 pr-3 font-semibold">调度</th>
            <th className="hidden py-2 pr-3 font-semibold sm:table-cell">下次触发</th>
            <th className="hidden py-2 pr-3 font-semibold md:table-cell">上次触发</th>
            <th className="py-2 pr-3 font-semibold">状态</th>
            <th className="py-2 text-right font-semibold">操作</th>
          </tr>
        </thead>
        <tbody>
          {scheduledTasks.map((s) => (
            <tr key={s.schedule_id} className="border-b border-border/40">
              <td className="max-w-56 py-2 pr-3">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{s.title}</span>
                  {s.auto_run === 1 && (
                    <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">自动跑</span>
                  )}
                  {s.label === 'reminder' && (
                    <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ color: LABEL_META.reminder.color, backgroundColor: `${LABEL_META.reminder.color}1a` }}>
                      {LABEL_META.reminder.label}
                    </span>
                  )}
                </div>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{scheduleLabel(s)}</td>
              <td className="hidden py-2 pr-3 text-muted-foreground sm:table-cell">{nextRunLabel(s)}</td>
              <td className="hidden py-2 pr-3 md:table-cell">
                {s.last_task_id ? (
                  <button type="button" className="text-primary hover:underline" onClick={() => onOpenTask(s.last_task_id!)}>
                    {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : '查看'}
                  </button>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </td>
              <td className="py-2 pr-3">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.enabled === 1 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                  {s.enabled === 1 ? '运行中' : '已停用'}
                </span>
              </td>
              <td className="py-2">
                <div className="flex items-center justify-end gap-1.5 text-[11px]">
                  <button type="button" className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => onRunNow(s)} title="立即触发一次（不推进调度）">
                    触发
                  </button>
                  <button type="button" className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => onToggle(s)}>
                    {s.enabled === 1 ? '停用' : '启用'}
                  </button>
                  <button type="button" className="rounded-md border border-destructive/40 px-2 py-1 text-destructive hover:bg-destructive/10" onClick={() => onDelete(s)}>
                    删除
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

> 说明：`projectOptions` 本轮仅占位（表单里用），行内项目列留空由表单下拉接管；`onOpenTask` 跳 `/task/:id`。

- [ ] **Step 4: re-export** `src/components/tasks/index.ts`

```ts
export { ScheduledTasksView } from './ScheduledTasksView';
```

- [ ] **Step 5: 跑测试验证通过** → **Step 6: Commit**

Run: 同 Step 2 → PASS
```bash
git add src/components/tasks/ScheduledTasksView.tsx src/components/tasks/ScheduledTasksView.test.tsx src/components/tasks/index.ts
git commit -m "feat(scheduled-tasks): ScheduledTasksView table"
```

---

### Task 4: `ScheduledTaskForm` 创建/编辑表单

**Files:**
- Create: `src/components/tasks/ScheduledTaskForm.tsx`
- Modify: `src/components/tasks/TaskBoard.tsx`（接入：打开表单弹窗）

- [ ] **Step 1: 实现表单组件**（受控组件；预设 tab：一次性/每天/每周/每月/间隔/cron；创建提交走 `api.scheduledTasks.create`）

```tsx
import { useMemo, useState } from 'react';
import type { Project, ScheduledTask, ScheduledTaskScheduleType } from '../../types/app';
import { api } from '../../utils/api';
import { taskFormProjects } from './projectOptions';

type Props = {
  projects: Project[];
  existing?: ScheduledTask | null;
  onClose: () => void;
  onSaved: () => void;
};

type Preset = 'once' | 'daily' | 'weekly' | 'monthly' | 'interval' | 'cron';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'once', label: '一次性' },
  { key: 'daily', label: '每天' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'interval', label: '间隔' },
  { key: 'cron', label: 'Cron' },
];

/** 从已有模板推导初始 preset（用于编辑态）。 */
function derivePreset(existing?: ScheduledTask | null): Preset {
  if (existing?.schedule_type === 'once') return 'once';
  if (existing?.schedule_type === 'interval') return 'interval';
  const expr = existing?.cron_expr ?? '';
  if (expr === '0 9 * * *') return 'daily';
  if (expr === '0 9 * * 1') return 'weekly';
  if (expr === '0 9 1 * *') return 'monthly';
  return 'cron';
}

export function ScheduledTaskForm({ projects, existing, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [projectPath, setProjectPath] = useState(existing?.project_path ?? '');
  const [autoRun, setAutoRun] = useState(existing ? existing.auto_run === 1 : true);
  const [preset, setPreset] = useState<Preset>(() => derivePreset(existing));
  const [runAt, setRunAt] = useState(existing?.run_at?.slice(0, 16) ?? '');
  const [cronExpr, setCronExpr] = useState(existing?.cron_expr ?? '0 9 * * *');
  const [intervalSeconds, setIntervalSeconds] = useState(existing?.interval_seconds ?? 86400);
  const [saving, setSaving] = useState(false);

  const scheduleType: ScheduledTaskScheduleType = useMemo(() => {
    if (preset === 'interval') return 'interval';
    if (preset === 'once') return 'once';
    return 'cron';
  }, [preset]);

  function pickPreset(key: Preset): void {
    setPreset(key);
    if (key === 'daily') setCronExpr('0 9 * * *');
    else if (key === 'weekly') setCronExpr('0 9 * * 1');
    else if (key === 'monthly') setCronExpr('0 9 1 * *');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { title, description, autoRun: autoRun ? 1 : 0 };
      if (projectPath) body.projectPath = projectPath;
      body.scheduleType = scheduleType;
      if (scheduleType === 'once') body.runAt = new Date(runAt).toISOString();
      else if (scheduleType === 'interval') body.intervalSeconds = Number(intervalSeconds);
      else body.cronExpr = cronExpr;
      if (existing) await api.scheduledTasks.update(existing.schedule_id, body);
      else await api.scheduledTasks.create(body);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{existing ? '编辑定时任务' : '新建定时任务'}</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题（触发时创建的任务标题）" className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务描述（可选）" rows={2} className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm" />
        <select value={projectPath} onChange={(e) => setProjectPath(e.target.value)} className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm">
          <option value="">🤖 Lovdex助手（工作区）</option>
          {taskFormProjects(projects).map((p) => (
            <option key={p.path} value={p.path}>{p.displayName || p.path}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} className="h-4 w-4" />
          到点自动执行（取消勾选 = 只建待办提醒）
        </label>
        <div>
          <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
            {PRESETS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`rounded-md px-2 py-1 ${preset === key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                onClick={() => pickPreset(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {preset === 'once' && (
            <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm" />
          )}
          {preset === 'interval' && (
            <div className="flex items-center gap-2">
              <input type="number" min={1} value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))} className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm" />
              <span className="text-xs text-muted-foreground">秒</span>
            </div>
          )}
          {(preset === 'daily' || preset === 'weekly' || preset === 'monthly' || preset === 'cron') && (
            <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} className="h-9 w-full rounded-md border border-border bg-muted px-2 font-mono text-sm" />
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">取消</button>
          <button type="submit" disabled={saving || !title.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">保存</button>
        </div>
      </form>
    </div>
  );
}
```

> 预设 tab 只四类进 cron 表达式：每天/每周/每月有对应默认 `0 9 * * *` 等，用户仍可手改表达式；`preset==='cron'` 时自由填写。

- [ ] **Step 2: Commit**（表单本轮只实现，TaskBoard 接线在下一任务）

```bash
git add src/components/tasks/ScheduledTaskForm.tsx
git commit -m "feat(scheduled-tasks): scheduled task form"
```

---

### Task 5: TaskBoard 第三个视图模式 + 接线

**Files:**
- Modify: `src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 扩 viewMode union + 加第三个按钮**

```tsx
  const [viewMode, setViewMode] = useLocalStorage<'board' | 'table' | 'scheduled'>('taskViewMode', 'board');
```

header 的分段控件在「表格」按钮后追加：

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
            定时
          </button>
```

`import { Clock } from 'lucide-react';`

- [ ] **Step 2: 拉定时列表 + WS 订阅**——TaskBoard 内加：

```tsx
  const { scheduledTasks, refresh: refreshScheduled } = useScheduledTasks({}, subscribe);
```

`import { useScheduledTasks } from '../../hooks/useScheduledTasks';`

- [ ] **Step 3: 表单状态 + 动作回调**

```tsx
  const [scheduledFormOpen, setScheduledFormOpen] = useState(false);
  const [editingScheduled, setEditingScheduled] = useState<ScheduledTask | null>(null);

  const handleToggleScheduled = async (s: ScheduledTask) => {
    if (s.enabled === 1) await api.scheduledTasks.disable(s.schedule_id);
    else await api.scheduledTasks.enable(s.schedule_id);
    void refreshScheduled();
  };
  const handleDeleteScheduled = async (s: ScheduledTask) => {
    if (!window.confirm(`删除定时任务「${s.title}」？已生成的任务不受影响。`)) return;
    await api.scheduledTasks.remove(s.schedule_id);
    void refreshScheduled();
  };
  const handleRunNow = async (s: ScheduledTask) => {
    await api.scheduledTasks.runNow(s.schedule_id);
    void refreshScheduled();
    void refresh();
  };
```

`import { api } from '../../utils/api'; import type { ScheduledTask } from '../../types/app';`

- [ ] **Step 4: 内容区渲染分支**——`effectiveView === 'scheduled'` 时渲染 `ScheduledTasksView`，并给「新建任务」按钮旁加「＋ 新建定时」

```tsx
          {effectiveView === 'scheduled' ? (
            <>
              <ScheduledTasksView
                scheduledTasks={scheduledTasks}
                projectOptions={projectOptions}
                onToggle={handleToggleScheduled}
                onDelete={handleDeleteScheduled}
                onRunNow={handleRunNow}
                onOpenTask={(taskId) => navigate(`/task/${taskId}`)}
              />
              {scheduledFormOpen && (
                <ScheduledTaskForm
                  projects={projects}
                  existing={editingScheduled}
                  onClose={() => { setScheduledFormOpen(false); setEditingScheduled(null); }}
                  onSaved={() => { void refreshScheduled(); }}
                />
              )}
            </>
          ) : effectiveView === 'table' ? (
            // …现有 TaskTableView 分支不动…
          ) : (
            // …现有 board 分支不动…
          )}
```

header 新建区追加定时按钮：

```tsx
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" className="h-8 px-3 text-sm" onClick={() => { setEditingScheduled(null); setScheduledFormOpen(true); }}>
              ＋ 新建定时
            </Button>
            <Button size="sm" className="h-8 px-3 text-sm" onClick={openCreateForm} disabled={creating}>＋ 新建任务</Button>
          </div>
```

- [ ] **Step 5: 类型/编译检查 + 手动冒烟**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsc --noEmit`
Expected: 无错误。

手动：起后端（`AUTH_ENABLED=false`）与前端，任务页切「定时」tab，能建一条「一次性」定时任务、列表出现、停用/删除可用；「看板」tab 无回归。

- [ ] **Step 6: Commit**

```bash
git add src/components/tasks/TaskBoard.tsx
git commit -m "feat(scheduled-tasks): task board scheduled view"
```

---

### Task 6: 任务卡/详情 ⏰ 定时徽标

**Files:**
- Modify: `src/components/tasks/TaskCard.tsx`
- Modify: `src/components/tasks/TaskDetail.tsx`
- Test: `src/components/tasks/TaskCard.test.tsx`（补一条）

- [ ] **Step 1: TaskCard 顶部标签条加徽标**（放在 label pill 前）

```tsx
        {task.source_schedule_id && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-600 dark:text-amber-400" title="来自定时任务">
            ⏰ 定时
          </span>
        )}
```

- [ ] **Step 2: TaskDetail 标题旁加徽标**（仿 `🤖 Lovdex助手` pill 位置）

```tsx
            {task.source_schedule_id && (
              <span className="mt-1 inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                ⏰ 定时
              </span>
            )}
```

- [ ] **Step 3: 补测试**（TaskCard.test.tsx 内）

```tsx
test('card shows ⏰ 定时 badge when source_schedule_id set', () => {
  const html = render(mkTask({ task_id: 'sched1', source_schedule_id: 'sc1' }));
  assert.match(html, /⏰ 定时/);
});
```

（`mkTask` 或 `baseTask` fixture 补 `source_schedule_id: null`。）

- [ ] **Step 4: 跑测试验证通过**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsx --test src/components/tasks/TaskCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/TaskCard.tsx src/components/tasks/TaskDetail.tsx src/components/tasks/TaskCard.test.tsx
git commit -m "feat(scheduled-tasks): ⏰ 定时 badge on task card/detail"
```

---

### Task 7: 全量回归 + 推送

- [ ] **Step 1: 跑前端全部测试**

Run: `unset TSX_TSCONFIG_PATH && cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsx --test src/**/*.test.ts src/**/*.test.tsx`
Expected: 全绿。

- [ ] **Step 2: 手动端到端冒烟**（需后端已部署 Task 8/9 的分支）

- 任务页「定时」tab：建一条「每天 09:00」auto_run=0 定时任务 → 列表显示 `每天 09:00` + 下次触发。
- 后端 `run-now`（或等到点）→ 任务板出现 `source_schedule_id` 非空的任务，卡片显示 `⏰ 定时`，点开详情同样显示。
- 停用/启用、删除即时反映；WS 断开重连后列表刷新。

- [ ] **Step 3: 推送分支**

按用户习惯：`feat/scheduled-tasks-frontend` → fast-forward 合入 main → push。**先 `git -C /mnt/b/workdir/github/lovdex/lovdex-cli status` 确认无并发改动。**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git checkout -b feat/scheduled-tasks-frontend
git add -A && git commit -m "feat(scheduled-tasks): frontend scheduled view"
git checkout main && git merge --ff-only feat/scheduled-tasks-frontend && git push origin main
```
