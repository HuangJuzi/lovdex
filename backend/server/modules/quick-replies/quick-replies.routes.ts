import express from 'express';

import { asyncHandler } from '@/shared/utils.js';
import type { QuickRepliesService } from './quick-replies.service.js';

export function buildQuickRepliesRouter(svc: QuickRepliesService) {
  const router = express.Router();

  // 行直接透出 snake_case（与其他业务表 API 一致，前端 inboxStore 也是这么消费
  // notifications 的），不做 camelCase 映射。
  router.get('/', asyncHandler(async (_req, res) => {
    res.json({ items: svc.list() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.status(201).json(svc.create(content));
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.json(svc.update(String(req.params.id), content));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    svc.remove(String(req.params.id));
    res.json({ success: true });
  }));

  // 打点用：只刷新 last_used_at，不碰正文。
  router.post('/:id/use', asyncHandler(async (req, res) => {
    res.json(svc.use(String(req.params.id)));
  }));

  return router;
}

export default buildQuickRepliesRouter;
