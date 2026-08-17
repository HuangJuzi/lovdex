// server/modules/scheduler/services/scheduled-task-db-like.ts
import type { ScheduledTaskRow, ScheduledTaskScheduleType } from '@/shared/types.js';

export type ScheduledTaskDbLike = {
  operatorWorkspacePath: string;
  createScheduledTask: (input: {
    title: string;
    description?: string | null;
    projectPath?: string | null;
    executorProvider?: string;
    executorModel?: string | null;
    priority?: string;
    label?: string;
    autoRun?: boolean;
    scheduleType: ScheduledTaskScheduleType;
    cronExpr?: string | null;
    intervalSeconds?: number | null;
    runAt?: string | null;
    timezone?: string;
    nextRunAt: string;
  }) => ScheduledTaskRow;
  getScheduledTask: (scheduleId: string) => ScheduledTaskRow | null;
  listScheduledTasks: (filter: { projectPath?: string; enabled?: boolean }) => ScheduledTaskRow[];
  updateScheduledTask: (scheduleId: string, updates: Record<string, unknown>) => ScheduledTaskRow | null;
  deleteScheduledTask: (scheduleId: string) => void;
  listDueScheduledTasks: (now: string) => ScheduledTaskRow[];
  listMissedSince: (now: string) => ScheduledTaskRow[];
};