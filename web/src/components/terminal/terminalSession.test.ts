import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalSession } from './terminalSession';

function makeFakeTerm(writes: string[]) {
  let onDataCb: ((d: string) => void) | null = null;
  return {
    disposed: false,
    onData(cb: (d: string) => void) { onDataCb = cb; },
    write(d: string) { writes.push(d); },
    dispose() { this.disposed = true; },
    emitData(d: string) { onDataCb?.(d); },
  };
}

function makeFakeWs(sent: string[]) {
  const listeners = new Map<string, Array<(evt: { data: unknown }) => void>>();
  const closeCalls = [] as number[];
  return {
    readyState: 1,
    closeCalls,
    send(d: string) { sent.push(d); },
    close() { closeCalls.push(1); },
    addEventListener(type: string, cb: (evt: { data: unknown }) => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, cb: (evt: { data: unknown }) => void) {
      const arr = listeners.get(type) ?? [];
      listeners.set(type, arr.filter((x) => x !== cb));
    },
    emitMessage(raw: string) {
      for (const cb of listeners.get('message') ?? []) cb({ data: raw });
    },
  };
}

test('forwards terminal input to the socket as input frames', () => {
  const writes: string[] = [];
  const sent: string[] = [];
  const term = makeFakeTerm(writes);
  const ws = makeFakeWs(sent);
  const session = createTerminalSession(term, ws as never);
  term.emitData('echo hi\r');
  assert.deepEqual(sent, [JSON.stringify({ type: 'input', data: 'echo hi\r' })]);
  session.dispose();
});

test('writes output frames into the terminal', () => {
  const writes: string[] = [];
  const sent: string[] = [];
  const term = makeFakeTerm(writes);
  const ws = makeFakeWs(sent);
  createTerminalSession(term, ws as never);
  ws.emitMessage(JSON.stringify({ type: 'output', data: 'hi\n' }));
  assert.deepEqual(writes, ['hi\n']);
});

test('resize sends a resize frame', () => {
  const sent: string[] = [];
  const term = makeFakeTerm([]);
  const ws = makeFakeWs(sent);
  const session = createTerminalSession(term, ws as never);
  session.resize(120, 40);
  assert.deepEqual(sent, [JSON.stringify({ type: 'resize', cols: 120, rows: 40 })]);
  session.dispose();
});

test('dispose closes the socket and disposes the terminal', () => {
  const writes: string[] = [];
  const sent: string[] = [];
  const term = makeFakeTerm(writes);
  const ws = makeFakeWs(sent);
  const session = createTerminalSession(term, ws as never);
  session.dispose();
  session.dispose(); // idempotent
  assert.equal(term.disposed, true);
  assert.equal(ws.closeCalls.length, 1); // close idempotent on the ws side too

  // message listener was removed on dispose: post-close frames are ignored
  ws.emitMessage(JSON.stringify({ type: 'output', data: 'after-close' }));
  assert.deepEqual(writes, []);
});
