import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../utils/api';
import type { Task, TaskStatus } from '../types/app';

/**
 * Realtime task frame as delivered by the `subscribe` websocket API. Only the
 * fields this hook consumes are typed; the context delivers every frame and we
 * filter by `kind` below.
 */
export type TaskEvent = {
  kind?: string;
  task?: Task;
  taskId?: string;
};

/**
 * Data layer for the task board. Fetches the task list (optionally scoped by
 * project path and/or status) and exposes local upsert/remove helpers that the
 * realtime `task_upserted` / `task_deleted` subscriptions will call into.
 */
export function useTasks(
  options: { projectPath?: string; status?: TaskStatus } = {},
  subscribe?: (cb: (event: TaskEvent) => void) => () => void,
) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.tasks.list({ projectPath: options.projectPath, status: options.status });
      if (!res.ok) throw new Error(`tasks.list failed: ${res.status}`);
      const data = (await res.json()) as Task[];
      if (mounted.current) {
        setTasks(Array.isArray(data) ? data : []);
        setLoadError(false);
      }
    } catch (error) {
      console.error('Error fetching tasks:', error);
      if (mounted.current) setLoadError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [options.projectPath, options.status]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const upsert = useCallback((task: Task) => {
    setTasks(prev => {
      const i = prev.findIndex(t => t.task_id === task.task_id);
      if (i === -1) return [...prev, task];
      const next = [...prev];
      next[i] = task;
      return next;
    });
  }, []);

  const remove = useCallback((taskId: string) => {
    setTasks(prev => prev.filter(t => t.task_id !== taskId));
  }, []);

  // Live updates: when a `subscribe` source is provided, mirror task_upserted
  // / task_deleted frames into the local list so the board refreshes without a
  // manual reload. The synthetic `websocket_reconnected` frame is emitted when
  // the socket re-opens after a drop, so refetch the whole list to replay any
  // events missed while disconnected. `upsert`/`remove`/`refresh` are stable so
  // this registers once.
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.kind === 'task_upserted' && event.task) upsert(event.task);
      else if (event.kind === 'task_deleted' && event.taskId) remove(event.taskId);
      else if (event.kind === 'websocket_reconnected') void refresh();
    });
  }, [subscribe, upsert, remove, refresh]);

  return { tasks, loading, loadError, refresh, upsert, remove };
}
