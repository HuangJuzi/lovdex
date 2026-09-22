/**
 * 删除定时任务的前端文案与响应解析。
 *
 * 纯逻辑放这里而不是 ScheduledTasksView.tsx / ScheduledTasksPanel.tsx：视图里加普通
 * 导出会触发 react-refresh/only-export-components，而且 web 测试是 node:test +
 * renderToStaticMarkup（无 DOM、不跑 effect、不触发事件），逻辑必须离开组件才测得到。
 * 与 runHistoryDelete.ts（删运行记录）是同一套分工。
 */

/**
 * 删除确认弹窗文案。
 *
 * 与旧文案（「已生成的任务不会被删除」）的差别是本模块存在的全部理由：删调度现在会
 * **级联删掉它跑出来的任务与关联会话**，这句话是用户唯一被告知「对话记录不可恢复」
 * 的地方，必须写明。
 *
 * 条数是**尽力而为**的：取自页面上那份任务列表，它可能比后端旧一拍（WS 掉线时）。
 * 所以条数为 0 时退回一句不带数字的通用承诺，而不是断言「没有运行记录」——
 * 陈旧列表不该让弹窗对用户撒谎。
 */
export function scheduleDeleteConfirmMessage(title: string, runCount: number): string {
  const cascade = runCount > 0
    ? `它跑出的 ${runCount} 条任务及关联会话也会一并删除，此操作不可恢复。`
    : '它跑出的任务及关联会话也会一并删除，此操作不可恢复。';
  return `删除定时任务「${title}」？${cascade}`;
}

/**
 * 删除失败的提示条文案。
 *
 * 409（SESSION_RUNNING）单独说人话：该调度还有一轮没结束，先停掉再删。这是本次新增
 * 的拒绝路径 —— 删除从「永远成功」变成「可能被拒」，前端必须如实报出来，不能像改动前
 * 那样把响应丢掉。
 *
 * body 是 unknown：fetch 的 JSON 解析结果什么都可能是，先收窄成对象再逐层读，
 * 读不到就退回状态码（同 runNowErrorMessage 的口径）。
 */
export function scheduleDeleteErrorMessage(title: string, status: number, body: unknown): string {
  const error = (typeof body === 'object' && body !== null ? body : {}) as {
    error?: { code?: unknown; message?: unknown };
  };
  if (error.error?.code === 'SESSION_RUNNING') return `「${title}」还有一轮未结束的运行，先停止或中断它再删除`;
  const message = typeof error.error?.message === 'string' ? error.error.message.trim() : '';
  return message ? `「${title}」${message}` : `「${title}」删除失败 (${status})`;
}

/**
 * 删除响应里带回的、已被级联删掉的任务 id。
 *
 * 页面要靠它把那些行从本地任务列表里摘掉：正常路径下 `task_deleted` WS 事件会自己
 * 摘，但 E2E 实测每次连接都报 `WebSocket error`，只靠 WS 会留下一批库里已经不在的行。
 *
 * 解析一律逐层收窄：字段缺失、不是数组、数组里混了非字符串，都只影响这一份兜底
 * 清理，绝不能因此抛错 —— 删除本身已经成功了。
 */
export function deletedRunIds(body: unknown): string[] {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as { deletedTaskIds?: unknown };
  if (!Array.isArray(raw.deletedTaskIds)) return [];
  return raw.deletedTaskIds.filter((id): id is string => typeof id === 'string');
}
