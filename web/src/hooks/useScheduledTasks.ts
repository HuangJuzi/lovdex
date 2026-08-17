import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../utils/api';
import type { ScheduledTask } from '../types/app';

/** Realtime scheduled-task frame delivered by the WS `subscribe` API. */
export type ScheduledTaskEvent = {
  kind?: string;
  scheduledTask?: ScheduledTask;
  scheduleId?: string;
};

export function useScheduledTasks(
  options: { projectPath?: string; enabled?: boolean } = {},
  subscribe?: (cb: (event: ScheduledTaskEvent) => void) => () => void,
) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.scheduledTasks.list(options);
      if (!res.ok) throw new Error(`scheduledTasks.list failed: ${res.status}`);
      const data = (await res.json()) as ScheduledTask[];
      if (mounted.current) {
        setTasks(Array.isArray(data) ? data : []);
        setLoadError(false);
      }
    } catch (error) {
      console.error('Error fetching scheduled tasks:', error);
      if (mounted.current) setLoadError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [options.projectPath, options.enabled]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const upsert = useCallback((task: ScheduledTask) => {
    setTasks(prev => {
      const i = prev.findIndex(t => t.schedule_id === task.schedule_id);
      if (i === -1) return [...prev, task];
      const next = [...prev];
      next[i] = task;
      return next;
    });
  }, []);

  const remove = useCallback((scheduleId: string) => {
    setTasks(prev => prev.filter(t => t.schedule_id !== scheduleId));
  }, []);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.kind === 'scheduled_task_upserted' && event.scheduledTask) upsert(event.scheduledTask);
      else if (event.kind === 'scheduled_task_deleted' && event.scheduleId) remove(event.scheduleId);
      else if (event.kind === 'websocket_reconnected') void refresh();
    });
  }, [subscribe, upsert, remove, refresh]);

  return { tasks, loading, loadError, refresh, upsert, remove };
}
