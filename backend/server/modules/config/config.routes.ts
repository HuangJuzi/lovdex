import { Router } from 'express';

import { maskConfig } from './config.js';
import type { AppConfigApi } from './config.js';

/**
 * Config HTTP API.
 *   GET /api/config — masked config, ANONYMOUS (login page needs it).
 *   PUT /api/config — partial update, requires JWT auth (authenticateToken
 *   middleware applied at mount time in server/index.js).
 */

/** GET / — masked view of the whole config. */
export function buildConfigReadRouter(deps: { cfg: AppConfigApi }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(maskConfig(deps.cfg.get()));
  });
  return router;
}

/** PUT / — deep-merge a partial update, persist atomically, return masked. */
export function buildConfigWriteRouter(deps: { cfg: AppConfigApi }): Router {
  const router = Router();
  router.put('/', (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'config body must be a JSON object' });
    }
    try {
      const next = deps.cfg.update(stripMaskedPlaceholders(body));
      res.json(maskConfig(next));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}

/**
 * The masked GET response uses '••••' as a placeholder for real secrets. When a
 * client saves that shape back, masked values must not overwrite the real ones.
 * Values beginning with '••••' are treated as "unchanged" and dropped.
 */
function stripMaskedPlaceholders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripMaskedPlaceholders(v));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripMaskedPlaceholders(v);
    }
    return out;
  }
  if (typeof value === 'string' && value.startsWith('••••')) {
    return undefined; // drop this key entirely
  }
  return value;
}