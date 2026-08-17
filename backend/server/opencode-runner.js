/**
 * OpenCode CLI Integration
 * =========================
 *
 * Drives the real `opencode` CLI in non-interactive `run --format json` mode,
 * falling back to the local `sophcode` binary (an opencode fork) when no
 * `opencode` binary is on PATH. This is the first CLI-based provider runtime
 * in lovdex — claude/codex use official SDKs, but opencode has no SDK, so the
 * runner spawns the CLI and parses its NDJSON event stream
 * (`step_start` / `text` / `step_finish`).
 *
 * ## Usage
 *
 * - queryOpenCode(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortOpenCodeSession(sessionId) - Cancel an active session
 * - isOpenCodeSessionActive(sessionId) - Check if a session is running
 * - getActiveOpenCodeSessions() - List all active sessions
 */

import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { spawn } from 'cross-spawn';

import { appendImagesInputTag, normalizeImageDescriptors } from './shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeOpenCodeProcesses = new Map();

/**
 * Maps the UI permission mode onto opencode's non-interactive controls.
 *
 * opencode has no single "permission mode" flag; each mode
 * uses a different lever of the `opencode run` CLI:
 * - plan              → the built-in read-only `plan` agent (`--agent plan`).
 * - bypassPermissions → `--auto`, which auto-approves every permission that
 *                       is not explicitly denied in the user's config.
 * - acceptEdits       → the OPENCODE_PERMISSION env var, whose JSON body the
 *                       CLI merges into its permission config. Forcing
 *                       `edit: allow` guarantees file edits go through while
 *                       every other rule stays under the user's own config.
 * - default           → nothing; the user's config governs.
 *
 * Exported for tests.
 */
export function resolveOpenCodePermissionOptions(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--auto'], env: {} };
    case 'acceptEdits':
      return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default:
      return { args: [], env: {} };
  }
}

/**
 * Resolves the working directory to hand to a `opencode run` invocation.
 *
 * A session's transcript directory lives in opencode.db (`directory`, with
 * `path` as the git-relative fallback for older rows). When the caller does not
 * supply a cwd — which happens after the session synchronizer loses a project
 * path — resuming with an empty `--dir` makes the CLI look for the session's
 * worktree in the wrong place and hang. Falling back to the session's own
 * recorded directory keeps existing sessions resumable without waiting on a
 * re-sync. Exported for tests.
 */
export function resolveOpenCodeCwd(providerSessionId, cwd) {
  const explicitCwd = cwd && String(cwd).trim() ? String(cwd).trim() : '';
  if (explicitCwd) {
    return explicitCwd;
  }
  if (!providerSessionId) {
    return process.cwd();
  }
  try {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT directory, path FROM session WHERE id = ?').get(providerSessionId);
      const stored = row ? String(row.directory || row.path || '').trim() : '';
      return stored || process.cwd();
    } finally {
      db.close();
    }
  } catch {
    return process.cwd();
  }
}

/**
 * Parses one NDJSON event line from `opencode run --format json` and returns
 * the normalized messages it maps to (may be empty). `state` tracks the
 * captured session id and per-message accumulated text for delta streaming.
 *
 * Exported for tests.
 */
export function parseOpenCodeJsonLine(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const part = event.part;
  const sessionId = event.sessionID || part?.sessionID || state.sessionId || null;
  if (sessionId) {
    state.sessionId = sessionId;
  }

  const messages = [];

  if (event.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
    const key = part.messageID || part.id;
    const previous = state.textByMessage.get(key) || '';
    const text = part.text;
    let delta;
    if (text.startsWith(previous)) {
      delta = text.slice(previous.length);
    } else {
      // Rewritten / shorter text: emit the whole thing so the UI replaces.
      delta = text;
      state.textByMessage.set(key, '');
    }
    if (delta) {
      messages.push(createNormalizedMessage({
        kind: 'stream_delta',
        content: delta,
        sessionId,
        provider: 'opencode',
      }));
    }
    state.textByMessage.set(key, text);
  }

  if (event.type === 'step_finish') {
    const key = part?.messageID || part?.id;
    if (key && state.textByMessage.has(key)) {
      messages.push(createNormalizedMessage({ kind: 'stream_end', sessionId, provider: 'opencode' }));
      state.textByMessage.delete(key);
    }
    if (part?.tokens) {
      const t = part.tokens;
      const input = Number(t.input || 0);
      const output = Number(t.output || 0);
      const used = Number(t.total || 0) || input + output;
      messages.push(createNormalizedMessage({
        kind: 'status',
        text: 'token_budget',
        tokenBudget: {
          used,
          inputTokens: input,
          outputTokens: output,
          breakdown: { input, output },
        },
        sessionId,
        provider: 'opencode',
      }));
    }
  }

  return messages;
}

function sendMessage(ws, data) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[opencode-runner] send failed', error.message || error);
  }
}

/**
 * Detects whether a real `opencode` binary is on PATH. This is the live probe
 * behind `resolveOpenCodeBinary` when neither `options.bin` nor the
 * `OPENCODE_BIN` env var is set. Exported for tests.
 */
export function probeOpenCodeInstalled() {
  try {
    const r = spawn.sync('opencode', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolves which CLI binary `queryOpenCode` should spawn. Priority:
 * `options.bin` > `OPENCODE_BIN` env > live `opencode` PATH probe > the
 * `sophcode` fork (kept as a fallback so machines that only carry the local
 * opencode fork keep working). Exported for tests.
 */
export function resolveOpenCodeBinary(opts = {}) {
  const envBin = opts.bin !== undefined ? opts.bin : process.env.OPENCODE_BIN;
  if (envBin && envBin.trim()) {
    return envBin.trim();
  }
  const available = opts.opencodeAvailable !== undefined ? opts.opencodeAvailable : probeOpenCodeInstalled();
  return available ? 'opencode' : 'sophcode';
}

export async function queryOpenCode(command, options = {}, ws) {
  const {
    sessionId = null,
    model,
    effort,
    permissionMode = 'default',
    cwd = process.cwd(),
    images = [],
  } = options;

  const state = { textByMessage: new Map(), sessionId };
  let capturedSessionId = sessionId || null;
  let sessionCreatedSent = false;
  let completeSent = false;
  let terminalFailure = null;

  const resolvedCwd = resolveOpenCodeCwd(capturedSessionId || sessionId, cwd);
  const args = ['run', '--format', 'json', '--dir', resolvedCwd];
  if (capturedSessionId) {
    args.push('--session', capturedSessionId);
  }
  if (model) {
    args.push('--model', model);
  }
  if (effort && effort !== 'default') {
    args.push('--variant', effort);
  }
  const permissionOptions = resolveOpenCodePermissionOptions(permissionMode);
  args.push(...permissionOptions.args);

  const hasAttachments = normalizeImageDescriptors(images).length > 0;
  if ((command && command.trim()) || hasAttachments) {
    // Image attachments ride along as an <images_input> path list appended to
    // the prompt; the session history reader strips the tag back out.
    const promptWithImages = appendImagesInputTag(command?.trim() || '', images);
    args.push(promptWithImages);
  }

  const processKey = capturedSessionId || `new-${Date.now()}`;
  const child = spawn(resolveOpenCodeBinary(), args, {
    cwd: resolvedCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...permissionOptions.env },
  });

  activeOpenCodeProcesses.set(processKey, child);
  child.sessionKey = processKey;
  child.stdin.end();

  const emit = (message) => {
    const sessionLabel = capturedSessionId || sessionId || null;
    sendMessage(ws, createNormalizedMessage({ ...message, sessionId: message.sessionId || sessionLabel }));
  };

  child.stdout.setEncoding('utf8');
  let lineBuffer = '';
  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const events = parseOpenCodeJsonLine(line, state);
      if (state.sessionId && !capturedSessionId) {
        capturedSessionId = state.sessionId;
        activeOpenCodeProcesses.set(capturedSessionId, child);
        activeOpenCodeProcesses.delete(processKey);
        if (typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }
        if (!sessionCreatedSent) {
          sessionCreatedSent = true;
          emit(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: capturedSessionId,
            sessionId: capturedSessionId,
            provider: 'opencode',
          }));
        }
      }
      for (const msg of events) {
        emit(msg);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: text,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'opencode',
      }));
    }
  });

  return new Promise((resolve, reject) => {
    child.on('error', async (error) => {
      console.error('[opencode-runner] spawn error', error.message);
      const installed = await providerAuthService.isProviderInstalled('opencode');
      const errorContent = !installed
        ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
        : error.message;
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: errorContent,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'opencode',
      }));
      if (!completeSent) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({ provider: 'opencode', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
      }
      reject(error);
    });

    child.on('close', (code) => {
      activeOpenCodeProcesses.delete(processKey);
      if (capturedSessionId) {
        activeOpenCodeProcesses.delete(capturedSessionId);
      }

      if (lineBuffer.trim()) {
        const events = parseOpenCodeJsonLine(lineBuffer.trim(), state);
        for (const msg of events) {
          emit(msg);
        }
      }

      if (!completeSent && !child.aborted) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({
          provider: 'opencode',
          sessionId: capturedSessionId || sessionId || null,
          actualSessionId: capturedSessionId || sessionId || null,
          exitCode: code === 0 ? 0 : 1,
        }));
        if (code === 0) {
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'opencode',
            sessionId: capturedSessionId || sessionId || null,
            stopReason: 'completed',
          });
        }
      }

      if (code === 0) {
        resolve();
        return;
      }

      terminalFailure = new Error(`OpenCode CLI exited with code ${code}`);
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: capturedSessionId || sessionId || null,
        error: terminalFailure,
      });
      reject(terminalFailure);
    });
  });
}

/**
 * Aborts an active opencode run by killing its child process.
 * The abort-session handler emits the terminal `complete` (aborted: true)
 * on behalf of the run, so the close handler skips its own.
 */
export function abortOpenCodeSession(sessionId) {
  const child = activeOpenCodeProcesses.get(sessionId);
  if (!child) {
    return false;
  }
  child.aborted = true;
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  return true;
}

export function isOpenCodeSessionActive(sessionId) {
  return activeOpenCodeProcesses.has(sessionId);
}

export function getActiveOpenCodeSessions() {
  return Array.from(activeOpenCodeProcesses.keys());
}