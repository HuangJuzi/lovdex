import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { WebSocket } from 'ws';

import { handleTerminalConnection, resolveTerminalCwd, type PtyLike } from '@/modules/terminal/terminal-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

const fakeRequest = {} as AuthenticatedWebSocketRequest;

function makeFakePty() {
  const state = { written: [] as string[], resized: [] as Array<[number, number]>, killed: false };
  let onDataCb: ((d: string) => void) | null = null;
  let onExitCb: ((i: { exitCode: number }) => void) | null = null;
  const pty: PtyLike & { state: typeof state; emitData: (d: string) => void; emitExit: (code: number) => void } = {
    state,
    onData(cb) { onDataCb = cb; },
    onExit(cb) { onExitCb = cb; },
    write(d) { state.written.push(d); },
    resize(c, r) { state.resized.push([c, r]); },
    kill() { state.killed = true; },
    emitData(d) { onDataCb?.(d); },
    emitExit(code) { onExitCb?.({ exitCode: code }); },
  };
  return pty;
}

type WsEvent = 'message' | 'close' | 'error';

function makeFakeWs() {
  const state = { sent: [] as string[], closed: false };
  const listeners = new Map<WsEvent, Array<(...args: never[]) => void>>();
  const ws = {
    state,
    OPEN: 1,
    readyState: 1,
    send(m: string) { state.sent.push(m); },
    close() { state.closed = true; },
    on(evt: WsEvent, cb: (...args: never[]) => void) {
      const arr = listeners.get(evt) ?? [];
      arr.push(cb);
      listeners.set(evt, arr);
    },
    emit(evt: WsEvent, ...args: unknown[]) {
      for (const cb of listeners.get(evt) ?? []) (cb as (...a: unknown[]) => void)(...args);
    },
  };
  return ws;
}

/** The fake exposes extra helpers (emit/state); cast to ws.WebSocket for the handler param. */
function asSocket(fake: ReturnType<typeof makeFakeWs>): WebSocket {
  return fake as unknown as WebSocket;
}

test('spawns a PTY with the configured shell and cwd', () => {
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/zsh',
    cwd: '/workspace',
  });
  assert.deepEqual(captured, {
    shell: '/bin/zsh',
    args: [],
    options: { cwd: '/workspace', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } },
  });
});

test('spawns in a requested cwd when it is an existing directory inside the workspace root', () => {
  const root = path.resolve(process.cwd(), '..');
  const target = process.cwd();
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  const request = { url: `/ws/terminal?cwd=${encodeURIComponent(target)}` } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: root,
  });
  assert.equal((captured as { options: { cwd: string } }).options.cwd, target);
});

test('falls back to the workspace root when the requested cwd is outside it', () => {
  const root = path.resolve(process.cwd(), '..');
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal?cwd=%2Fetc' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: root,
  });
  assert.equal((captured as { options: { cwd: string } }).options.cwd, root);
});

test('falls back to the workspace root when the requested cwd is not a directory', () => {
  const root = process.cwd();
  const missing = path.join(root, 'definitely-not-a-real-dir');
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  const request = { url: `/ws/terminal?cwd=${encodeURIComponent(missing)}` } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: root,
  });
  assert.equal((captured as { options: { cwd: string } }).options.cwd, root);
});

test('falls back to the workspace root when no cwd is requested', () => {
  const root = process.cwd();
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: root,
  });
  assert.equal((captured as { options: { cwd: string } }).options.cwd, root);
});

// ---------------------------------------------------------------------------
// Registered projects are NOT confined to the workspace root: the projects
// table routinely holds paths like /mnt/b/workdir/... or /tmp/... while the
// workspace root is ~. A terminal asked to start in one of those must land
// there instead of silently dropping the user in the root (home).
// ---------------------------------------------------------------------------

/**
 * A hermetic directory layout:
 *   <tmp>/workspace          the workspace root (stands in for ~)
 *   <tmp>/workspace/inside   a directory inside the workspace root
 *   <tmp>/projects/repo      a registered project, OUTSIDE the workspace root
 *   <tmp>/projects/repo/sub  a directory inside that project
 *   <tmp>/projects           the parent of a project — not itself a project
 */
function makeProjectLayout(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-terminal-cwd-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const workspaceRoot = path.join(root, 'workspace');
  const insideWorkspace = path.join(workspaceRoot, 'inside');
  const projectRoot = path.join(root, 'projects', 'repo');
  const projectSubdir = path.join(projectRoot, 'sub');

  fs.mkdirSync(insideWorkspace, { recursive: true });
  fs.mkdirSync(projectSubdir, { recursive: true });

  return {
    workspaceRoot,
    insideWorkspace,
    projectRoot,
    projectSubdir,
    projectsParent: path.join(root, 'projects'),
  };
}

function cwdUrl(cwd: string): string {
  return `/ws/terminal?cwd=${encodeURIComponent(cwd)}`;
}

test('resolveTerminalCwd honors a registered project outside the workspace root', (t) => {
  const { workspaceRoot, projectRoot } = makeProjectLayout(t);
  assert.equal(resolveTerminalCwd(cwdUrl(projectRoot), workspaceRoot, [projectRoot]), projectRoot);
});

test('resolveTerminalCwd honors a directory inside a registered project', (t) => {
  const { workspaceRoot, projectRoot, projectSubdir } = makeProjectLayout(t);
  assert.equal(resolveTerminalCwd(cwdUrl(projectSubdir), workspaceRoot, [projectRoot]), projectSubdir);
});

test('resolveTerminalCwd still honors a directory inside the workspace root', (t) => {
  const { workspaceRoot, insideWorkspace } = makeProjectLayout(t);
  assert.equal(resolveTerminalCwd(cwdUrl(insideWorkspace), workspaceRoot, []), insideWorkspace);
});

test('resolveTerminalCwd falls back for a path that is neither in the root nor a project', (t) => {
  const { workspaceRoot, projectRoot, projectsParent } = makeProjectLayout(t);
  // The parent OF a registered project is not itself part of the project.
  assert.equal(resolveTerminalCwd(cwdUrl(projectsParent), workspaceRoot, [projectRoot]), workspaceRoot);
});

test('resolveTerminalCwd falls back for a registered project when no projects are known', (t) => {
  const { workspaceRoot, projectRoot } = makeProjectLayout(t);
  assert.equal(resolveTerminalCwd(cwdUrl(projectRoot), workspaceRoot), workspaceRoot);
});

test('resolveTerminalCwd is not fooled by traversal out of a registered project', (t) => {
  const { workspaceRoot, projectRoot } = makeProjectLayout(t);
  const escape = path.join(projectRoot, '..', '..', '..', 'etc');
  assert.equal(resolveTerminalCwd(cwdUrl(escape), workspaceRoot, [projectRoot]), workspaceRoot);
});

test('resolveTerminalCwd still rejects paths outside both boundaries', (t) => {
  const { workspaceRoot, projectRoot } = makeProjectLayout(t);
  assert.equal(resolveTerminalCwd('/ws/terminal?cwd=%2Fetc', workspaceRoot, [projectRoot]), workspaceRoot);
});

test('spawns in a registered project directory outside the workspace root', (t) => {
  const { workspaceRoot, projectRoot } = makeProjectLayout(t);
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), { url: cwdUrl(projectRoot) } as AuthenticatedWebSocketRequest, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: workspaceRoot,
    projectRoots: () => [projectRoot],
  });
  assert.equal((captured as { options: { cwd: string } }).options.cwd, projectRoot);
});

test('forwards input messages to the pty', () => {
  const pty = makeFakePty();
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\r' })));
  assert.deepEqual(pty.state.written, ['ls\r']);
});

test('sends pty output to the client', () => {
  const pty = makeFakePty();
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
  pty.emitData('hello\n');
  assert.deepEqual(ws.state.sent, [JSON.stringify({ type: 'output', data: 'hello\n' })]);
});

test('forwards resize and ignores invalid sizes', () => {
  const pty = makeFakePty();
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 0, rows: -5 })));
  assert.deepEqual(pty.state.resized, [[120, 40]]);
});

test('sends exit and closes the socket when the pty exits', () => {
  const pty = makeFakePty();
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
  pty.emitExit(0);
  assert.ok(ws.state.sent.includes(JSON.stringify({ type: 'exit', code: 0 })));
  assert.equal(ws.state.closed, true);
});

test('kills the pty when the socket closes', () => {
  const pty = makeFakePty();
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
  ws.emit('close');
  assert.equal(pty.state.killed, true);
});

test('sends an error and closes when spawn fails', () => {
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, {
    spawnPty: () => { throw new Error('boom'); },
    shell: 'bash',
    cwd: '/',
  });
  assert.ok(ws.state.sent.some((m) => m.includes('failed to spawn shell')));
  assert.equal(ws.state.closed, true);
});
