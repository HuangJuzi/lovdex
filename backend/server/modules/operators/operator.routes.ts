/**
 * Operator settings HTTP API.
 *
 * Exposes the operator automation config (see operator.config.ts) over a tiny
 * REST surface so the frontend OperatorSettingsPage can read and update it:
 *
 *   GET /api/operator/settings  → current config (merged over safe defaults)
 *   PUT /api/operator/settings  → persist a partial update, return merged config
 *
 * The router is mounted under /api/operator/settings in server/index.js, so the
 * handlers here register at "/".
 */

import express from 'express';

import {
  getOperatorConfig,
  setOperatorConfig,
  type OperatorConfig,
} from '@/modules/operators/operator.config.js';
import { asyncHandler } from '@/shared/utils.js';

export function buildOperatorRouter() {
  const router = express.Router();

  // GET /api/operator/settings — return the full current config.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(getOperatorConfig());
    }),
  );

  // PUT /api/operator/settings — merge a partial body over the current config,
  // persist it, and return the resulting full config.
  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Partial<OperatorConfig>;
      setOperatorConfig(body);
      res.json(getOperatorConfig());
    }),
  );

  return router;
}

export default buildOperatorRouter;
