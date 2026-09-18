import path from 'path';
import fs from 'node:fs';
import fsp from 'fs/promises';
import express from 'express';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { sessionsDb, tasksDb } from '../modules/database/index.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';
import { sessionsService } from '../modules/providers/services/sessions.service.js';
import { createOperatorDeleteService } from '../modules/operators/operator-delete.service.js';
import * as gitRewind from '../services/git-rewind.js';

const productionDeps = {
  sessionsDb,
  chatRunRegistry,
  forkSession,
  gitRewind,
  deleteSession: createOperatorDeleteService({
    sessionsDb,
    tasksDb,
    deleteSessionHard: (sessionId) =>
      sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true }),
    isSessionRunning: (sessionId) =>
      chatRunRegistry.listRunningRuns().some((run) => run.sessionId === sessionId),
  }).deleteSession,
};

/**
 * Fork an app session into a new one via the SDK's forkSession.
 * Returns { status, body } so it can be unit-tested with injected deps.
 */
export async function forkAppSession(deps, appId, { upToMessageId, suffix } = {}) {
  const { sessionsDb: db, chatRunRegistry: reg, forkSession: fork } = deps;
  const row = db.getSessionById(appId);
  if (!row) return { status: 404, body: { error: { message: 'Session not found' } } };
  if (!row.provider_session_id) {
    return { status: 409, body: { error: { code: 'SESSION_NOT_STARTED', message: 'Conversation has not started yet' } } };
  }
  if (row.provider !== 'claude') {
    return { status: 409, body: { error: { code: 'UNSUPPORTED_PROVIDER', message: 'Not supported for this provider' } } };
  }
  if (reg.isProcessing(appId)) {
    return { status: 409, body: { error: { code: 'RUN_IN_PROGRESS', message: 'Stop the running response first' } } };
  }
  const { sessionId: newProviderId } = await fork(
    row.provider_session_id,
    upToMessageId ? { upToMessageId } : undefined,
  );
  const newAppId = db.createAppSession(row.provider, row.project_path, Boolean(row.is_operator));
  const baseName = row.custom_name || row.summary || 'Session';
  db.updateSessionCustomName(newAppId, `${baseName} (${suffix})`);
  db.assignProviderSessionId(newAppId, newProviderId);
  return { status: 200, body: { newSessionId: newAppId, providerSessionId: newProviderId } };
}

/**
 * Rewind: fork the conversation to a chosen turn, then best-effort rewind
 * tracked files to the git commit at or before the turn's timestamp.
 * Returns { status, body } (body may include `warnings: string[]`).
 */
export async function rewindAppSession(deps, appId, { upToMessageId, turnTimestamp } = {}) {
  const forkResult = await forkAppSession(deps, appId, { upToMessageId, suffix: 'rewind' });
  if (forkResult.status !== 200) return forkResult;
  const warnings = [];
  const row = deps.sessionsDb.getSessionById(appId);
  const projectPath = row?.project_path;
  if (!projectPath) {
    return { ...forkResult, body: { ...forkResult.body, warnings } };
  }
  const git = deps.gitRewind;
  const isRepo = await git.isGitRepo(projectPath);
  if (!isRepo) {
    warnings.push('file-rewind:not-a-git-repo');
    return { ...forkResult, body: { ...forkResult.body, warnings } };
  }
  const commit = await git.findCommitAtOrBefore(projectPath, turnTimestamp);
  if (!commit) {
    warnings.push('file-rewind:no-covering-commit');
    return { ...forkResult, body: { ...forkResult.body, warnings } };
  }
  await git.rewindFilesToCommit(projectPath, commit);
  return { ...forkResult, body: { ...forkResult.body, warnings } };
}

/**
 * Reads a workflow script file for the "edit script" card action.
 * Whitelist: `path` must resolve inside the session's transcript directory
 * (the dirname of the session jsonl_path). Returns { status, body } so it
 * can be unit-tested with injected deps.
 * @param {{ path?: string, sessionDir?: string }} input
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function readWorkflowScript({ path: rawPath, sessionDir }) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { status: 400, body: { error: { message: 'path is required' } } };
  }
  if (!sessionDir || typeof sessionDir !== 'string') {
    return { status: 400, body: { error: { message: 'sessionDir is required' } } };
  }
  const resolved = path.resolve(rawPath);
  const root = path.resolve(sessionDir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { status: 403, body: { error: { message: 'path is outside the session directory' } } };
  }
  try {
    await fsp.access(resolved, fs.constants.R_OK);
  } catch {
    return { status: 404, body: { error: { message: 'workflow script not found' } } };
  }
  const content = await fsp.readFile(resolved, 'utf8');
  return { status: 200, body: { content, path: resolved } };
}

/**
 * Hard-deletes a session (DB row + transcript file) through the injected
 * delete service, mapping its AppError (statusCode/code) to a { status, body }
 * envelope so it can be unit-tested with injected deps. `cascade` is the
 * explicit confirmation for deleting a session still linked to a task.
 */
export async function deleteAppSession(deps, appId, { cascade = false } = {}) {
  try {
    const result = await deps.deleteSession({ sessionId: appId, cascade });
    return { status: 200, body: result };
  } catch (err) {
    const status = err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    return {
      status,
      body: {
        error: {
          code: (err && err.code) || 'INTERNAL_ERROR',
          message: (err && err.message) || String(err),
        },
      },
    };
  }
}

function buildRouter(deps) {
  const r = express.Router();
  r.post('/:appId/fork', async (req, res) => {
    try {
      const { status, body } = await forkAppSession(deps, req.params.appId, {
        upToMessageId: req.body?.upToMessageId,
        suffix: 'fork',
      });
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
  r.post('/:appId/rewind', async (req, res) => {
    try {
      const { status, body } = await rewindAppSession(deps, req.params.appId, {
        upToMessageId: req.body?.upToMessageId,
        turnTimestamp: req.body?.turnTimestamp,
      });
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
  r.delete('/:appId', async (req, res) => {
    const { status, body } = await deleteAppSession(deps, req.params.appId, {
      cascade: req.query.cascade === 'true' || req.body?.cascade === true,
    });
    res.status(status).json(body);
  });
  r.get('/:appId/workflow-script', async (req, res) => {
    try {
      const row = deps.sessionsDb.getSessionById(req.params.appId);
      if (!row) {
        return res.status(404).json({ error: { message: 'Session not found' } });
      }
      if (!row.jsonl_path) {
        return res.status(409).json({ error: { code: 'NO_TRANSCRIPT', message: 'Session has no transcript yet' } });
      }
      const sessionDir = path.dirname(row.jsonl_path);
      const { status, body } = await readWorkflowScript({
        path: req.query.path,
        sessionDir,
      });
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
  return r;
}

export const sessionsRouter = (deps) => buildRouter(deps ?? productionDeps);
export default buildRouter(productionDeps);
