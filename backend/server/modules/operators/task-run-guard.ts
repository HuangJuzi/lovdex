/**
 * Guard for the headless task executor's tool surface, so background fan-out
 * (deep-research-style skills) cannot spawn subagents/workflows that escape
 * Lovdex's managed project scope.
 *
 * Root cause being fixed: `startHeadlessTaskRun` dispatches a full-tool Claude
 * Code run (permissionMode default, empty allowlist = all built-ins). The
 * model may then invoke a fan-out skill (e.g. deep-research) which spawns work
 * via the Agent/Task tool — whose `run_in_background` defaults to true — or the
 * Workflow tool, and optionally with `isolation: 'worktree' | 'remote'`, which
 * runs the subagent in a temp git worktree / remote env OUTSIDE the registered
 * project set. The parent turn then ends with only "已启动后台调研工作流、完成后
 * 继续" (an empty deliverable), and the auto-verdict marks the task failed.
 *
 * This module is pure: it decides how to coerce/deny one tool call, and whether
 * the Workflow feature should be enabled, with no DB / filesystem / SDK deps so
 * it is trivially unit-testable.
 */

/** Subagent-spawning tool names across SDK versions (Task is classic, Agent is the newer alias). */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** Detached background-workflow tool that cannot guarantee synchronous result relay. */
export const BACKGROUND_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set(['Workflow']);

/** Max depth of task-spawns-task chains (root=0, its child=1, …). */
export const MAX_TASK_DISPATCH_DEPTH = 2;

export type TaskRunToolGuardResult =
  | { decision: 'allow'; updatedInput?: Record<string, unknown>; additionalContext?: string }
  | { decision: 'deny'; reason: string };

/**
 * The depth of the CURRENT task's position in the dispatch chain, injected by
 * the PreToolUse hook from the task row. Null means "not a task run" (guard
 * behaves as it did before lineage existed). 0 = root task.
 */
export type TaskRunGuardContext = {
  dispatchDepth?: number | null;
};

/**
 * Decide how to handle one tool call dispatched by a headless task executor.
 *
 * - Agent/Task: force synchronous execution (`run_in_background=false`) and
 *   strip `isolation: 'worktree' | 'remote'` so the subagent inherits the task
 *   project cwd (fallback strategy — never silently escape scope). The coercion
 *   is surfaced to the model via `additionalContext` so it is not silent.
 * - Workflow: deny with a readable error — detached background workflows cannot
 *   guarantee synchronous result relay, so they are disabled in task runs.
 * - Anything else: no-op allow.
 */
export function guardTaskRunToolInput(
  toolName: unknown,
  toolInput: unknown,
  context: TaskRunGuardContext = {},
): TaskRunToolGuardResult {
  const name = typeof toolName === 'string' ? toolName : String(toolName ?? '');
  const input =
    toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {};

  if (BACKGROUND_WORKFLOW_TOOL_NAMES.has(name)) {
    return {
      decision: 'deny',
      reason:
        '后台工作流（Workflow）在任务执行中不可用：它会在 Lovdex 管理范围之外拉起后台子代理、且无法同步回传结果。请改为同步执行（Agent/Task 工具 run_in_background=false）完成本任务。',
    };
  }

  if (SUBAGENT_TOOL_NAMES.has(name)) {
    // Fan-out depth guard: a task may not dispatch a sub-task (via the operator
    // create_task tool) or a sub-agent past the depth budget — the runaway
    // cleanup run spawned read-only sub-tasks with no cap. The PreToolUse hook
    // injects the current task's depth; non-task runs are unconstrained.
    const depth = typeof context.dispatchDepth === 'number' && context.dispatchDepth >= 0
      ? context.dispatchDepth
      : 0;
    if (depth >= MAX_TASK_DISPATCH_DEPTH) {
      return {
        decision: 'deny',
        reason:
          `任务派发深度已达上限（${MAX_TASK_DISPATCH_DEPTH} 层）：本任务已是第 ${depth} 层派生，禁止再下发子任务/子代理。请在当前任务内自行完成，或把工作拆小后直接在本会话内继续。`,
      };
    }

    const updated: Record<string, unknown> = { ...input };
    let changed = false;
    // `run_in_background` defaults to true in the SDK — an omitted field still
    // spawns a detached background subagent, so pin it false explicitly.
    if (updated.run_in_background !== false) {
      updated.run_in_background = false;
      changed = true;
    }
    // worktree/remote isolation runs the subagent outside the registered
    // project (temp git worktree / remote env). Strip it → fall back to the
    // parent task projectPath.
    if (updated.isolation === 'worktree' || updated.isolation === 'remote') {
      delete updated.isolation;
      changed = true;
    }
    if (changed) {
      return {
        decision: 'allow',
        updatedInput: updated,
        additionalContext:
          '子代理已由 Lovdex 强制为同步执行并固定到任务项目目录（禁用 run_in_background 与 worktree/remote 隔离），防止其逃逸到未注册目录导致结果无法回传。',
      };
    }
    return { decision: 'allow' };
  }

  return { decision: 'allow' };
}

/**
 * Whether the SDK `Workflow` feature should be enabled for a given run.
 *
 * Headless task runs disable it so the model cannot spawn detached background
 * workflows (the "spawn and promise to continue later" pattern). Interactive
 * chats keep the config-driven default — the user supervises those runs and
 * their fan-out is expected.
 */
export function resolveWorkflowsEnabled(
  options: { isTaskRun?: boolean } | undefined,
  config: { server?: { workflowsEnabled?: boolean | null } } | undefined,
): boolean {
  if (options?.isTaskRun) {
    return false;
  }
  return config?.server?.workflowsEnabled ?? true;
}
