import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import type { NotificationsService } from './notifications.service.js';

export function buildNotificationsRouter(svc: NotificationsService) {
  const router = express.Router();

  // GET /?unread=true&limit=50&offset=0
  router.get('/', asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unread === 'true';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    res.json(svc.list({ limit, offset, unreadOnly }));
  }));

  router.get('/unread-count', asyncHandler(async (_req, res) => {
    res.json({ unreadCount: svc.unreadCount() });
  }));

  // 必须在 /:id/read 之前注册，否则 read-all 会被 :id 吞掉。
  router.post('/read-all', asyncHandler(async (_req, res) => {
    svc.markAllRead();
    res.json({ success: true, unreadCount: svc.unreadCount() });
  }));

  router.post('/:id/read', asyncHandler(async (req, res) => {
    const row = svc.markRead(String(req.params.id));
    if (!row) throw new AppError('notification not found', { code: 'NOTIFICATION_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  return router;
}

export default buildNotificationsRouter;
