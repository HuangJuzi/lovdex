import type { Task } from '../../types/app';

/**
 * 删除结果。`running` 单独标记「因运行中被拒」—— 后端 `deleteTask` 对运行中的任务
 * （或会话仍在流式输出的）抛 409 `SESSION_RUNNING`，结果文案要能把它与普通失败分开说。
 */
export type DeleteOutcome = {
  deleted: string[];
  failed: { taskId: string; reason: string; running: boolean }[];
};

/**
 * 可删除的运行。运行中的删不掉（后端 409），从源头不给勾 —— 免得用户白选一轮再被拒。
 * 其余状态（含 archived）都能删：这是一份历史，要删的就是跑完的那些。
 */
export function selectableRuns(runs: Task[]): Task[] {
  return runs.filter((t) => t.status !== 'in_progress');
}

/**
 * 表头全选：只作用于可选行；全部已选则清空。与 `TaskBoard.tsx` 里的同名内联逻辑一致，
 * 抽出来是为了能在无 DOM 的测试环境里测。
 */
export function toggleSelectAll(prev: Set<string>, selectableIds: string[]): Set<string> {
  if (selectableIds.length > 0 && selectableIds.every((id) => prev.has(id))) return new Set();
  return new Set(selectableIds);
}

/**
 * 结果条文案；`null` 表示没有结果条要显示。
 *
 * 三段各自计数后按序拼：已删除 → 因运行中失败 → 其它失败。唯一例外是一条都没删掉、
 * 且失败全部因运行中时，换成一句可操作的原因（用户能自己去停止那个运行）。
 */
export function deleteOutcomeMessage({ deleted, failed }: DeleteOutcome): string | null {
  if (deleted.length === 0 && failed.length === 0) return null;

  const running = failed.filter((f) => f.running).length;
  const other = failed.length - running;

  if (deleted.length === 0 && other === 0) {
    return `${running} 条未能删除：运行中的运行需先停止`;
  }

  const parts: string[] = [];
  if (deleted.length > 0) parts.push(`已删除 ${deleted.length} 条`);
  if (running > 0) parts.push(`${running} 条因运行中未能删除`);
  if (other > 0) parts.push(`${other} 条删除失败`);
  return parts.join('，');
}
