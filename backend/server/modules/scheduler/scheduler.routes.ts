import express from 'express';

import { isScheduleType } from '@/modules/database/repositories/scheduled-tasks.db.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

export type SchedulerServiceLike = {
  list: (filter: { projectPath?: string; enabled?: boolean }) => unknown[];
  get: (scheduleId: string) => unknown;
  create: (input: Record<string, unknown>) => unknown;
  update: (scheduleId: string, updates: Record<string, unknown>) => unknown;
  remove: (scheduleId: string) => void;
  runNow: (scheduleId: string) => unknown;
  setEnabled: (scheduleId: string, enabled: boolean) => unknown;
};

export function buildSchedulerRouter(svc: SchedulerServiceLike) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
    const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined;
    res.json(svc.list({ projectPath, enabled }));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.scheduleType !== 'string' || !isScheduleType(body.scheduleType)) {
      throw new AppError(`invalid scheduleType: ${String(body.scheduleType)}`, { code: 'INVALID_SCHEDULE_TYPE', statusCode: 400 });
    }
    res.status(201).json(svc.create(body));
  }));

  router.get('/:scheduleId', asyncHandler(async (req, res) => {
    const row = svc.get(String(req.params.scheduleId));
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.patch('/:scheduleId', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.scheduleType !== undefined && (typeof body.scheduleType !== 'string' || !isScheduleType(body.scheduleType))) {
      throw new AppError(`invalid scheduleType: ${String(body.scheduleType)}`, { code: 'INVALID_SCHEDULE_TYPE', statusCode: 400 });
    }
    const row = svc.update(String(req.params.scheduleId), body);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.delete('/:scheduleId', asyncHandler(async (req, res) => {
    svc.remove(String(req.params.scheduleId));
    res.json({ success: true });
  }));

  router.post('/:scheduleId/run-now', asyncHandler(async (req, res) => {
    const result = svc.runNow(String(req.params.scheduleId));
    if (!result) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(result);
  }));

  router.post('/:scheduleId/enable', asyncHandler(async (req, res) => {
    const row = svc.setEnabled(String(req.params.scheduleId), true);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  router.post('/:scheduleId/disable', asyncHandler(async (req, res) => {
    const row = svc.setEnabled(String(req.params.scheduleId), false);
    if (!row) throw new AppError('schedule not found', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  return router;
}

export default buildSchedulerRouter;
