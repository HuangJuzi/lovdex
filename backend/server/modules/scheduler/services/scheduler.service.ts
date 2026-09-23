import { Cron } from 'croner';

import { isScheduleType } from '@/modules/database/repositories/scheduled-tasks.db.js';
import { AUTO_APPROVE_MODE, normalizePermissionMode } from '@/modules/permissions/auto-approve-policy.js';
import { resolveGeneratedTitle } from '@/modules/tasks/services/task-title.js';
import type { TasksService } from '@/modules/tasks/services/tasks.service.js';
import { AppError } from '@/shared/utils.js';
import type { ScheduledTaskRow, TaskEngine, TaskRow } from '@/shared/types.js';
import type { ScheduledTaskDbLike } from './scheduled-task-db-like.js';

export type SchedulerDeps = {
  scheduledTasksDb: ScheduledTaskDbLike;
  tasksService: Pick<TasksService, 'createTask' | 'startExecution' | 'getTask' | 'deleteTasksBySchedule'>;
  createSession: (provider: TaskEngine, projectPath: string, isOperator?: boolean) => string;
  startTaskRun: (taskId: string, sessionId: string) => boolean;
  broadcast: (event: { kind: string; [k: string]: unknown }) => void;
  /**
   * 会话是否仍在流式输出。必填而非可选：漏注入会让「上一轮还在跑」的守卫静默
   * 失效，而拦住第二个 agent 正是本次要做的全部事情 —— 宁可在类型层面卡住。
   */
  isSessionRunning: (sessionId: string) => boolean;
  now?: () => Date;
  /** 模板标题留空时用 LLM 从描述取名；与 tasksService 同一个契约。 */
  generateTitle?: (input: { description: string | null }) => Promise<string | null>;
  /** 单测注入口；生产走 TITLE_BLOCKING_TIMEOUT_MS（3s）。 */
  titleBlockingMs?: number;
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

/**
 * 「上一轮还没结束」：任务停在 in_progress 列、且没有 failed 标签。
 *
 * 入参必须是 decorate() 之后的行 —— sub_status 那时才是计算后的有效值：跑着的是
 * running、等你回答/计划是 waiting_*、跑挂的仍停在 in_progress 槽位但标 failed。
 * 所以「运行中 + 等人工都挡、跑挂的放行」就是 `!== 'failed'` 这一条，不用枚举标签。
 *
 * 注意这条判据只看任务行，看不见「会话是否真的还在流式输出」—— 人工把在跑的任务
 * 标成 done 时 status 会骗人，那一段由调用方的 isSessionRunning 兜（见 blockingRunOf）。
 */
export function isRunActive(task: Pick<TaskRow, 'status' | 'sub_status'> | null): boolean {
  return task !== null && task.status === 'in_progress' && task.sub_status !== 'failed';
}

export function createSchedulerService(deps: SchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  /**
   * 派发途中的 schedule_id。
   *
   * 状态判据读的是**落库的** last_task_id，而它要到 dispatch 的最后一步才写
   * （见 dispatch 里的 updates）。两次挨得很近的触发会都读到旧值、双双放行 ——
   * 前端那道 ref 闸门只管得住同一个组件实例，跨标签页管不到。调度器是单进程，
   * 一个进程内集合就够，且覆盖整个 dispatch（含 last_task_id 的写入）。
   * tick 不经过 runNow，闸门**有意**不覆盖到点补跑（见设计 §7）。
   */
  const inFlight = new Set<string>();

  /**
   * Background write-back for a template title that arrived after the blocking
   * window.
   *
   * CAS on the placeholder we actually wrote: if the user renamed the template
   * while the model was thinking — or deleted it — the generated title yields.
   * Broadcasts a second `scheduled_task_upserted` so an open list picks the new
   * name up live.
   *
   * Never throws: this runs detached from create/update, and a DB hiccup here
   * must not surface as an unhandled rejection.
   */
  function applyGeneratedTitle(scheduleId: string, generated: string | null, placeholderTitle: string): void {
    try {
      if (!generated) return;
      const current = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!current || current.title !== placeholderTitle) return;
      const updated = deps.scheduledTasksDb.updateScheduledTask(scheduleId, { title: generated });
      if (!updated) return;
      deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: updated, timestamp: now().toISOString() });
    } catch (error) {
      console.error('[scheduler] title write-back failed', {
        scheduleId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * 这条调度「上一轮还没结束」的那个任务；null = 可以再触发。
   *
   * 两段判据缺一不可：
   * - 任务行：in_progress 且没标 failed（见 isRunActive）。用 getTask 而不是裸 DB 行 ——
   *   与其它守卫同一个查表口；且判据一旦从 `!== 'failed'` 改成按 running / waiting_*
   *   枚举，decorate() 算出的有效值才是前提。
   * - 会话：status 会骗人 —— 任务页的「标记完成」在进行中也渲染，人工把正在跑的任务
   *   标成 done 之后 status 就不是 in_progress 了，但 agent 还在同一个项目里写文件。
   *   这一段与 deleteTask / session-transfer / operator-delete 是同一个判据。
   *
   * 上一轮的任务已被删（运行记录清理）时放行：查不到就不挡。
   *
   * 只由 runNow 调用；tick 的到点补跑**故意**不挡（见设计 §5/§7）——把守卫挪进
   * dispatch 会让卡住的调度每 15s 被判到期却派不出去。
   */
  function blockingRunOf(schedule: ScheduledTaskRow): TaskRow | null {
    const lastId = schedule.last_task_id;
    if (!lastId) return null;
    const task = deps.tasksService.getTask(lastId);
    if (!task) return null;
    if (isRunActive(task)) return task;
    if (task.session_id && deps.isSessionRunning(task.session_id)) return task;
    return null;
  }

  async function dispatch(schedule: ScheduledTaskRow): Promise<void> {
    const projectPath = schedule.project_path ?? deps.scheduledTasksDb.operatorWorkspacePath;
    // The template title is resolved and persisted at save time (task-title), so
    // this normally does not touch the model. A legacy row with a blank title
    // still falls back to createTask's own resolution.
    const task = await deps.tasksService.createTask({
      projectPath,
      title: schedule.title,
      description: schedule.description,
      executorProvider: schedule.executor_provider as TaskEngine,
      executorModel: schedule.executor_model,
      priority: schedule.priority as 'P0' | 'P1' | 'P2' | 'P3',
      label: schedule.label as never,
      isOperator: schedule.is_operator === 1,
      // 镜像到任务行：派发后任务自包含，之后改/删定时任务不影响已在跑的那一次。
      permissionMode: schedule.permission_mode ?? 'default',
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

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const schedule of deps.scheduledTasksDb.listDueScheduledTasks(now().toISOString())) {
        try {
          await dispatch(schedule);
        } catch (error) {
          console.error('[scheduler] tick dispatch failed', error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      // tick 由 setInterval 驱动，返回值没人接：listDueScheduledTasks 自己抛错时
      // 冒泡出去就是一次 unhandledRejection（进程级告警），必须在这里吞掉。
      console.error('[scheduler] tick failed', error instanceof Error ? error.message : error);
    } finally {
      ticking = false;
    }
  }

  /** 启动时：停机错过不补跑，聚合成一条 reminder 任务，推进 next_run_at。 */
  async function reconcileMissedRuns(): Promise<void> {
    const missed = deps.scheduledTasksDb.listMissedSince(now().toISOString());
    if (missed.length === 0) return;
    const lines = missed.map((s) => `- ${s.title}（原定 ${s.next_run_at}）`);
    await deps.tasksService.createTask({
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

  /**
   * 落库前的调度形状校验 —— 只看**将要落库**的那一份值。
   *
   * 这两条不是 UX 约束（60 秒 / 365 天是前端的决定，会变），而是**防止后端被搞坏**的下限：
   * - `interval_seconds <= 0` 会让 computeNext 的 `while (next <= now) next += stepMs` 永不终止，
   *   而 tick 的重入守卫会让整个调度器从此不再触发任何任务（无日志、无告警）。
   * - 空的 cron_expr 会让 computeNext 走 `return now.toISOString()`，该任务每 15 秒触发一次。
   *
   * 因为 update 可以只改部分字段，危险值可能来自「新传的」与「库里现有的」的组合，
   * 所以判断对象必须是合并后的形状，而不是单独的 updates。
   */
  function assertScheduleShape(shape: {
    schedule_type: string;
    cron_expr?: unknown;
    interval_seconds?: unknown;
  }): void {
    if (shape.schedule_type === 'cron' && !(typeof shape.cron_expr === 'string' && shape.cron_expr.trim())) {
      throw new AppError('cron schedule requires a non-empty cronExpr', { code: 'INVALID_SCHEDULE', statusCode: 400 });
    }
    if (
      shape.schedule_type === 'interval' &&
      !(typeof shape.interval_seconds === 'number' && Number.isFinite(shape.interval_seconds) && shape.interval_seconds >= 1)
    ) {
      throw new AppError('interval schedule requires intervalSeconds >= 1', { code: 'INVALID_SCHEDULE', statusCode: 400 });
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
    // 类型对了还不够：0 / 负数的 interval 与空的 cron 表达式能把调度器卡死或让它空转
    assertScheduleShape({
      schedule_type: scheduleType,
      cron_expr: input.cronExpr,
      interval_seconds: input.intervalSeconds,
    });
  }

  return {
    list(filter: { projectPath?: string; enabled?: boolean } = {}): unknown[] {
      return deps.scheduledTasksDb.listScheduledTasks(filter);
    },
    get(scheduleId: string): unknown {
      return deps.scheduledTasksDb.getScheduledTask(scheduleId);
    },
    async create(input: Record<string, unknown>): Promise<unknown> {
      validateScheduleInput(input);
      const description = typeof input.description === 'string' ? input.description : null;
      // The permission mode is normalized before it reaches the repository: what
      // is stored is exactly what the runtime will read back.
      const normalizedScheduleMode = normalizePermissionMode(input.permissionMode);
      const { permissionMode: scheduleMode, autoApprove: scheduleAutoApprove } = normalizedScheduleMode;
      // 解析放在校验之后：会 400 的请求不该花阻塞窗口（同 tasks.service）。
      const { title, writeBack } = await resolveGeneratedTitle({
        title: String(input.title ?? ''),
        description,
        generateTitle: deps.generateTitle,
        blockingMs: deps.titleBlockingMs,
      });
      const row = deps.scheduledTasksDb.createScheduledTask({
        title,
        description,
        projectPath: typeof input.projectPath === 'string' && input.projectPath ? input.projectPath : null,
        executorProvider: typeof input.executorProvider === 'string' ? input.executorProvider : undefined,
        executorModel: typeof input.executorModel === 'string' ? input.executorModel : null,
        priority: typeof input.priority === 'string' ? input.priority : undefined,
        label: typeof input.label === 'string' ? input.label : undefined,
        autoRun: input.autoRun !== 0,
        // Same normalizer the tasks routes use: only a known mode lands in the
        // DB, and any junk value degrades to 'default' — it can never turn
        // unattended auto-approval on by accident.
        permissionMode: scheduleAutoApprove ? AUTO_APPROVE_MODE : scheduleMode,
        scheduleType: input.scheduleType as never,
        cronExpr: typeof input.cronExpr === 'string' ? input.cronExpr : null,
        intervalSeconds: typeof input.intervalSeconds === 'number' ? input.intervalSeconds : null,
        runAt: typeof input.runAt === 'string' ? input.runAt : null,
        timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
        nextRunAt: initialNextRun(input as never, now()),
      });
      deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      if (writeBack) {
        void writeBack.then((generated) => applyGeneratedTitle(row.schedule_id, generated, title));
      }
      return row;
    },
    async update(scheduleId: string, updates: Record<string, unknown>): Promise<unknown> {
      const current = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!current) return null;
      if (updates.scheduleType !== undefined && typeof updates.scheduleType === 'string' && !isScheduleType(updates.scheduleType)) {
        throw new AppError(`invalid scheduleType: ${String(updates.scheduleType)}`, { code: 'INVALID_SCHEDULE_TYPE', statusCode: 400 });
      }
      // null = 清空该字段，是合法输入（前端 toApiBody 对不匹配当前调度类型的字段总是发 null）。
      if (updates.cronExpr !== undefined && updates.cronExpr !== null && typeof updates.cronExpr !== 'string') {
        throw new AppError('cronExpr must be a string', { code: 'INVALID_SCHEDULE', statusCode: 400 });
      }
      if (updates.intervalSeconds !== undefined && updates.intervalSeconds !== null && typeof updates.intervalSeconds !== 'number') {
        throw new AppError('intervalSeconds must be a number', { code: 'INVALID_SCHEDULE', statusCode: 400 });
      }
      if (updates.runAt !== undefined && updates.runAt !== null && typeof updates.runAt !== 'string') {
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
        permissionMode: 'permission_mode',
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
      // A mode must be whitelisted before it lands in the DB, same as create();
      // junk values degrade to 'default' rather than reaching the runtime.
      if (cleaned.permission_mode !== undefined) {
        const { permissionMode: mode, autoApprove } = normalizePermissionMode(cleaned.permission_mode);
        cleaned.permission_mode = autoApprove ? AUTO_APPROVE_MODE : mode;
      }
      // 校验合并后的形状：只改部分字段时，危险值可能来自新值与库里旧值的组合。
      // 放在标题解析之前 —— 会 400 的请求不该花模型取名的阻塞窗口。
      assertScheduleShape({ ...current, ...cleaned });
      // 标题传了空串 = 让模型按描述重新取名；没传 = 不动（keyMap 不会把它放进 cleaned）。
      let pendingTitle: { promise: Promise<string | null>; placeholder: string } | null = null;
      if (typeof updates.title === 'string') {
        const resolved = await resolveGeneratedTitle({
          title: updates.title,
          // 同一次 PATCH 里改了描述就用新的，否则用库里现有的。
          description: typeof cleaned.description === 'string' ? cleaned.description : current.description,
          generateTitle: deps.generateTitle,
          blockingMs: deps.titleBlockingMs,
        });
        cleaned.title = resolved.title;
        if (resolved.writeBack) pendingTitle = { promise: resolved.writeBack, placeholder: resolved.title };
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
      const pending = pendingTitle;
      if (row && pending) {
        void pending.promise.then((generated) => applyGeneratedTitle(scheduleId, generated, pending.placeholder));
      }
      return row;
    },
    /**
     * 删除调度：模板 + 它跑出来的任务与会话一起走。
     *
     * 级联本身由 tasksService.deleteTasksBySchedule 拥有（守卫、会话硬删、
     * 逐条 task_deleted 广播都在那条路径上），这里只管编排与顺序：
     * **先清运行、再删模板行**。反过来的话，级联被拒（还有一轮在跑 → 409）时模板
     * 已经没了，用户拿着 409 却没有了重试的入口。
     *
     * 返回值把被删掉的任务 id 带回给路由 —— WS 不可靠，前端要靠这份 id 把行从本地
     * 任务列表里摘掉。
     */
    async remove(scheduleId: string): Promise<{ deletedTaskIds: string[] }> {
      const { deletedTaskIds } = await deps.tasksService.deleteTasksBySchedule(scheduleId);
      deps.scheduledTasksDb.deleteScheduledTask(scheduleId);
      deps.broadcast({ kind: 'scheduled_task_deleted', scheduleId, timestamp: now().toISOString() });
      return { deletedTaskIds };
    },
    setEnabled(scheduleId: string, enabled: boolean): unknown {
      const row = deps.scheduledTasksDb.updateScheduledTask(scheduleId, { enabled: enabled ? 1 : 0 });
      if (row) deps.broadcast({ kind: 'scheduled_task_upserted', scheduledTask: row, timestamp: now().toISOString() });
      return row;
    },
    async runNow(scheduleId: string): Promise<unknown> {
      const schedule = deps.scheduledTasksDb.getScheduledTask(scheduleId);
      if (!schedule) return null;
      // 同一 tick 里的第二次点击 / 另一个标签页的并发请求 —— 状态判据这时还没看到
      // 第一次的 last_task_id，只有这道闸门能挡。
      if (inFlight.has(scheduleId)) {
        throw new AppError(
          `schedule ${scheduleId} is still dispatching; wait for it to settle`,
          { code: 'SCHEDULE_RUNNING', statusCode: 409 },
        );
      }
      // 上一轮还在跑就拒绝：dispatch 每次都会新建任务并起一个 agent，同一个提示词
      // 会在同一个项目里跑起第二个 agent。
      const blocking = blockingRunOf(schedule);
      if (blocking) {
        throw new AppError(
          `schedule ${scheduleId} still has an unfinished run; settle or interrupt it first`,
          { code: 'SCHEDULE_RUNNING', statusCode: 409, details: { taskId: blocking.task_id } },
        );
      }
      inFlight.add(scheduleId);
      try {
        // Awaited: createTask may block on title generation, and a dispatch failure
        // must surface to the route instead of becoming an unhandled rejection.
        await dispatch(schedule);
      } finally {
        inFlight.delete(scheduleId);
      }
      return { ok: true };
    },
    reconcileMissedRuns,
    start(): void {
      // 补跑提醒任务建失败不该拦住调度器启动：吞掉并记日志。
      void reconcileMissedRuns().catch((error) => {
        console.error('[scheduler] reconcileMissedRuns failed', error instanceof Error ? error.message : error);
      });
      timer = setInterval(() => {
        void tick();
      }, 15_000);
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
    tickNow: tick,
  };
}