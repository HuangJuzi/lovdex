import fs from 'node:fs';
import path from 'node:path';

import type { WebSocket } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

/** Minimal surface of node-pty's spawned process this module depends on. */
export type PtyLike = {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

export type PtySpawner = (
  shell: string,
  args: string[],
  options: { cwd: string; cols: number; rows: number; env: Record<string, string> },
) => PtyLike;

export type TerminalDependencies = {
  spawnPty: PtySpawner;
  shell: string;
  cwd: string;
  /** Resolve the ssh target (remote_hosts row) for a hostId; null when unknown. */
  resolveRemoteHost?: (hostId: string) => RemoteTerminalHost | null;
  /** Main→host Lovdex ed25519 key for `ssh -t`; null/undefined → no -i. */
  identityFile?: string | null;
};

const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

type ClientMessage = { type: string; data?: unknown; cols?: unknown; rows?: unknown };

function parseMessage(raw: WebSocket.RawData): ClientMessage | null {
  try {
    const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    return {
      type: typeof parsed.type === 'string' ? parsed.type : '',
      data: parsed.data,
      cols: parsed.cols,
      rows: parsed.rows,
    };
  } catch {
    return null;
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Remote ssh target resolved from a remote_hosts row. */
export type RemoteTerminalHost = { host: string; port: number | null; sshUser: string };

/** Single-quote a remote path for embedding in the ssh command argument
 *  (argv-array discipline — never build a shell string from user input). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Parse the ?cwd= query param WITHOUT touching the local fs — the remote
 *  branch cannot stat a path that lives on the target machine. */
export function readTerminalCwdUrl(rawUrl: string | undefined): string | null {
  try {
    const requested = new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('cwd');
    return requested && requested.length > 0 ? requested : null;
  } catch {
    return null;
  }
}

/** Parse the ?hostId= query param used to route a terminal to a remote host. */
export function readTerminalHostId(rawUrl: string | undefined): string | null {
  try {
    const id = new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('hostId');
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * argv for an interactive `ssh -t` into the remote host, landing the shell in
 * `cwd` when given (a bad directory fails the remote shell and exits cleanly)
 * or in $HOME otherwise. Mirror bootstrap.service `sshArgs` flag discipline
 * (accept-new / ConnectTimeout / BatchMode) plus `-t` for the PTY and the
 * remote `cd`.
 */
export function buildSshTerminalArgv(input: {
  identityFile: string | null;
  host: string;
  port: number | null;
  sshUser: string;
  cwd: string | null;
}): string[] {
  const argv = [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
  ];
  if (input.identityFile) argv.push('-i', input.identityFile);
  if (input.port && input.port !== 22) argv.push('-p', String(input.port));
  argv.push(
    `${input.sshUser}@${input.host}`,
    input.cwd ? `cd ${shellQuote(input.cwd)} && exec $SHELL -l` : `exec $SHELL -l`,
  );
  return argv;
}

/**
 * Resolves the starting directory for a terminal session.
 *
 * The client may request a project directory via `?cwd=` on the upgrade URL;
 * it is honored only when it is an existing directory inside `workspaceRoot`
 * (lexical containment, matching the workspace model used elsewhere). Anything
 * else — missing, malformed, outside the root, or not a directory — falls back
 * to the root so a bad request can never land the shell in an unexpected place.
 */
export function resolveTerminalCwd(rawUrl: string | undefined, workspaceRoot: string): string {
  let requested: string | null = null;
  try {
    requested = new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('cwd');
  } catch {
    return workspaceRoot;
  }
  if (!requested) return workspaceRoot;

  try {
    const absolute = path.resolve(requested);
    const root = path.resolve(workspaceRoot);
    const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    const withinRoot = absolute === root || absolute.startsWith(normalizedRoot);
    if (!withinRoot) return workspaceRoot;
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return workspaceRoot;
    return absolute;
  } catch {
    return workspaceRoot;
  }
}

/**
 * Handles a single /ws/terminal connection: spawns one PTY, pipes the client's
 * input/resize frames into it and its output back out. Closing the socket kills
 * the PTY; PTY exit closes the socket.
 */
export function handleTerminalConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: TerminalDependencies,
): void {
  let pty: PtyLike;
  try {
    pty = dependencies.spawnPty(dependencies.shell, [], {
      cwd: resolveTerminalCwd(request.url, dependencies.cwd),
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
    });
  } catch {
    send(ws, { type: 'error', message: 'failed to spawn shell' });
    ws.close();
    return;
  }

  pty.onData((data) => {
    send(ws, { type: 'output', data });
  });

  pty.onExit(({ exitCode }) => {
    send(ws, { type: 'exit', code: exitCode });
    ws.close();
  });

  ws.on('message', (raw) => {
    const message = parseMessage(raw);
    if (!message) return;
    if (message.type === 'input' && typeof message.data === 'string') {
      pty.write(message.data);
    } else if (message.type === 'resize') {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        pty.resize(cols, rows);
      }
    }
  });

  ws.on('close', () => pty.kill());
  ws.on('error', () => pty.kill());
}
