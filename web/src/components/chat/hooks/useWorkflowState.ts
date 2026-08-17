import { useCallback, useRef } from 'react';

import type { SessionStore } from '../../../stores/useSessionStore';
import { resolveWorkflowRoot, type WorkflowEvent } from '../tools/workflowState';

/**
 * Dispatches Workflow SDK events into the session store, keyed by the Workflow
 * tool_use id (task_started.tool_use_id). background_tasks_changed is level-only
 * and routes to the store's backgroundTasks slice instead.
 *
 * The store keys each progress tree by the ROOT tool_use_id from task_started,
 * but task_progress / tool_progress / task_notification events carry the LEAF
 * toolUseId (and/or just a taskId). A taskId → root mapping is maintained here
 * so those events route to the tree created by the matching task_started.
 */
export function useWorkflowState(sessionStore: SessionStore) {
  // Maps a Workflow taskId → the ROOT tool_use_id recorded on task_started.
  const taskIdToRootRef = useRef<Record<string, string>>({});

  const dispatch = useCallback((toolUseId: string | null | undefined, event: WorkflowEvent) => {
    if (event.kind === 'background_tasks_changed') {
      sessionStore.setBackgroundTasks(event.tasks);
      return;
    }

    if (event.kind === 'task_started' && event.taskId && event.toolUseId) {
      taskIdToRootRef.current = {
        ...taskIdToRootRef.current,
        [event.taskId]: event.toolUseId,
      };
    }

    const root = resolveWorkflowRoot(taskIdToRootRef.current, toolUseId, event);
    if (!root) return;
    sessionStore.applyWorkflowEvent(root, event);
  }, [sessionStore]);

  return { dispatch };
}