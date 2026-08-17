/**
 * Pure aggregation of Workflow SDK events into a WorkflowState tree.
 *
 * The frontend receives task_started/task_progress/tool_progress/task_notification
 * as separate WS events keyed by taskId (+ toolUseId for the Workflow root).
 * This function reduces them into a single WorkflowState per Workflow tool_use,
 * which WorkflowContainer renders as a three-level tree:
 *   Workflow → agents[] → tools[]
 *
 * Kept as a pure function so it can be unit-tested with node:test (no jsdom).
 * Every state-changing path returns a NEW reference (immutable), so Zustand
 * selectors in the wrapping hook (useWorkflowState) see next !== prev and
 * re-render on task_progress/task_notification.
 */

export interface WorkflowUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

export interface WorkflowAgentNode {
  taskId: string;
  toolUseId?: string;
  subagentType?: string;
  taskType?: string;
  description: string;
  lastToolName?: string;
  usage?: WorkflowUsage;
  tools: Array<{
    toolUseId: string;
    toolName: string;
    elapsedTimeSeconds: number;
  }>;
}

export interface WorkflowState {
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'async_launched';
  taskType?: string;
  workflowName?: string;
  agents: WorkflowAgentNode[];
  notification?: {
    status: 'completed' | 'failed' | 'stopped';
    summary: string;
    usage?: WorkflowUsage;
  };
}

export type WorkflowEvent =
  | { kind: 'task_started'; taskId: string; toolUseId?: string | null; taskType?: string | null; workflowName?: string | null; subagentType?: string | null; description?: string }
  | { kind: 'task_progress'; taskId: string; toolUseId?: string | null; description: string; lastToolName?: string | null; usage?: unknown; subagentType?: string | null; summary?: string | null }
  | { kind: 'tool_progress'; toolUseId: string; toolName: string; parentToolUseId?: string | null; taskId?: string | null; elapsedTimeSeconds?: number }
  | { kind: 'task_notification'; taskId: string; toolUseId?: string | null; status: 'completed' | 'failed' | 'stopped'; summary: string; usage?: unknown }
  | { kind: 'background_tasks_changed'; tasks: Array<{ taskId: string; taskType: string; description: string }> };

export function applyWorkflowEvent(state: WorkflowState | undefined, event: WorkflowEvent): WorkflowState | undefined {
  switch (event.kind) {
    case 'task_started':
      return {
        status: 'running',
        taskType: event.taskType ?? undefined,
        workflowName: event.workflowName ?? undefined,
        agents: [],
      };

    case 'task_progress': {
      if (!state) return undefined;
      const index = state.agents.findIndex((a) => a.taskId === event.taskId);
      const newAgents = [...state.agents];
      if (index >= 0) {
        const existing = state.agents[index];
        newAgents[index] = {
          ...existing,
          description: event.description,
          lastToolName: event.lastToolName ? event.lastToolName : existing.lastToolName,
          usage: event.usage ? (event.usage as WorkflowUsage) : existing.usage,
        };
      } else {
        newAgents.push({
          taskId: event.taskId,
          toolUseId: event.toolUseId ?? undefined,
          subagentType: event.subagentType ?? undefined,
          description: event.description,
          lastToolName: event.lastToolName ?? undefined,
          usage: event.usage as WorkflowUsage | undefined,
          tools: [],
        });
      }
      return { ...state, agents: newAgents };
    }

    case 'tool_progress': {
      if (!state) return undefined;
      // Route by taskId when present; otherwise fall back to the agent whose
      // toolUseId matches the SDK's parentToolUseId (subagent tool_use events
      // carry the subagent tool_use id, not the workflow taskId).
      const agentIndex = event.taskId
        ? state.agents.findIndex((a) => a.taskId === event.taskId)
        : state.agents.findIndex((a) => a.toolUseId === event.parentToolUseId);
      if (agentIndex < 0) return undefined;
      const agent = state.agents[agentIndex];
      const newTools = [...agent.tools];
      const toolIndex = newTools.findIndex((t) => t.toolUseId === event.toolUseId);
      if (toolIndex >= 0) {
        newTools[toolIndex] = {
          ...newTools[toolIndex],
          elapsedTimeSeconds: event.elapsedTimeSeconds ?? newTools[toolIndex].elapsedTimeSeconds,
        };
      } else {
        newTools.push({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          elapsedTimeSeconds: event.elapsedTimeSeconds ?? 0,
        });
      }
      const newAgents = [...state.agents];
      newAgents[agentIndex] = { ...agent, tools: newTools };
      return { ...state, agents: newAgents };
    }

    case 'task_notification': {
      if (!state) return undefined;
      return {
        ...state,
        status: event.status,
        notification: {
          status: event.status,
          summary: event.summary,
          usage: (event.usage ?? undefined) as WorkflowUsage | undefined,
        },
      };
    }

    case 'background_tasks_changed':
      // Handled separately in the session store (level payload).
      return state;

    default:
      return state;
  }
}

/**
 * Resolve the owning Workflow tree's ROOT tool_use_id for an edge event.
 *
 * The store keys each progress tree by the root tool_use_id recorded on
 * `task_started`, but `task_progress` / `tool_progress` / `task_notification`
 * events carry the LEAF toolUseId (and/or just a taskId). The caller maintains
 * a `taskId → root toolUseId` map (from `task_started`) so these events route to
 * the tree they belong to.
 *
 * Returns `undefined` when the event has no routable root (nothing to apply).
 * `background_tasks_changed` is level-only and is handled separately.
 */
export function resolveWorkflowRoot(
  taskIdToRoot: Record<string, string>,
  toolUseId: string | null | undefined,
  event: WorkflowEvent,
): string | undefined {
  if (event.kind === 'background_tasks_changed') return undefined;
  // task_started is the tree root itself.
  if (event.kind === 'task_started' && event.taskId && event.toolUseId) {
    return event.toolUseId;
  }
  return (event.taskId && taskIdToRoot[event.taskId]) || toolUseId || undefined;
}

/**
 * Seed per-tool-use Workflow trees from REST history.
 *
 * The backend attaches a pre-aggregated `workflowState` onto each Workflow
 * tool_use message in history (fetchHistory/aggregateWorkflowState). When the
 * store loads history it must seed its tree map from those so a freshly loaded
 * session shows the full card without waiting for live events. Returns a new
 * merged map (does not mutate the input).
 */
export function seedWorkflowStateFromHistory(
  prev: Record<string, WorkflowState>,
  messages: Array<{ kind?: string; toolName?: string; toolId?: string; workflowState?: WorkflowState }>,
): Record<string, WorkflowState> {
  let next = prev;
  for (const m of messages) {
    if (m.kind === 'tool_use' && m.toolName === 'Workflow' && m.toolId && m.workflowState) {
      if (!next[m.toolId] || !next[m.toolId].notification) {
        next = { ...next, [m.toolId]: m.workflowState };
      }
    }
  }
  return next;
}
