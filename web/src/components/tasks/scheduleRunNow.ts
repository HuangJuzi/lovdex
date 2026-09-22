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
 * 409（SCHEDULE_RUNNING）单独说人话。最常见的原因是前端漏挡（人工把在跑的任务标成了
 * done）；但跨标签页的第二次点击、或点击与上一轮开跑的竞态也会拿到同一个 code，
 * 那时按钮在点下去的那一刻是合法可点的。两种情况用户的处置相同：等上一轮结束。
 *
 * body 是 unknown：fetch 的 JSON 解析结果什么都可能是，先收窄成对象再逐层读，
 * 读不到就退回状态码 —— 不靠「对原始值取属性不抛错」这种语言宽松性兜底。
 */
export function runNowErrorMessage(title: string, status: number, body: unknown): string {
  const error = (typeof body === 'object' && body !== null ? body : {}) as {
    error?: { code?: unknown; message?: unknown };
  };
  if (error.error?.code === 'SCHEDULE_RUNNING') return `「${title}」上一轮还没结束，先处理或中断它再触发`;
  const message = typeof error.error?.message === 'string' ? error.error.message.trim() : '';
  return message ? `「${title}」${message}` : `「${title}」立即触发失败 (${status})`;
}
