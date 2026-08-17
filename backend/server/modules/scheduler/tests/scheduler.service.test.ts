// server/modules/scheduler/tests/scheduler.service.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNext, createSchedulerService } from '@/modules/scheduler/services/scheduler.service.js';
import type { ScheduledTaskDbLike } from '@/modules/scheduler/services/scheduled-task-db-like.js';
import type { TasksService } from '@/modules/tasks/services/tasks.service.js';
import type { ScheduledTaskRow } from '@/shared/types.js';

type CreateScheduledTaskInput = Parameters<ScheduledTaskDbLike['createScheduledTask']>[0];
type CreateTaskInput = Parameters<TasksService['createTask']>[0];

function mkRow(over: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    schedule_id: 's1', title: 't', description: null, project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, schedule_type: 'once', cron_expr: null,
    interval_seconds: null, run_at: null, timezone: 'local',
    next_run_at: '2026-08-13T00:00:00.000Z', last_run_at: null, last_task_id: null,
    enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}

test('computeNext: once returns run_at; interval preserves phase; cron advances', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');
  // once → 固定 run_at
  assert.equal(
    computeNext(mkRow({ schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' }), now, now),
    '2026-08-14T01:00:00.000Z',
  );
  // interval 固定相位：从 08:00 每 1h，推进到第一个 > 12:00 → 13:00
  const from = new Date('2026-08-13T08:00:00.000Z');
  assert.equal(
    computeNext(mkRow({ schedule_type: 'interval', interval_seconds: 3600 }), from, now),
    '2026-08-13T13:00:00.000Z',
  );
  // cron 取下一个 09:00（Asia/Shanghai = UTC+8 → 01:00Z）。显式 IANA 时区 → 确定性断言。
  assert.equal(
    computeNext(mkRow({ schedule_type: 'cron', cron_expr: '0 9 * * *', timezone: 'Asia/Shanghai' }), now, now),
    '2026-08-14T01:00:00.000Z',
  );
  // timezone='local'（默认）按服务器本地时区：结果 = 本地挂钟 09:00 的 UTC 表示，与机器时区无关。
  const localCron = computeNext(mkRow({ schedule_type: 'cron', cron_expr: '0 9 * * *' }), now, now);
  assert.equal(localCron, new Date(2026, 7, 14, 9, 0, 0).toISOString());
});

function makeService(nowIso: string) {
  const rows = new Map<string, ScheduledTaskRow>();
  const createdTasks: unknown[] = [];
  const launches: Array<{ taskId: string; sessionId: string }> = [];
  const broadcasts: unknown[] = [];
  const db = {
    operatorWorkspacePath: '/op-ws',
    createScheduledTask: (i: CreateScheduledTaskInput) => {
      // 与真实 scheduled-tasks.db 对齐：调用方传 camelCase，落到行的 snake 字段
      const row = mkRow({
        schedule_id: 'new',
        title: i.title,
        description: i.description ?? null,
        project_path: i.projectPath ?? null,
        schedule_type: i.scheduleType,
        cron_expr: i.cronExpr ?? null,
        interval_seconds: i.intervalSeconds ?? null,
        run_at: i.runAt ?? null,
        timezone: i.timezone,
        next_run_at: i.nextRunAt,
      });
      rows.set('new', row); return row;
    },
    getScheduledTask: (id: string) => rows.get(id) ?? null,
    listScheduledTasks: () => [...rows.values()],
    updateScheduledTask: (id: string, u: Record<string, unknown>) => {
      const cur = rows.get(id); if (!cur) return null;
      const next = { ...cur, ...u } as ScheduledTaskRow; rows.set(id, next); return next;
    },
    deleteScheduledTask: (id: string) => { rows.delete(id); },
    listDueScheduledTasks: (n: string) => [...rows.values()].filter((s) => s.enabled === 1 && s.next_run_at <= n),
    listMissedSince: (n: string) => [...rows.values()].filter((s) => s.enabled === 1 && s.next_run_at < n),
  };
  const svc = createSchedulerService({
    scheduledTasksDb: db,
    tasksService: {
      createTask: (input: CreateTaskInput) => {
        createdTasks.push(input);
        return { task_id: 'task-1' } as unknown as ReturnType<TasksService['createTask']>;
      },
      startExecution: () => ({ sessionId: 'sess-1' }),
    },
    createSession: () => 'sess-1',
    startTaskRun: (taskId: string, sessionId: string) => { launches.push({ taskId, sessionId }); return true; },
    broadcast: (e: unknown) => broadcasts.push(e),
    now: () => new Date(nowIso),
  });
  return { svc, rows, createdTasks, launches, broadcasts };
}

test('tick dispatches once + auto-run, auto-disables once, skips auto_run=0', () => {
  const { svc, rows, createdTasks, launches, broadcasts } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('due-once', mkRow({ schedule_id: 'due-once', run_at: '2026-08-13T00:00:00.000Z', next_run_at: '2026-08-13T00:00:00.000Z' }));
  rows.set('due-remind', mkRow({ schedule_id: 'due-remind', auto_run: 0, schedule_type: 'interval', interval_seconds: 3600, next_run_at: '2026-08-13T11:00:00.000Z' }));

  svc.tickNow();

  assert.equal(createdTasks.length, 2);
  assert.equal((createdTasks[0] as { sourceScheduleId?: string }).sourceScheduleId, 'due-once');
  assert.equal(rows.get('due-once')?.enabled, 0); // once 触发后停用
  assert.equal(rows.get('due-once')?.last_task_id, 'task-1');
  assert.deepEqual(launches, [{ taskId: 'task-1', sessionId: 'sess-1' }]); // 只有 auto_run=1 启动
  assert.ok(broadcasts.some((e) => (e as { kind?: string }).kind === 'scheduled_task_upserted'));
});

test('reconcileMissedRuns creates one reminder task and advances next_run_at without re-dispatch', () => {
  const { svc, rows, createdTasks } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('missed', mkRow({ schedule_id: 'missed', schedule_type: 'interval', interval_seconds: 3600, next_run_at: '2026-08-13T10:00:00.000Z' }));
  rows.set('ok', mkRow({ schedule_id: 'ok', schedule_type: 'cron', cron_expr: '0 9 * * *', next_run_at: '2026-08-14T09:00:00.000Z' }));

  svc.reconcileMissedRuns();

  assert.equal(createdTasks.length, 1); // 只聚合一条提醒任务
  assert.equal((createdTasks[0] as { label?: string }).label, 'reminder');
  // interval 固定相位推进到未来：10:00 + 时机 → 13:00
  assert.equal(rows.get('missed')?.next_run_at, '2026-08-13T13:00:00.000Z');
  assert.equal(rows.get('ok')?.next_run_at, '2026-08-14T09:00:00.000Z'); // 未被触碰
});

test('create validates scheduleType and computes initial next_run_at', () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');
  const row = svc.create({ title: 't', scheduleType: 'cron', cronExpr: '0 9 * * *' }) as ScheduledTaskRow;
  assert.equal(rows.has(row.schedule_id), true);
  // 未显式 timezone → 默认 local（服务器本地时区），同 computeNext 语义
  assert.equal(row.next_run_at, new Date(2026, 7, 14, 9, 0, 0).toISOString());
  assert.throws(() => svc.create({ title: 'bad', scheduleType: 'once' }));
});

test('update translates camelCase to snake_case and recomputes next_run_at', () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('s1', mkRow({ schedule_id: 's1', schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' }));

  const row = svc.update('s1', { scheduleType: 'cron', cronExpr: '0 9 * * *', autoRun: 0 }) as ScheduledTaskRow;

  assert.equal(rows.get('s1')?.schedule_type, 'cron');
  assert.equal(rows.get('s1')?.cron_expr, '0 9 * * *');
  assert.equal(rows.get('s1')?.auto_run, 0);
  assert.ok(row.next_run_at);
  assert.notEqual(row.next_run_at, '2026-08-13T00:00:00.000Z');
  assert.ok(Number.isFinite(new Date(row.next_run_at).getTime()));
  // cron 取下一个 09:00（默认 local → 本地挂钟 09:00 的 UTC 表示）
  assert.equal(row.next_run_at, new Date(2026, 7, 14, 9, 0, 0).toISOString());
});