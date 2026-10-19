import { Router } from 'express';

import type { AppConfigApi } from './config.js';
import { syncProviderEnv } from './env-sync.js';
import { UnknownProfileError, applyProfileSelections } from './provider-profiles.js';

/**
 * Config HTTP API.
 *   GET /api/config — masked config, ANONYMOUS (login page needs it).
 *   PUT /api/config — partial update, requires JWT auth (authenticateToken
 *   middleware applied at mount time in server/index.js). Runtime writes
 *   re-sync provider env so save takes effect without a restart for new
 *   sessions.
 */

/** GET / — masked view of the whole config. */
export function buildConfigReadRouter(deps: { cfg: AppConfigApi }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(deps.cfg.getMasked());
  });
  return router;
}

/**
 * PUT / — deep-merge a partial update, persist atomically, then re-sync
 * provider env so freshly-saved credentials are immediately available to
 * subsequently-spawned SDK child processes (they snapshot env at spawn —
 * save takes effect for new sessions without a restart), return masked.
 */
export function buildConfigWriteRouter(deps: { cfg: AppConfigApi; onWrite?: () => void }): Router {
  const router = Router();
  router.put('/', (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'config body must be a JSON object' });
    }
    const custom = (body as { providers?: { dsh?: { customModels?: unknown } } })
      ?.providers?.dsh?.customModels;
    if (custom !== undefined
      && (!Array.isArray(custom) || custom.some((v) => typeof v !== 'string'))) {
      return res.status(400).json({ error: 'providers.dsh.customModels must be an array of strings' });
    }
    try {
      // 先解析档选择再合并：被选中的档提供客户端表达不出来的真凭据值，body 自己的
      // 字段再覆盖它（打码字段已被 strip 成 undefined，deepMerge 会保住档里的值）。
      const resolved = applyProfileSelections(deps.cfg, stripMaskedPlaceholders(body));
      syncProviderEnv(deps.cfg.update(resolved));
      deps.onWrite?.();
      res.json(deps.cfg.getMasked());
    } catch (err) {
      if (err instanceof UnknownProfileError) {
        // 整个写被拒绝：静默忽略会看起来像切换成功了。
        return res.status(404).json({ error: { message: err.message } });
      }
      // update() failures are persist/IO faults (EACCES, disk full, corrupt
      // file, ...) — a server-side error. Never mislabel as a client 400 or
      // surface raw fs text.
      console.error('config write failed:', err);
      res.status(500).json({ error: 'config write failed' });
    }
  });
  return router;
}

/**
 * The masked GET response uses '••••' (tail mask) or `****` (apiKey's
 * first6****last6) as placeholders for real secrets. When a client saves that
 * shape back, masked values must not overwrite the real ones. Values beginning
 * with '••••' or containing '****' are treated as "unchanged" and dropped.
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
  if (typeof value === 'string' && (value.startsWith('••••') || value.includes('****'))) {
    return undefined; // drop this key entirely
  }
  return value;
}
