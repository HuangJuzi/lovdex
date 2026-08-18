/**
 * Operator skill-execution settings HTTP API (phase 2).
 *
 * Mounted under /api/operator/skill-exec in server/index.js (auth required):
 *
 *   GET    /allowlist            → { allowlist, source }  (effective config)
 *   PUT    /allowlist            → persist DB override; 409 when env wins
 *   DELETE /allowlist            → clear the DB override (file/default apply)
 *   GET    /credentials/status   → presence booleans + file metadata, NO values
 *   PUT    /credentials          → write ~/.claw/cred.json (0600), NO echo
 *   POST   /credentials/test     → run claw-agent-get-send groups once (sanitized)
 *   GET    /audit                → operator_exec_audit rows (sanitized)
 *
 * Credential values NEVER appear in any response or log — the status endpoint
 * reports presence booleans only.
 */

import express from 'express';

import {
  getOperatorAllowlistInfo,
  isAllowlistEnvOverrideActive,
  saveOperatorAllowlistOverride,
  clearOperatorAllowlistOverride,
} from '@/modules/operators/operator-allowlist.js';
import {
  getCredentialStatus,
  writeCredFile,
} from '@/modules/operators/credential-resolver.js';
import { operatorAuditDb } from '@/modules/database/repositories/operator-audit.db.js';
import type { OperatorExecService } from '@/modules/operators/operator-exec.service.js';
import { asyncHandler } from '@/shared/utils.js';

export function buildOperatorSkillExecRouter(deps: { execService: OperatorExecService }) {
  const router = express.Router();

  // GET /allowlist — effective allowlist + resolution source.
  router.get(
    '/allowlist',
    asyncHandler(async (_req, res) => {
      const { list, source } = getOperatorAllowlistInfo();
      res.json({ allowlist: list, source, envOverrideActive: isAllowlistEnvOverrideActive() });
    }),
  );

  // PUT /allowlist — persist a DB override (validated first; nothing written
  // on malformed input). 409 when an env override is active because it would
  // silently win over the saved value.
  router.put(
    '/allowlist',
    asyncHandler(async (req, res) => {
      if (isAllowlistEnvOverrideActive()) {
        res.status(409).json({
          error: {
            message:
              'env 白名单覆盖生效中（LOVDEX_OPERATOR_ALLOWLIST_JSON/_PATH），保存不会生效；请先移除 env 覆盖。',
          },
        });
        return;
      }
      try {
        const list = saveOperatorAllowlistOverride(req.body);
        res.json({ allowlist: list, source: 'database', envOverrideActive: false });
      } catch (e) {
        res.status(400).json({
          error: { message: `白名单格式不正确：${e instanceof Error ? e.message : String(e)}` },
        });
      }
    }),
  );

  // DELETE /allowlist — clear the DB override so file/default layers apply.
  router.delete(
    '/allowlist',
    asyncHandler(async (_req, res) => {
      clearOperatorAllowlistOverride();
      const { list, source } = getOperatorAllowlistInfo();
      res.json({ allowlist: list, source, envOverrideActive: isAllowlistEnvOverrideActive() });
    }),
  );

  // GET /credentials/status — presence booleans + file metadata only.
  router.get(
    '/credentials/status',
    asyncHandler(async (_req, res) => {
      res.json(getCredentialStatus());
    }),
  );

  // PUT /credentials — write ~/.claw/cred.json (0600). Never echoes values.
  router.put(
    '/credentials',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { jwt?: string; agentId?: string; userId?: string };
      try {
        writeCredFile({
          jwt: String(body.jwt ?? ''),
          agentId: String(body.agentId ?? ''),
          userId: String(body.userId ?? ''),
        });
      } catch (e) {
        res.status(400).json({
          error: { message: e instanceof Error ? e.message : String(e) },
        });
        return;
      }
      res.json(getCredentialStatus());
    }),
  );

  // POST /credentials/test — connectivity probe: one `groups` call through
  // the normal execute_skill path (allowlist + redaction + audit apply).
  router.post(
    '/credentials/test',
    asyncHandler(async (_req, res) => {
      const result = await deps.execService.executeSkill({
        skillName: 'claw-agent-get-send',
        args: 'groups',
        timeoutMs: 20_000,
      });
      res.json(result);
    }),
  );

  // GET /audit?tool=&decision=&limit= — newest-first audit rows (sanitized).
  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const tool = typeof req.query.tool === 'string' && req.query.tool ? req.query.tool : undefined;
      const decision =
        typeof req.query.decision === 'string' && req.query.decision ? req.query.decision : undefined;
      const limit =
        typeof req.query.limit === 'string' && Number.isInteger(Number(req.query.limit))
          ? Number(req.query.limit)
          : undefined;
      res.json({ rows: operatorAuditDb.list({ tool, decision, limit }) });
    }),
  );

  return router;
}

export default buildOperatorSkillExecRouter;
