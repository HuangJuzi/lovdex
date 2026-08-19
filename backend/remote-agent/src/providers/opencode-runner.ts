/**
 * OpenCode run manager — remote-lite port of `backend/server/opencode-runner.js`.
 *
 * Spawns the `opencode` CLI in non-interactive `run --format json --dir <cwd>`
 * mode, parses its NDJSON event stream, and pushes every normalized message the
 * local runner would `sendMessage(ws, x)` as
 * `{ _remoteNorm: true, message: x }` on `session:<appSessionId>`. The terminal
 * marker `{ type: 'complete' }` is pushed last so main's routing finish()es.
 *
 * Port adaptations vs the local file:
 * - `resolveOpenCodeCwd` drops the better-sqlite3 lookup of the opencode.db
 *   transcript directory — the lite always receives a validated `params.cwd`
 *   from main (and adding a native SQLite dep is out of scope for the lite
 *   bundle); a missing/blank cwd falls back to `process.cwd()`.
 * - `cross-spawn` is replaced by `node:child_process` spawn (the lite runs on
 *   the remote host, which is POSIX in practice; no npm dep added).
 * - env merges `{ ...process.env, ...permissionOptions.env, ...configEnv }`
 *   (never bare configEnv — that would strip PATH).
 * No new npm dependency.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { RunManager, SessionStartParams } from '../agent-run.js';
import type { RunManagerDeps } from './registry.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  type LiteNormalizedMessage,
} from './lite-normalize.js';
import { makeCompleteMarker, buildRunEnv, makeRunRecord, validateRunCwd, type RunRecord } from './run-shared.js';

/**
 * Maps the UI permission mode onto opencode's non-interactive controls — mirror
 * of the local `resolveOpenCodePermissionOptions` (switch at lines 49-62).
 * Exported for tests.
 */
export function resolveOpenCodePermissionOptions(permissionMode: string | undefined): {
  args: string[];
  env: Record<string, string>;
} {
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
 * Resolves the working directory for `opencode run --dir`. The local runner
 * falls back to the opencode.db transcript `directory` for sessions whose
 * project path was lost; the lite always has a validated `params.cwd`, so it
 * only preserves the explicit-cwd + process.cwd() arms.
 * Exported for tests.
 */
export function resolveOpenCodeCwd(providerSessionId: string | null, cwd: string | undefined): string {
  const explicitCwd = cwd && String(cwd).trim() ? String(cwd).trim() : '';
  if (explicitCwd) {
    return explicitCwd;
  }
  void providerSessionId;
  return process.cwd();
}

export type OpenCodeParseState = {
  sessionId: string | null;
  textByMessage: Map<string, string>;
};

/**
 * Parses one NDJSON event line from `opencode run --format json` and returns
 * the normalized messages it maps to — mirror of the local
 * `parseOpenCodeJsonLine` (stream_delta for `text` parts, stream_end +
 * token_budget for `step_finish`). Exported for tests.
 */
export function parseOpenCodeJsonLine(line: string, state: OpenCodeParseState): LiteNormalizedMessage[] {
  let event: Record<string, unknown> | null = null;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const part = event.part as Record<string, unknown> | null | undefined;
  const sessionId = (event.sessionID as string | undefined) || (part?.sessionID as string | undefined) || state.sessionId || null;
  if (sessionId) {
    state.sessionId = sessionId;
  }

  const messages: LiteNormalizedMessage[] = [];

  if (event.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
    const key = (part.messageID as string | undefined) || (part.id as string | undefined) || '';
    const previous = state.textByMessage.get(key) || '';
    const text = part.text as string;
    let delta: string;
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
    const key = (part?.messageID as string | undefined) || (part?.id as string | undefined) || '';
    if (key && state.textByMessage.has(key)) {
      messages.push(createNormalizedMessage({ kind: 'stream_end', sessionId, provider: 'opencode' }));
      state.textByMessage.delete(key);
    }
    if (part?.tokens) {
      const t = part.tokens as Record<string, unknown>;
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

/**
 * Detects whether a real `opencode` binary is on PATH — the live probe behind
 * `resolveOpenCodeBinary`. Exported for tests.
 */
export function probeOpenCodeInstalled(): boolean {
  try {
    const r = spawnSync('opencode', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolves which CLI binary the runner should spawn. Priority:
 * `opts.bin` > `OPENCODE_BIN` env > live `opencode` PATH probe > the
 * `sophcode` fork fallback. Exported for tests.
 */
export function resolveOpenCodeBinary(opts: {
  bin?: string;
  opencodeAvailable?: boolean;
} = {}): string {
  const envBin = opts.bin !== undefined ? opts.bin : process.env.OPENCODE_BIN;
  if (envBin && envBin.trim()) {
    return envBin.trim();
  }
  const available = opts.opencodeAvailable !== undefined ? opts.opencodeAvailable : probeOpenCodeInstalled();
  return available ? 'opencode' : 'sophcode';
}

export function createOpenCodeRunManager(deps: RunManagerDeps): RunManager {
  const runs = new Map<string, RunRecord>();

  function pushNorm(appSessionId: string, message: unknown): void {
    deps.push(`session:${appSessionId}`, { _remoteNorm: true, message });
  }

  async function start(params: SessionStartParams): Promise<{ providerSessionId: string }> {
    const { appSessionId } = params;
    if (runs.has(appSessionId)) {
      throw new Error(`session already running: ${appSessionId}`);
    }
    await validateRunCwd(deps.roots, params.cwd);

    const { run, established, settleEstablished } = makeRunRecord(params);
    let providerSessionId = params.providerSessionId ?? '';
    let sessionCreatedSent = false;
    let completeSent = false;
    runs.set(appSessionId, run);

    void (async () => {
      let runFailed = false;
      let runError = '';
      try {
        const state: OpenCodeParseState = { textByMessage: new Map(), sessionId: providerSessionId || null };
        const child: ChildProcess = spawn(resolveOpenCodeBinary(), buildArgs(params.cwd, providerSessionId, params), {
          cwd: params.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildRunEnv(resolveOpenCodePermissionOptions(params.permissionMode).env, params.configEnv),
        });
        run.child = child;
        child.stdin?.end();
        child.stdin?.on('error', () => {
          /* EPIPE while the CLI is exiting is expected */
        });

        const emit = (message: LiteNormalizedMessage): void => {
          pushNorm(appSessionId, createNormalizedMessage({
            ...message,
            sessionId: (message.sessionId as string | undefined) || providerSessionId || null,
          }));
        };

        child.stdout?.setEncoding('utf8');
        let lineBuffer = '';
        child.stdout?.on('data', (chunk) => {
          lineBuffer += chunk;
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            const events = parseOpenCodeJsonLine(line, state);
            if (state.sessionId && !run.establishedSid) {
              run.establishedSid = true;
              providerSessionId = state.sessionId;
              settleEstablished(providerSessionId);
              if (!sessionCreatedSent) {
                sessionCreatedSent = true;
                emit(createNormalizedMessage({
                  kind: 'session_created',
                  newSessionId: providerSessionId,
                  sessionId: providerSessionId,
                  provider: 'opencode',
                }));
              }
            }
            for (const msg of events) {
              emit(msg);
            }
          }
        });

        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
          const text = chunk.toString();
          if (text.trim()) {
            pushNorm(appSessionId, createNormalizedMessage({
              kind: 'error',
              content: text,
              sessionId: providerSessionId || null,
              provider: 'opencode',
            }));
          }
        });

        await new Promise<void>((resolveSpawn, rejectSpawn) => {
          child.on('error', (err) => {
            if (run.aborted) {
              resolveSpawn();
              return;
            }
            console.error('[opencode-runner] spawn error', err.message);
            pushNorm(appSessionId, createNormalizedMessage({
              kind: 'error',
              content: err.message,
              sessionId: providerSessionId || null,
              provider: 'opencode',
            }));
            if (!completeSent) {
              completeSent = true;
              pushNorm(appSessionId, createCompleteMessage({
                provider: 'opencode',
                sessionId: providerSessionId || null,
                exitCode: 1,
              }));
            }
            rejectSpawn(err);
          });

          child.on('close', (code) => {
            if (run.aborted) {
              resolveSpawn();
              return;
            }
            if (lineBuffer.trim()) {
              const events = parseOpenCodeJsonLine(lineBuffer.trim(), state);
              for (const msg of events) {
                emit(msg);
              }
            }
            if (!completeSent) {
              completeSent = true;
              pushNorm(appSessionId, createCompleteMessage({
                provider: 'opencode',
                sessionId: providerSessionId || null,
                actualSessionId: providerSessionId || null,
                exitCode: code === 0 ? 0 : 1,
              }));
            }
            if (code === 0) {
              resolveSpawn();
            } else {
              const failure = new Error(`OpenCode CLI exited with code ${code}`);
              console.error(`[opencode-runner] session ${appSessionId} failed:`, failure.message);
              rejectSpawn(failure);
            }
          });
        });
      } catch (err) {
        if (!run.aborted) {
          runFailed = true;
          runError = err instanceof Error ? err.message : String(err);
          console.error(`[opencode-runner] session ${appSessionId} failed:`, runError);
        }
      } finally {
        run.doneResolve();
        runs.delete(appSessionId);
      }
      deps.push(`session:${appSessionId}`, makeCompleteMarker(runFailed, runError));
      settleEstablished(providerSessionId);
    })();

    return { providerSessionId: await established };
  }

  function whenDone(appSessionId: string): Promise<void> {
    return runs.get(appSessionId)?.done ?? Promise.resolve();
  }

  function interrupt(appSessionId: string): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }
    run.aborted = true;
    try {
      run.controller.abort();
    } catch {
      /* ignore */
    }
    if (run.child) {
      try {
        run.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  function interruptAll(): number {
    const ids = Array.from(runs.keys());
    for (const id of ids) interrupt(id);
    return ids.length;
  }

  return { start, respond: () => false, whenDone, interrupt, interruptAll };
}

/** Builds the `opencode run` argument vector (mirror of the local queryOpenCode). */
function buildArgs(cwd: string, providerSessionId: string | null, params: SessionStartParams): string[] {
  const args = ['run', '--format', 'json', '--dir', cwd];
  if (providerSessionId) {
    args.push('--session', providerSessionId);
  }
  if (params.model) {
    args.push('--model', params.model);
  }
  const permissionOptions = resolveOpenCodePermissionOptions(params.permissionMode);
  args.push(...permissionOptions.args);
  const trimmedPrompt = params.command?.trim();
  if (trimmedPrompt) {
    args.push(trimmedPrompt);
  }
  return args;
}