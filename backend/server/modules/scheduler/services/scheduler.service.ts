import { Cron } from 'croner';

import { isScheduleType } from '@/modules/database/repositories/scheduled-tasks.db.js';
import type { TasksService } from '@/modules/tasks/services/tasks.service.js';
import { AppError } from '@/shared/utils.js';
import type { ScheduledTaskRow, TaskEngine } from '@/shared/types.js';
import type { ScheduledTaskDbLike } from './scheduled-task-db-like.js';

export type SchedulerDeps = {
  scheduledTasksDb: ScheduledTaskDbLike;
  tasksService: Pick<TasksService, 'createTask' | 'startExecution'>;
  createSession: (provider: TaskEngine, projectPath: string, isOperator?: boolean) => string;
  startTaskRun: (taskId: string, sessionId: string) => boolean;
  broadcast: (event: { kind: string; [k: string]: unknown }) => void;
  now?: () => Date;
};

/**
 * 触发后的 next_run_at：
 * - once：固定 run_at（触发即终，调用方负责 enabled=0）
 * - interval：固定相位——从 store 里的 next_run_at 推进，避免漂移
 * - cron：croner 的下一时刻
 */
export function computeNext(schedule: ScheduledTaskRow, from: Date, now: Date): string {
  switch (schedule.schedule_type) {
    case 'once':
      return schedule.run_at ?? from.toISOString();
    case 'interval': {
      const stepMs = (schedule.interval_seconds ?? 0) * 1000;
      let next = from.getTime();
      while (next <= now.getTime()) next += stepMs;
      return new Date(next).toISOString();
    }
    case 'cron': {
      if (!schedule.cron_expr) return now.toISOString();
      const tz = schedule.timezone === 'local' ? undefined : schedule.timezone;
      return (new Cron(schedule.cron_expr, { timezone: tz }).nextRun(from) ?? now).toISOString();
    }
    default:
      return now.toISOString();
  }
}

/** 创建/编辑后的首轮 next_run_at（从 now 起，interval 重定相位）。 */
export function initialNextRun(
  input: { scheduleType: string; cronExpr?: string | null; intervalSeconds?: number | null; runAt?: string | null; timezone?: string },
  now: Date,
): string {
  switch (input.scheduleType) {
    case 'once':
      return input.runAt ?? now.toISOString();
    case 'interval':
      return new Date(now.getTime() + (input.intervalSeconds ?? 0) * 1000).toISOString();
    case 'cron': {
      if (!input.cronExpr) return now.toISOString();
      const tz = input.timezone === 'local' ? undefined : input.timezone;
      return (new Cron(input.cronExpr, { timezone: tz }).nextRun(now) ?? now).toISOString();
    }
    default:
      return now.toISOString();
  }
}

export function createSchedulerService(deps: SchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function dispatch(schedule: ScheduledTaskRow): void {
    const projectPath = schedule.project_path ?? deps.scheduledTasksDb.operatorWorkspacePath;
    const task = deps.tasksService.createTask({
      projectPath,
      title: schedule.title,
      description: schedule.description,
      executorProvider: schedule.executor_provider as TaskEngine,
      executorModel: schedule.executor_model,
      priority: schedule.priority as 'P0' | 'P1' | 'P2' | 'P3',
      label: schedule.label as never,
      isOperator: schedule.is_operator === 1,
      sourceScheduleId: schedule.schedule_id,
    });
    if (task && schedule.auto_run === 1) {
      try {
        const started = deps.tasksService.startExecution(task.task_id, deps.createSession);
        if (started?.sessionId) deps.startTaskRun(task.task_id, started.sessionId);
      } catch (error) {
        console.error('[scheduler] auto-run dispatch failed', error instanceof Error ? error.message : error);
      }
    }
    const firedAt = now();
    const updates: Record<string, unknown> = {
      last_run_at: firedAt.toISOString(),
      last_task_id: task?.task_id ?? null,
      next_run_at: computeNext(schedule, new Date(schedule.next_run_at), firedAt),
    };
    if (schedule.schedule_type === 'once') updates.enabled = 0;
    const updated = deps.scheduledTasksDb.updateScheduledTask(schedule.schedule_id, updates);
    deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: updated ?? schedule, timestamp: firedAt.toISOString() });
    deps.broadcast({ kind: 'task_upserted', task, actor: 'engine', timestamp: firedAt.toISOString() });
  }

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      for (const schedule of deps.scheduledTasksDb.listDueScheduledTasks(now().toISOString())) {
        try {
          dispatch(schedule);
        } catch (error) {
          console.error('[scheduler] tick dispatch failed', error instanceof Error ? error.message : error);
        }
      }
    } finally {
      ticking = false;
    }
  }

  /** 启动时：停机错过不补跑，聚合成一条 reminder 任务，推进 next_run_at。 */
  function reconcileMissedRuns(): void {
    const missed = deps.scheduledTasksDb.listMissedSince(now().toISOString());
    if (missed.length === 0) return;
    const lines = missed.map((s) => `- ${s.title}（原定 ${s.next_run_at}）`);
    deps.tasksService.createTask({
      projectPath: deps.scheduledTasksDb.operatorWorkspacePath,
      title: `⏰ 错过 ${missed.length} 次定时触发`,
      description: `后端停机期间以下定时任务未触发，已跳过：\n${lines.join('\n')}`,
      executorProvider: 'claude',
      priority: 'P2',
      label: 'reminder' as never,
      isOperator: true,
    });
    for (const s of missed) {
      const firedAt = now();
      const updates: Record<string, unknown> = { next_run_at: computeNext(s, new Date(s.next_run_at), firedAt) };
      if (s.schedule_type === 'once') updates.enabled = 0;
      deps.scheduledTasksDb.updateScheduledTask(s.schedule_id, updates);
    }
  }

  function validateScheduleInput(input: Record<string, unknown>): void {
    const scheduleType = input.scheduleType;
    if (typeof scheduleType !== 'string' || !isScheduleType(scheduleType)) {
      throw new AppError(`invalid scheduleType: ${String(scheduleType)}`, { code: 'INVALID_SCHEDULE_TYPE', statusCode: 400 });
    }
    if (scheduleType === 'cron' && typeof input.cronExpr !== 'string') {
      throw new AppError('cron schedule requires cronExpr', { code: 'INVALID_SCHEDULE', statusCode: 400 });
    }
    if (scheduleType === 'interval' && typeof input.intervalSeconds !== 'number') {
      throw new AppError('interval schedule requires intervalSeconds', { code: 'INVALID_SCHEDULE', statusCode: 400 });
    }
    if (scheduleType === 'once' && typeof input.runAt !== 'string') {
      throw new AppError('once schedule requires runAt', { code: 'INVALID_SCHEDULE', statusCode: 400 });
    }
  }

  return {
    list(filter: { projectPath?: string; enabled?: boolean } = {}): unknown[] {
      return deps.scheduledTasksDb.listScheduledTasks(filter);
    },
    get(scheduleId: string): unknown {
      return deps.scheduledTasksDb.getScheduledTask(scheduleId);
    },
    create(input: Record<string, unknown>): unknown {
      validateScheduleInput(input);
      const row = deps.scheduledTasksDb.createScheduledTask({
        title: String(input.title ?? ''),
        description: typeof input.description === 'string' ? input.description : null,
        projectPath: typeof input.projectPath === 'string' && input.projectPath ? input.projectPath : null,
        executorProvider: typeof input.executorProvider === 'string' ? input.executorProvider : undefined,
        executorModel: typeof input.executorModel === 'string' ? input.executorModel : null,
        priority: typeof input.priority === 'string' ? input.priority : undefined,
        label: typeof input.label === 'string' ? input.label : undefined,
        autoRun: input.autoRun !== 0,
        scheduleType: input.scheduleType as never,
        cronExpr: typeof input.cronExpr === 'string' ? input.cronExpr : null,
        intervalSeconds: typeof input.intervalSeconds === 'number' ? input.intervalSeconds : null,
        runAt: typeof input.runAt === 'string' ? input.runAt : null,
        timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
        nextRunAt: initialNextRun(input as never, now()),
      });
      deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      return row;
    },
    update(scheduleId: string, updates: Record<string, unknown>): unknown {
      const current = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!current) return null;
      if (updates.scheduleType !== undefined && typeof updates.scheduleType === 'string' && !isScheduleType(updates.scheduleType)) {
        throw new AppError(`invalid scheduleType: ${String(updates.scheduleType)}`, { code: 'INVALID_SCHEDULE_TYPE', statusCode: 400 });
      }
      if (updates.cronExpr !== undefined && typeof updates.cronExpr !== 'string') {
        throw new AppError('cronExpr must be a string', { code: 'INVALID_SCHEDULE', statusCode: 400 });
      }
      if (updates.intervalSeconds !== undefined && typeof updates.intervalSeconds !== 'number') {
        throw new AppError('intervalSeconds must be a number', { code: 'INVALID_SCHEDULE', statusCode: 400 });
      }
      if (updates.runAt !== undefined && typeof updates.runAt !== 'string') {
        throw new AppError('runAt must be a string', { code: 'INVALID_SCHEDULE', statusCode: 400 });
      }
      // camelCase (route/frontend) → snake_case (DB), mirroring create().
      const cleaned: Record<string, unknown> = {};
      const keyMap: Record<string, string> = {
        title: 'title',
        description: 'description',
        projectPath: 'project_path',
        executorProvider: 'executor_provider',
        executorModel: 'executor_model',
        priority: 'priority',
        label: 'label',
        autoRun: 'auto_run',
        scheduleType: 'schedule_type',
        cronExpr: 'cron_expr',
        intervalSeconds: 'interval_seconds',
        runAt: 'run_at',
        timezone: 'timezone',
        enabled: 'enabled',
      };
      for (const [from, to] of Object.entries(keyMap)) {
        if (updates[from] !== undefined) cleaned[to] = updates[from];
      }
      const recompute = ['cron_expr', 'interval_seconds', 'run_at', 'schedule_type', 'timezone'].some((k) => cleaned[k] !== undefined);
      if (recompute) {
        const merged = { ...current, ...cleaned } as ScheduledTaskRow;
        cleaned.next_run_at = initialNextRun(
          {
            scheduleType: merged.schedule_type,
            cronExpr: merged.cron_expr,
            intervalSeconds: merged.interval_seconds,
            runAt: merged.run_at,
            timezone: merged.timezone,
          },
          now(),
        );
      }
      const row = deps.scheduledTasksDb.updateScheduledTask(scheduleId, cleaned);
      if (row) deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      return row;
    },
    remove(scheduleId: string): void {
      deps.scheduledTasksDb.deleteScheduledTask(scheduleId);
      deps.broadcast({ kind: 'scheduled_task_deleted', scheduleId, timestamp: now().toISOString() });
    },
    setEnabled(scheduleId: string, enabled: boolean): unknown {
      const row = deps.scheduledTasksDb.updateScheduledTask(scheduleId, { enabled: enabled ? 1 : 0 });
      if (row) deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      return row;
    },
    runNow(scheduleId: string): unknown {
      const schedule = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!schedule) return null;
      dispatch(schedule);
      return { ok: true };
    },
    reconcileMissedRuns,
    start(): void {
      try { reconcileMissedRuns(); } catch (error) {
        console.error('[scheduler] reconcileMissedRuns failed', error instanceof Error ? error.message : error);
      }
      timer = setInterval(tick, 15_000);
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
    tickNow: tick,
  };
}