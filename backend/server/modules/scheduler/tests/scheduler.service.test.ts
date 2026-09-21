// server/modules/scheduler/tests/scheduler.service.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNext, createSchedulerService, isRunActive, type SchedulerDeps } from '@/modules/scheduler/services/scheduler.service.js';
import type { ScheduledTaskDbLike } from '@/modules/scheduler/services/scheduled-task-db-like.js';
import type { TasksService } from '@/modules/tasks/services/tasks.service.js';
import type { ScheduledTaskRow } from '@/shared/types.js';

type CreateScheduledTaskInput = Parameters<ScheduledTaskDbLike['createScheduledTask']>[0];
type CreateTaskInput = Parameters<TasksService['createTask']>[0];

function mkRow(over: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    schedule_id: 's1', title: 't', description: null, project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, auto_approve: 0, schedule_type: 'once', cron_expr: null,
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

test('isRunActive: 只把「进行中且没跑挂」当作上一轮没结束', () => {
  // 跑着 / 等你回答 / 等你确认计划 / 等你批准 / 以及各种还没走完的持久标签 —— 都挡
  for (const sub of ['running', 'waiting_answer', 'waiting_plan', 'waiting_approval', 'blocked', 'only_plan', 'needs_review'] as const) {
    assert.equal(isRunActive({ status: 'in_progress', sub_status: sub }), true, `in_progress + ${sub} 必须挡`);
  }
  // decorate() 对「在跑但没标签」的行给的就是 null
  assert.equal(isRunActive({ status: 'in_progress', sub_status: null }), true, 'in_progress + null 必须挡');
  // failed 是唯一明确的「上一轮已经终止、可以重来」
  assert.equal(isRunActive({ status: 'in_progress', sub_status: 'failed' }), false, '跑挂的必须放行');
  // 不在进行中列的一律不挡
  for (const status of ['todo', 'in_review', 'done', 'archived'] as const) {
    assert.equal(isRunActive({ status, sub_status: null }), false, `${status} 不该挡`);
  }
  assert.equal(isRunActive(null), false, '查不到上一轮任务时不挡');
});

function makeService(nowIso: string, extra: Partial<SchedulerDeps> = {}) {
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
        auto_approve: i.autoApprove ? 1 : 0,
        timezone: i.timezone,
        next_run_at: i.nextRunAt,
      });
      rows.set('new', row); return row;
    },
    getScheduledTask: (id: string) => rows.get(id) ?? null,
    listScheduledTasks: () => [...rows.values()],
    updateScheduledTask: (id: string, u: Record<string, unknown>) => {
      const cur = rows.get(id); if (!cur) return null;
      // 与真实 scheduled-tasks.db 对齐：布尔列走 allowed 白名单落库为 0/1，不保留 true/false
      const normalized = { ...u };
      for (const col of ['is_operator', 'auto_run', 'auto_approve', 'enabled']) {
        if (col in normalized) normalized[col] = normalized[col] ? 1 : 0;
      }
      const next = { ...cur, ...normalized } as ScheduledTaskRow; rows.set(id, next); return next;
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
    ...extra,
  });
  return { svc, rows, createdTasks, launches, broadcasts };
}

test('tick dispatches once + auto-run, auto-disables once, skips auto_run=0', async () => {
  const { svc, rows, createdTasks, launches, broadcasts } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('due-once', mkRow({ schedule_id: 'due-once', run_at: '2026-08-13T00:00:00.000Z', next_run_at: '2026-08-13T00:00:00.000Z' }));
  rows.set('due-remind', mkRow({ schedule_id: 'due-remind', auto_run: 0, schedule_type: 'interval', interval_seconds: 3600, next_run_at: '2026-08-13T11:00:00.000Z' }));

  await svc.tickNow();

  assert.equal(createdTasks.length, 2);
  assert.equal((createdTasks[0] as { sourceScheduleId?: string }).sourceScheduleId, 'due-once');
  assert.equal(rows.get('due-once')?.enabled, 0); // once 触发后停用
  assert.equal(rows.get('due-once')?.last_task_id, 'task-1');
  assert.deepEqual(launches, [{ taskId: 'task-1', sessionId: 'sess-1' }]); // 只有 auto_run=1 启动
  assert.ok(broadcasts.some((e) => (e as { kind?: string }).kind === 'scheduled_task_upserted'));
});

test('reconcileMissedRuns creates one reminder task and advances next_run_at without re-dispatch', async () => {
  const { svc, rows, createdTasks } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('missed', mkRow({ schedule_id: 'missed', schedule_type: 'interval', interval_seconds: 3600, next_run_at: '2026-08-13T10:00:00.000Z' }));
  rows.set('ok', mkRow({ schedule_id: 'ok', schedule_type: 'cron', cron_expr: '0 9 * * *', next_run_at: '2026-08-14T09:00:00.000Z' }));

  await svc.reconcileMissedRuns();

  assert.equal(createdTasks.length, 1); // 只聚合一条提醒任务
  assert.equal((createdTasks[0] as { label?: string }).label, 'reminder');
  // interval 固定相位推进到未来：10:00 + 时机 → 13:00
  assert.equal(rows.get('missed')?.next_run_at, '2026-08-13T13:00:00.000Z');
  assert.equal(rows.get('ok')?.next_run_at, '2026-08-14T09:00:00.000Z'); // 未被触碰
});

test('create validates scheduleType and computes initial next_run_at', async () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');
  const row = await svc.create({ title: 't', scheduleType: 'cron', cronExpr: '0 9 * * *' }) as ScheduledTaskRow;
  assert.equal(rows.has(row.schedule_id), true);
  // 未显式 timezone → 默认 local（服务器本地时区），同 computeNext 语义
  assert.equal(row.next_run_at, new Date(2026, 7, 14, 9, 0, 0).toISOString());
  await assert.rejects(() => svc.create({ title: 'bad', scheduleType: 'once' }));
});

test('update translates camelCase to snake_case and recomputes next_run_at', async () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('s1', mkRow({ schedule_id: 's1', schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' }));

  const row = await svc.update('s1', { scheduleType: 'cron', cronExpr: '0 9 * * *', autoRun: 0 }) as ScheduledTaskRow;

  assert.equal(rows.get('s1')?.schedule_type, 'cron');
  assert.equal(rows.get('s1')?.cron_expr, '0 9 * * *');
  assert.equal(rows.get('s1')?.auto_run, 0);
  assert.ok(row.next_run_at);
  assert.notEqual(row.next_run_at, '2026-08-13T00:00:00.000Z');
  assert.ok(Number.isFinite(new Date(row.next_run_at).getTime()));
  // cron 取下一个 09:00（默认 local → 本地挂钟 09:00 的 UTC 表示）
  assert.equal(row.next_run_at, new Date(2026, 7, 14, 9, 0, 0).toISOString());
});

test('create: a blank title is generated from the description', async () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async ({ description }) => `取自：${description}`,
    titleBlockingMs: 50,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { title: string };
  assert.equal(row.title, '取自：每天汇总提交记录');
  assert.equal(rows.get('new')?.title, '取自：每天汇总提交记录');
});

test('create: a provided title never reaches the model', async () => {
  let calls = 0;
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async () => { calls += 1; return '模型取的名'; },
    titleBlockingMs: 50,
  });
  const row = await svc.create({
    title: '我自己的名字', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { title: string };
  assert.equal(row.title, '我自己的名字');
  assert.equal(calls, 0);
});

test('create: a model that misses the window writes the title back later and rebroadcasts', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows, broadcasts } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string; title: string };
  // 阻塞窗口内没等到模型 → 先落描述首行
  assert.equal(row.title, '每天汇总提交记录');
  const before = broadcasts.length;

  release('每日提交汇总');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rows.get(row.schedule_id)?.title, '每日提交汇总');
  const after = broadcasts.slice(before);
  assert.equal(after.length, 1);
  assert.equal((after[0] as { kind: string }).kind, 'scheduled_task_upserted');
});

test('write-back yields when the user renamed the template in the meantime', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  rows.set(row.schedule_id, { ...rows.get(row.schedule_id)!, title: '用户改的名字' });

  release('模型取的名');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rows.get(row.schedule_id)?.title, '用户改的名字');
});

test('write-back never throws when the row was deleted mid-flight', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  const row = await svc.create({
    title: '', description: '每天汇总提交记录', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  rows.delete(row.schedule_id);

  release('模型取的名');
  await new Promise((r) => setTimeout(r, 0));
  // 没有 unhandledRejection 就是通过 —— 上面这行 await 之后进程还活着
});

test('update: a blank title regenerates from the description', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async ({ description }) => `取自：${description}`,
    titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { title: '', description: '新描述' }) as { title: string };
  assert.equal(updated.title, '取自：新描述');
});

test('update: a blank title with no new description falls back to the stored description', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async ({ description }) => `取自：${description}`,
    titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { title: '' }) as { title: string };
  assert.equal(updated.title, '取自：旧描述');
});

test('update: omitting the title leaves it untouched', async () => {
  let calls = 0;
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async () => { calls += 1; return '不该被调用'; },
    titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { priority: 'P0' }) as { title: string };
  assert.equal(updated.title, '旧名字');
  assert.equal(calls, 0);
});

test('update: a model that misses the window writes the title back later and rebroadcasts', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows, broadcasts } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  // create 传了非空标题 → 不触发取名，gate 只留给 update 挂住。
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { title: '' }) as { title: string };
  // 阻塞窗口内没等到模型 → 先落描述首行
  assert.equal(updated.title, '旧描述');
  const before = broadcasts.length;

  release('模型取的名');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rows.get(created.schedule_id)?.title, '模型取的名');
  const after = broadcasts.slice(before);
  assert.equal(after.length, 1);
  assert.equal((after[0] as { kind: string }).kind, 'scheduled_task_upserted');
});

test('update: write-back yields when the user renamed the template in the meantime', async () => {
  let release: (v: string | null) => void = () => {};
  const gate = new Promise<string | null>((r) => { release = r; });
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: () => gate,
    titleBlockingMs: 10,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, { title: '' }) as { title: string };
  assert.equal(updated.title, '旧描述');
  rows.set(created.schedule_id, { ...rows.get(created.schedule_id)!, title: '用户改的名字' });

  release('模型取的名');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rows.get(created.schedule_id)?.title, '用户改的名字');
});

/**
 * 回归：前端 toApiBody 对不匹配当前调度类型的字段总是发 null（不是 undefined），
 * 而 update 的校验曾把 null 当非法类型 → 从 UI 编辑任何定时任务都 400。
 * 这三个用例刻意用**完整 toApiBody 形状**的 body，而不是部分字段。
 */
function toApiBodyShape(d: {
  title: string; description: string; scheduleType: string;
  cronExpr?: string; intervalSeconds?: number; runAt?: string;
}) {
  return {
    title: d.title,
    description: d.description || null,
    projectPath: null,
    executorProvider: 'claude',
    priority: 'P2',
    label: 'other',
    autoRun: 1,
    scheduleType: d.scheduleType,
    cronExpr: d.scheduleType === 'cron' ? (d.cronExpr ?? '') : null,
    intervalSeconds: d.scheduleType === 'interval' ? Number(d.intervalSeconds ?? 0) : null,
    runAt: d.scheduleType === 'once' ? (d.runAt ? new Date(d.runAt).toISOString() : null) : null,
  };
}

test('update: a full toApiBody-shaped body is accepted for a once schedule', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async () => 'AI 取的名', titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, toApiBodyShape({
    title: '', description: '每天汇总', scheduleType: 'once', runAt: '2026-08-14T09:00:00.000Z',
  })) as { title: string };
  assert.equal(updated.title, 'AI 取的名');
});

test('update: a full toApiBody-shaped body is accepted for an interval schedule', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async () => 'AI 取的名', titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, toApiBodyShape({
    title: '手填', description: '每天汇总', scheduleType: 'interval', intervalSeconds: 3600,
  })) as { title: string };
  assert.equal(updated.title, '手填');
});

test('update: a full toApiBody-shaped body is accepted for a cron schedule', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z', {
    generateTitle: async () => 'AI 取的名', titleBlockingMs: 50,
  });
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  const updated = await svc.update(created.schedule_id, toApiBodyShape({
    title: '手填', description: '每天汇总', scheduleType: 'cron', cronExpr: '0 9 * * *',
  })) as { title: string };
  assert.equal(updated.title, '手填');
});

/**
 * 放行 null 不能把类型校验也放水：真正的错误类型（非 null）仍必须 400。
 */
test('update: still rejects non-null wrong types with 400', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  const created = await svc.create({
    title: '旧名字', description: '旧描述', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };
  await assert.rejects(
    () => svc.update(created.schedule_id, { cronExpr: 123 }),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 400
      && /cronExpr must be a string/.test((err as Error).message),
  );
  await assert.rejects(
    () => svc.update(created.schedule_id, { intervalSeconds: 'nope' }),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 400
 && /intervalSeconds must be a number/.test((err as Error).message),
  );
await assert.rejects(
    () => svc.update(created.schedule_id, { runAt: 42 }),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 400
      && /runAt must be a string/.test((err as Error).message),
  );
});

/**
 * 加固：interval_seconds <= 0 会让 computeNext 的 `while (next <= now) next += stepMs`
 * 永不终止，而 tick 的重入守卫会让整个调度器从此不再触发任何任务（无日志无告警）；
 * 空的 cron_expr 会让 computeNext 走 `return now.toISOString()`，该任务每 15 秒触发一次。
 * 前端已保证取值范围，这里防的是绕过前端的调用方。
 */
test('create: a non-positive interval is rejected instead of hanging the scheduler', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  for (const intervalSeconds of [0, -60]) {
    await assert.rejects(
      () => svc.create({ title: 't', scheduleType: 'interval', intervalSeconds }),
      (e: { statusCode?: number; code?: string }) => e.statusCode === 400 && e.code === 'INVALID_SCHEDULE',
      `expected 400 for intervalSeconds=${intervalSeconds}`,
    );
  }
});

test('create: a non-finite interval is rejected instead of 500ing', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  for (const intervalSeconds of [Number.POSITIVE_INFINITY, Number.NaN]) {
    await assert.rejects(
      () => svc.create({ title: 't', scheduleType: 'interval', intervalSeconds }),
      (e: { statusCode?: number; code?: string }) => e.statusCode === 400 && e.code === 'INVALID_SCHEDULE',
      `expected 400 for intervalSeconds=${intervalSeconds}`,
    );
  }
});

test('create: a blank cron expression is rejected instead of firing every 15s', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  for (const cronExpr of ['', '   ']) {
    await assert.rejects(
      () => svc.create({ title: 't', scheduleType: 'cron', cronExpr }),
      (e: { statusCode?: number; code?: string }) => e.statusCode === 400 && e.code === 'INVALID_SCHEDULE',
      `expected 400 for cronExpr=${JSON.stringify(cronExpr)}`,
    );
  }
});

test('update: a dangerous value is caught even when it comes from the merge', async () => {
  // 只改部分字段时，危险值可能来自「新传的」与「库里现有的」的组合 ——
  // 所以必须校验**将要落库的形状**，而不是只看 updates。
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  const created = await svc.create({
    title: 't', scheduleType: 'cron', cronExpr: '0 9 * * *', runAt: '2026-08-14T01:00:00.000Z',
  }) as { schedule_id: string };

  // 库里本来是合法 cron，只把表达式清空
  await assert.rejects(
    () => svc.update(created.schedule_id, { cronExpr: '' }),
    (e: { statusCode?: number; code?: string }) => e.statusCode === 400 && e.code === 'INVALID_SCHEDULE',
  );
  // 把类型切成 interval 但给 0 秒
  await assert.rejects(
    () => svc.update(created.schedule_id, { scheduleType: 'interval', intervalSeconds: 0 }),
    (e: { statusCode?: number; code?: string }) => e.statusCode === 400 && e.code === 'INVALID_SCHEDULE',
  );
  // 合法值仍然放行
  const ok = await svc.update(created.schedule_id, { scheduleType: 'interval', intervalSeconds: 60 }) as { interval_seconds: number };
  assert.equal(ok.interval_seconds, 60);
});

test('create: the boundary values are still accepted', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  // 1 秒是下界，必须放行（前端不会产生，但 API 直调合法）
  const row = await svc.create({ title: 't', scheduleType: 'interval', intervalSeconds: 1 }) as { interval_seconds: number };
  assert.equal(row.interval_seconds, 1);
});

test('update: a legacy row with a broken schedule is surfaced instead of silently kept', async () => {
  // 守卫只保护新写入。库里若已有守卫上线前的坏行（interval_seconds <= 0），
  // 现在连「只改标题」的 PATCH 也会 400 —— 逼调用方先修数据，而不是让它
  // 继续躺在库里等着把 tick 卡死。这是有意的取舍，钉住它。
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('legacy', mkRow({ schedule_id: 'legacy', schedule_type: 'interval', interval_seconds: 0 }));
  await assert.rejects(
    () => svc.update('legacy', { title: '只改标题' }),
    (e: { statusCode?: number; code?: string }) => e.statusCode === 400 && e.code === 'INVALID_SCHEDULE',
  );
});

test('dispatch mirrors auto_approve from the schedule onto the task', async () => {
  const { svc, rows, createdTasks } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('flagged', mkRow({
    schedule_id: 'flagged',
    auto_approve: 1,
    run_at: '2026-08-13T00:00:00.000Z',
    next_run_at: '2026-08-13T00:00:00.000Z',
  }));
  rows.set('plain', mkRow({
    schedule_id: 'plain',
    auto_approve: 0,
    run_at: '2026-08-13T00:00:00.000Z',
    next_run_at: '2026-08-13T00:00:00.000Z',
  }));

  await svc.tickNow();

  assert.equal(createdTasks.length, 2);
  const flagged = createdTasks.find((t) => (t as { sourceScheduleId?: string }).sourceScheduleId === 'flagged');
  const plain = createdTasks.find((t) => (t as { sourceScheduleId?: string }).sourceScheduleId === 'plain');
  assert.equal((flagged as { autoApprove?: boolean }).autoApprove, true, 'the flag must reach the task row');
  assert.equal((plain as { autoApprove?: boolean }).autoApprove, false, 'an unflagged schedule must not auto-approve');
});

test('create defaults auto_approve to false and honours an explicit true', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');

  const plain = await svc.create({ title: 'a', scheduleType: 'cron', cronExpr: '0 9 * * *' }) as ScheduledTaskRow;
  assert.equal(plain.auto_approve, 0);

  const flagged = await svc.create({
    title: 'b',
    scheduleType: 'cron',
    cronExpr: '0 9 * * *',
    autoApprove: true,
  }) as ScheduledTaskRow;
  assert.equal(flagged.auto_approve, 1);
});

/**
 * 仓储声明的入参是 `boolean | 0 | 1`，服务层若只认 `=== true`，走数字惯例的调用方
 * 会静默落成 0 —— 用户勾了框、定时任务存下了，却什么都没自动放行，而这是无人值守
 * 审批的开关，静默失效是最坏的结果。数字形态单独钉住。
 */
test('create accepts the numeric autoApprove form the repository declares', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');

  const numeric = await svc.create({
    title: 'a', scheduleType: 'cron', cronExpr: '0 9 * * *', autoApprove: 1,
  }) as ScheduledTaskRow;
  assert.equal(numeric.auto_approve, 1);

  const zero = await svc.create({
    title: 'b', scheduleType: 'cron', cronExpr: '0 9 * * *', autoApprove: 0,
  }) as ScheduledTaskRow;
  assert.equal(zero.auto_approve, 0);

  // 放行数字形态不等于放水：杂值绝不能打开无人值守审批。
  for (const junk of ['false', 'true', 2, {}]) {
    const row = await svc.create({
      title: 'c', scheduleType: 'cron', cronExpr: '0 9 * * *', autoApprove: junk,
    }) as ScheduledTaskRow;
    assert.equal(row.auto_approve, 0, `expected auto_approve=0 for ${JSON.stringify(junk)}`);
  }
});

test('update accepts autoApprove and maps it to the auto_approve column', async () => {
  const { svc } = makeService('2026-08-13T12:00:00.000Z');
  const row = await svc.create({ title: 'a', scheduleType: 'cron', cronExpr: '0 9 * * *' }) as ScheduledTaskRow;

  const updated = await svc.update(row.schedule_id, { autoApprove: true }) as ScheduledTaskRow;
  assert.equal(updated.auto_approve, 1);
});
