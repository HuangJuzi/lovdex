import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

import {
  buildSshTerminalArgv,
  handleTerminalConnection,
  type PtyLike,
  readTerminalCwdUrl,
  readTerminalHostId,
  shellQuote,
} from '@/modules/terminal/terminal-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

const fakeRequest = {} as AuthenticatedWebSocketRequest;

type WsEvent = 'message' | 'close' | 'error';

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

function asSocket(fake: ReturnType<typeof makeFakeWs>): WebSocket {
  return fake as unknown as WebSocket;
}

test('shellQuote wraps in single quotes and escapes embedded quotes', () => {
  assert.equal(shellQuote('/home/u/my project'), `'/home/u/my project'`);
  assert.equal(shellQuote(`/has'quote`), `'/has'\\''quote'`);
});

test('readTerminalCwdUrl returns the cwd param or null', () => {
  assert.equal(readTerminalCwdUrl('/ws/terminal?cwd=%2Fhome%2Fu%2Fproj'), '/home/u/proj');
  assert.equal(readTerminalCwdUrl('/ws/terminal'), null);
});

test('readTerminalHostId returns the hostId param or null', () => {
  assert.equal(readTerminalHostId('/ws/terminal?hostId=h1'), 'h1');
  assert.equal(readTerminalHostId('/ws/terminal'), null);
});

test('buildSshTerminalArgv forces a tty, carries identity and lands in cwd', () => {
  const argv = buildSshTerminalArgv({
    identityFile: '/data/ssh/lovdex_ed25519',
    host: '10.0.0.5',
    port: 22,
    sshUser: 'root',
    cwd: '/home/root/app',
  });
  assert.deepEqual(argv, [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    '-i', '/data/ssh/lovdex_ed25519',
    'root@10.0.0.5',
    `cd '/home/root/app' && exec $SHELL -l`,
  ]);
});

test('buildSshTerminalArgv adds -p for a non-default port and starts in $HOME when cwd is null', () => {
  const argv = buildSshTerminalArgv({ identityFile: null, host: 'h', port: 2222, sshUser: 'u', cwd: null });
  assert.equal(argv[0], '-t');
  assert.ok(argv.includes('-p') && argv.includes('2222'));
  assert.equal(argv[argv.length - 1], 'exec $SHELL -l');
  assert.ok(!argv.some((a) => a.startsWith('-i')));
});

test('buildSshTerminalArgv quotes a spaced cwd in the remote command', () => {
  const argv = buildSshTerminalArgv({ identityFile: null, host: 'h', port: 22, sshUser: 'u', cwd: '/home/u/my proj' });
  assert.equal(argv[argv.length - 1], `cd '/home/u/my proj' && exec $SHELL -l`);
});

test('routes to an ssh pty for a known remote hostId', () => {
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal?hostId=h1&cwd=%2Fremote%2Fproj' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: '/workspace',
    identityFile: '/data/ssh/lovdex_ed25519',
    resolveRemoteHost: (hostId) => (hostId === 'h1' ? { host: '10.0.0.5', port: 2222, sshUser: 'root' } : null),
  });
  const c = captured as { shell: string; args: string[] };
  assert.equal(c.shell, 'ssh');
  assert.ok(c.args.includes('-t'));
  assert.ok(c.args.includes('root@10.0.0.5'));
  assert.ok(c.args.some((a) => a.includes('cd ')));
  assert.ok(c.args.some((a) => a.includes('/remote/proj') || a.includes("'~'")));
});

test('refuses with an error when the hostId is unknown', () => {
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal?hostId=nope' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: () => { throw new Error('must not be called'); },
    shell: 'bash',
    cwd: '/',
    resolveRemoteHost: () => null,
  });
  assert.ok(ws.state.sent.some((m) => m.includes('remote host not found')));
  assert.equal(ws.state.closed, true);
});

test('keeps the local path when no hostId is present', () => {
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: '/workspace',
    identityFile: '/data/ssh/lovdex_ed25519',
    resolveRemoteHost: () => null,
  });
  assert.equal((captured as { shell: string }).shell, '/bin/bash');
  assert.deepEqual((captured as { args: string[] }).args, []);
});

test('remote branch forwards input/output/resize through the ssh pty', () => {
  const pty = makeFakePty();
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal?hostId=h1' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: () => pty,
    shell: 'bash',
    cwd: '/',
    resolveRemoteHost: () => ({ host: 'h', port: 22, sshUser: 'u' }),
  });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\r' })));
  pty.emitData('out\n');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })));
  assert.deepEqual(pty.state.written, ['ls\r']);
  assert.deepEqual(pty.state.resized, [[100, 30]]);
  assert.ok(ws.state.sent.includes(JSON.stringify({ type: 'output', data: 'out\n' })));
  pty.emitExit(0);
  assert.equal(ws.state.closed, true);
});
