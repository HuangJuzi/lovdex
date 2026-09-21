import type { TaskProjectOption } from './TaskCard';

/**
 * 项目列的显示文案。`is_operator === 1`（Lovdex 助手任务）与「没有项目路径」
 * 都归一成助手标签；否则查 projectOptions，查不到就回退完整路径。
 *
 * 参数用结构化类型而不是 `Task` / `ScheduledTask`：调度列表和任务运行记录
 * 都要用，两者都有这两个字段（Task 的 `project_path` 是非空的 string，可以
 * 赋给 `string | null`）。
 */
export function projectLabel(
  item: { is_operator: number; project_path: string | null },
  projectOptions: TaskProjectOption[],
): string {
  if (item.is_operator === 1 || !item.project_path) return '🤖 Lovdex助手';
  const opt = projectOptions.find((o) => o.value === item.project_path);
  return opt?.label || item.project_path;
}
