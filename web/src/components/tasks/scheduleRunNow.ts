/**
 * 定时任务「立即触发」的前端判据与文案。
 *
 * 纯逻辑放这里而不是 ScheduledTasksView.tsx：那会触发
 * react-refresh/only-export-components；而且 web 测试是 node:test +
 * renderToStaticMarkup（无 DOM、不跑 effect、不触发事件），逻辑必须离开组件才测得到。
 */
import type { ScheduledTask, Task } from '../../types/app';

/**
 * 每条调度「上一轮还没结束」的那个运行；map 里没有 = 可以触发。
 *
 * 判据与后端 isRunActive 的前半段逐字一致：任务停在 in_progress 列、且没有
 * failed 标签。用 decorate() 之后的行 —— sub_status 是计算后的有效值（跑着的是
 * running、等你回答/计划是 waiting_*、跑挂的仍标 failed）。
 *
 * 按 task_id 在全量任务列表里查，而不是复用 runsOf 的 source_schedule_id 过滤：
 * 这里的判据是「last_task_id 指向的那一行」，与运行记录列表的筛选条件恰好重合
 * 只是巧合，绑上去会让两件事一起变。
 *
 * 前端看不见 isSessionRunning（会话是否真的还在流式输出），所以「人工把在跑的
 * 任务标成 done」这种情形这里放行 —— 由后端的 409 兜底，错误条如实报出。
 */
export function blockingRunsBySchedule(schedules: ScheduledTask[], tasks: Task[]): Map<string, Task> {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const blocked = new Map<string, Task>();
  for (const schedule of schedules) {
    const lastId = schedule.last_task_id;
    if (!lastId) continue;
    const run = byId.get(lastId);
    if (!run) continue;
    if (run.status === 'in_progress' && run.sub_status !== 'failed') blocked.set(schedule.schedule_id, run);
  }
  return blocked;
}

/**
 * 禁用原因的 title 文案。移动端没有 hover、看不到 title，颜色是主要线索，
 * 这段文字是桌面端与无障碍的补充。
 */
export function runNowBlockedReason(run: Task): string {
  switch (run.sub_status) {
    case 'waiting_answer': return '上一轮在等你回答，去会话里回复后才会继续';
    case 'waiting_plan': return '上一轮在等你确认计划';
    case 'waiting_approval': return '上一轮在等你批准权限请求';
    default: return '上一轮还在运行中，先等它结束或中断它';
  }
}

/**
 * 立即触发失败的提示条文案。
 *
 * 409（SCHEDULE_RUNNING）单独说人话：它意味着「按钮本该是灰的，但前端漏挡了」
 * （人工把在跑的任务标成了 done），是用户能自己处理的状态。
 */
export function runNowErrorMessage(title: string, status: number, body: unknown): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (error?.code === 'SCHEDULE_RUNNING') return `「${title}」上一轮还没结束，先处理或中断它再触发`;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return message ? `「${title}」${message}` : `「${title}」立即触发失败 (${status})`;
}
