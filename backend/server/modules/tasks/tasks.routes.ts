import express from 'express';

import { isTaskStatus } from '@/modules/database/repositories/tasks.db.js';
import type { TasksService } from '@/modules/tasks/services/tasks.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import type { TaskEngine, TaskStatus } from '@/shared/types.js';
import { isTaskLabel, isTaskPriority, type TaskLabel, type TaskPriority } from '@/shared/task-status.js';

export type SessionCreator = (provider: TaskEngine, projectPath: string, isOperator?: boolean) => string;

export function buildTasksRouter(tasksService: TasksService, deps: { createSession: SessionCreator }) {
  const router = express.Router();

  // GET /api/tasks?projectPath=&status=
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
      const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
      const tasks = tasksService.listTasks({ projectPath, status: statusRaw as TaskStatus | undefined });
      res.json(tasks);
    }),
  );

  // POST /api/tasks
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.priority !== undefined && (typeof body.priority !== 'string' || !isTaskPriority(body.priority))) {
        throw new AppError(`invalid priority: ${String(body.priority)}`, { code: 'INVALID_PRIORITY', statusCode: 400 });
      }
      if (body.label !== undefined && (typeof body.label !== 'string' || !isTaskLabel(body.label))) {
        throw new AppError(`invalid label: ${String(body.label)}`, { code: 'INVALID_LABEL', statusCode: 400 });
      }
      const task = tasksService.createTask({
        projectPath: typeof body.projectPath === 'string' ? body.projectPath : '',
        title: typeof body.title === 'string' ? body.title : '',
        description: typeof body.description === 'string' ? body.description : null,
        status: body.status as TaskStatus | undefined,
        executorProvider: body.executorProvider as TaskEngine | undefined,
        executorModel: typeof body.executorModel === 'string' ? body.executorModel : null,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        priority: body.priority as TaskPriority | undefined,
        deadline: typeof body.deadline === 'string' ? body.deadline : null,
        isOperator: body.isOperator === true,
        label: body.label as TaskLabel | undefined,
        remark: typeof body.remark === 'string' ? body.remark : null,
        sourceScheduleId: typeof body.sourceScheduleId === 'string' ? body.sourceScheduleId : null,
      });
      res.status(201).json(task);
    }),
  );

  // GET /api/tasks/by-session/:sessionId  (must precede /:taskId so "by-session"
  // isn't captured as a taskId param)
  router.get(
    '/by-session/:sessionId',
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const task = tasksService.getTaskBySessionId(sessionId);
      if (!task) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      res.json({ task });
    }),
  );

  // GET /api/tasks/:taskId
  router.get(
    '/:taskId',
    asyncHandler(async (req, res) => {
      const taskId = String(req.params.taskId);
      const task = tasksService.getTask(taskId);
      if (!task) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      res.json(task);
    }),
  );

  // PATCH /api/tasks/:taskId  (status OR field updates)
  router.patch(
    '/:taskId',
    asyncHandler(async (req, res) => {
      const taskId = String(req.params.taskId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.status !== undefined && (typeof body.status !== 'string' || !isTaskStatus(body.status))) {
        throw new AppError(`invalid status: ${String(body.status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (body.priority !== undefined && (typeof body.priority !== 'string' || !isTaskPriority(body.priority))) {
        throw new AppError(`invalid priority: ${String(body.priority)}`, { code: 'INVALID_PRIORITY', statusCode: 400 });
      }
      if (body.label !== undefined && (typeof body.label !== 'string' || !isTaskLabel(body.label))) {
        throw new AppError(`invalid label: ${String(body.label)}`, { code: 'INVALID_LABEL', statusCode: 400 });
      }
      const hasFieldUpdates = ['title', 'description', 'executorProvider', 'executorModel', 'sessionId', 'projectPath', 'priority', 'deadline', 'label', 'remark'].some((k) => body[k] !== undefined);
      if (typeof body.status === 'string' && hasFieldUpdates) {
        throw new AppError('cannot update status and fields in the same request', { code: 'INVALID_REQUEST', statusCode: 400 });
      }
      if (typeof body.status === 'string') {
        if (!isTaskStatus(body.status)) {
          throw new AppError(`invalid status: ${body.status}`, { code: 'INVALID_STATUS', statusCode: 400 });
        }
        const row = tasksService.applyStatusChange(taskId, body.status, 'user');
        if (!row) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
        res.json(row);
        return;
      }
      const updates: {
        title?: string;
        description?: string | null;
        executorProvider?: TaskEngine;
        executorModel?: string | null;
        sessionId?: string | null;
        projectPath?: string;
        priority?: TaskPriority;
        deadline?: string | null;
        label?: TaskLabel;
        remark?: string | null;
      } = {};
      if (typeof body.title === 'string') updates.title = body.title;
      if (typeof body.description === 'string') updates.description = body.description;
      if (body.description === null) updates.description = null;
      if (typeof body.executorProvider === 'string') updates.executorProvider = body.executorProvider as TaskEngine;
      if (typeof body.executorModel === 'string') updates.executorModel = body.executorModel;
      if (body.executorModel === null) updates.executorModel = null;
      if (typeof body.sessionId === 'string' || body.sessionId === null) updates.sessionId = body.sessionId;
      if (typeof body.projectPath === 'string') updates.projectPath = body.projectPath;
      if (typeof body.priority === 'string') updates.priority = body.priority as TaskPriority;
      if (typeof body.deadline === 'string') updates.deadline = body.deadline;
      if (body.deadline === null) updates.deadline = null;
      if (typeof body.label === 'string') updates.label = body.label as TaskLabel;
      if (typeof body.remark === 'string') updates.remark = body.remark;
      if (body.remark === null) updates.remark = null;
      const row = await tasksService.updateTask(taskId, updates);
      if (!row) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      res.json(row);
    }),
  );

  // POST /api/tasks/:taskId/start-execution
  router.post(
    '/:taskId/start-execution',
    asyncHandler(async (req, res) => {
      const taskId = String(req.params.taskId);
      const result = tasksService.startExecution(taskId, deps.createSession);
      if (!result) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      res.json(result);
    }),
  );

  // POST /api/tasks/:taskId/move
  router.post(
    '/:taskId/move',
    asyncHandler(async (req, res) => {
      const taskId = String(req.params.taskId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.status !== 'string' || !isTaskStatus(body.status)) {
        throw new AppError('invalid status', { code: 'INVALID_STATUS', statusCode: 400 });
      }
      const beforeId = typeof body.beforeId === 'string' ? body.beforeId : null;
      const afterId = typeof body.afterId === 'string' ? body.afterId : null;
      const row = tasksService.moveTask(taskId, body.status, beforeId, afterId);
      if (!row) throw new AppError('task not found', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      res.json(row);
    }),
  );

  // DELETE /api/tasks/:taskId
  router.delete(
    '/:taskId',
    asyncHandler(async (req, res) => {
      const taskId = String(req.params.taskId);
      tasksService.deleteTask(taskId);
      res.json({ success: true });
    }),
  );

  return router;
}

export default buildTasksRouter;
