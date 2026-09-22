/**
 * 侧栏「新建任务」跳 `/tasks` 时携带的 navigation state。
 *
 * 读写两侧放在同一个模块里，是为了让「字段名」这份契约只有一个来源 ——
 * 写侧在 `Sidebar.tsx`，读侧在 `TaskBoard.tsx`，两边隔着一个路由，
 * 改坏了不会有编译错误。
 */
export function createdTaskNavState(taskId: string): { createdTaskId: string } {
  return { createdTaskId: taskId };
}

/**
 * 从 `/tasks` 的 `location.state` 里读出侧栏「新建任务」带过来的 task_id。
 *
 * URL state 是外部输入 —— 用户可以直接改历史记录，别的入口也能往这里塞东西 ——
 * 所以只认这一种 shape，其余一律当没有。
 */
export function readCreatedTaskId(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const id = (state as { createdTaskId?: unknown }).createdTaskId;
  return typeof id === 'string' && id !== '' ? id : null;
}
