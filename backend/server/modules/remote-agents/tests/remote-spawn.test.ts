import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';
import { emitPush, removePushListener } from '../remote-agent.server.js';
import { createRemoteRouting } from '../remote-spawn.js';

/**
 * Minimal ws stand-in for a registered lite host. Records every frame the
 * registry sends (so tests can inspect `session/start`, `session/interrupt`,
 * `approval/respond` rpc_req frames) and reports OPEN so `registry.rpc` fires.
 */
function fakeHostWs() {
  const ws = {
    sent: [] as Record<string, unknown>[],
    readyState: WebSocket.OPEN as number,
    OPEN: WebSocket.OPEN,
    close() {
      ws.readyState = WebSocket.CLOSED;
    },
    send(raw: string, cb?: (err?: Error) => void) {
      ws.sent.push(JSON.parse(raw) as Record<string, unknown>);
      cb?.();
    },
  };
  return ws;
}

/** A writer capturing sent messages, mirroring the WebSocketWriter surface. */
function fakeWriter() {
  const w = {
    sent: [] as unknown[],
    sessionId: null as string | null,
    send(msg: unknown) {
      w.sent.push(msg);
    },
    setSessionId(id: string) {
      w.sessionId = id;
    },
  };
  return w;
}

/** Waits a microtask/macrotask turn so async rpc plumbing settles. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function registerHost(registry: ReturnType<typeof createRemoteAgentsRegistry>, hostId: string) {
  const ws = fakeHostWs();
  registry.register({ hostId, roots: ['/srv'], capabilities: ['session/claude'] }, ws as never);
  return ws;
}

test('lookupHost null -> localSpawn is called, no remote rpc', async () => {
  const registry = createRemoteAgentsRegistry();
  const routing = createRemoteRouting({
    lookupHost: () => null,
    registry,
    normalizeEvent: (raw) => [raw],
  });
  let localCalled: unknown[] | null = null;
  const localSpawn = async (command: string, options: Record<string, unknown>, writer: unknown) => {
    localCalled = [command, options, writer];
    return 'local-result';
  };
  const wrapped = routing.wrapSpawn('claude', localSpawn);
  const writer = fakeWriter();
  const res = await wrapped('hi', { projectPath: '/other', appSessionId: 's1' }, writer);
  assert.equal(res, 'local-result');
  assert.ok(localCalled);
  assert.equal((localCalled as unknown[])[0], 'hi');
  routing.dispose();
});

test('remote spawn: rpc, session push routing, resolves after complete', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: (p) => (p === '/srv/app' ? 'h1' : null),
    registry,
    // echo raw for regular events; complete produces no writer event (main
    // synthesises createCompleteMessage in prod — here we just assert []).
    normalizeEvent: (raw) => (raw.type === 'complete' ? [] : [raw]),
  });
  const writer = fakeWriter();
  const wrapped = routing.wrapSpawn('claude', async () => {
    throw new Error('localSpawn must not be called on remote path');
  });

  const p = wrapped('do it', { appSessionId: 's1', projectPath: '/srv/app', cwd: '/srv/app', sessionId: null }, writer);

  await tick();
  // The session/start rpc frame must have been sent to the host.
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start');
  assert.ok(startFrame, 'session/start rpc sent');
  assert.equal((startFrame!.params as Record<string, unknown>).appSessionId, 's1');
  assert.equal((startFrame!.params as Record<string, unknown>).command, 'do it');
  assert.equal((startFrame!.params as Record<string, unknown>).cwd, '/srv/app');

  registry.resolveRpc(startFrame!.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();

  assert.equal(writer.sessionId, 'P1', 'writer.setSessionId called with providerSessionId');
  assert.deepEqual(registry.getSessionHost('s1'), { hostId: 'h1', providerSessionId: 'P1' });

  // Regular event flows through injected normalizeEvent to writer.send.
  emitPush({ topic: 'session:s1', payload: { type: 'assistant', message: { role: 'assistant' } }, from: 'h1' });
  await tick();
  assert.equal(writer.sent.length, 1);
  assert.deepEqual(writer.sent[0], { type: 'assistant', message: { role: 'assistant' } });

  // complete resolves the spawn promise.
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  const result = await p;
  assert.equal(result, undefined);
  // No extra writer event from the complete (normalizeEvent returned []).
  assert.equal(writer.sent.length, 1);
  routing.dispose();
});

test('approval round-trip: push -> permission_request -> resolve sends approval/respond', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => (raw.type === 'complete' ? [] : [raw]),
  });
  const writer = fakeWriter();
  const wrapped = routing.wrapSpawn('claude', async () => undefined);
  const p = wrapped('go', { appSessionId: 's1', projectPath: '/srv/app', sessionId: null }, writer);
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  writer.sent.length = 0;

  // Approval push arrives from the host.
  emitPush({
    topic: 'approval:req1',
    payload: { appSessionId: 's1', approval: { name: 'Bash', input: { command: 'ls' } } },
    from: 'h1',
  });
  await tick();

  const permReq = writer.sent.find(
    (m) => (m as Record<string, unknown>).kind === 'permission_request',
  ) as Record<string, unknown> | undefined;
  assert.ok(permReq, 'permission_request forwarded to writer');
  assert.equal(permReq!.requestId, 'req1');
  assert.equal(permReq!.toolName, 'Bash');
  assert.deepEqual(permReq!.input, { command: 'ls' });
  assert.equal(permReq!.provider, 'claude');

  // Registry holds the pending approval keyed by requestId.
  assert.deepEqual(registry.takePendingApproval('req1'), { appSessionId: 's1', hostId: 'h1' });
  // takePendingApproval consumed it; re-add so wrapResolveToolApproval finds it.
  registry.addPendingApproval('req1', { appSessionId: 's1', hostId: 'h1' });

  let localResolveCalled = false;
  const wrappedResolve = routing.wrapResolveToolApproval(() => {
    localResolveCalled = true;
  });
  wrappedResolve('req1', { allow: true });
  await tick();

  assert.equal(localResolveCalled, false, 'remote path must not call localResolve');
  const respondFrame = hostWs.sent.find((f) => f.method === 'approval/respond');
  assert.ok(respondFrame, 'approval/respond rpc sent to host');
  assert.equal((respondFrame!.params as Record<string, unknown>).requestId, 'req1');
  assert.deepEqual((respondFrame!.params as Record<string, unknown>).decision, { allow: true });
  // Resolve the in-flight approval/respond so its 60s rpc timer is released.
  registry.resolveRpc(respondFrame!.id as string, { ok: true });
  await tick();

  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  routing.dispose();
});

test('getPendingApprovals returns remote-session approvals', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => (raw.type === 'complete' ? [] : [raw]),
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('claude', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();

  emitPush({
    topic: 'approval:req9',
    payload: { appSessionId: 's1', approval: { name: 'Write', input: { path: '/x' } } },
    from: 'h1',
  });
  await tick();

  const pend = routing.getPendingApprovals('P1');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].requestId, 'req9');
  assert.equal(pend[0].toolName, 'Write');
  assert.deepEqual(pend[0].input, { path: '/x' });

  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  routing.dispose();
});

test('abort: routes to remote host session/interrupt without calling localAbort', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => [raw],
  });
  registry.setSessionHost('s1', 'P1', 'h1');

  let localAbortCalled = false;
  const wrappedAbort = routing.wrapAbort(async () => {
    localAbortCalled = true;
    return true;
  });
  const abortPromise = wrappedAbort('P1');
  await tick();
  const interruptFrame = hostWs.sent.find((f) => f.method === 'session/interrupt');
  assert.ok(interruptFrame, 'session/interrupt rpc sent');
  registry.resolveRpc(interruptFrame!.id as string, { ok: true });
  const ok = await abortPromise;
  assert.equal(ok, true);
  assert.equal(localAbortCalled, false);
  assert.equal((interruptFrame!.params as Record<string, unknown>).appSessionId, 's1');
  routing.dispose();
});

test('abort: unknown provider session falls back to localAbort', async () => {
  const registry = createRemoteAgentsRegistry();
  const routing = createRemoteRouting({
    lookupHost: () => null,
    registry,
    normalizeEvent: (raw) => [raw],
  });
  let localAbortArg: string | null = null;
  const wrappedAbort = routing.wrapAbort(async (id) => {
    localAbortArg = id;
    return true;
  });
  const ok = await wrappedAbort('unknown');
  assert.equal(ok, true);
  assert.equal(localAbortArg, 'unknown');
  routing.dispose();
});

test('resolveToolApproval: no pending remote entry -> localResolve', async () => {
  const registry = createRemoteAgentsRegistry();
  const routing = createRemoteRouting({
    lookupHost: () => null,
    registry,
    normalizeEvent: (raw) => [raw],
  });
  let localArgs: unknown[] | null = null;
  const wrapped = routing.wrapResolveToolApproval((requestId, payload) => {
    localArgs = [requestId, payload];
  });
  wrapped('reqX', { allow: false });
  assert.deepEqual(localArgs, ['reqX', { allow: false }]);
  routing.dispose();
});

test('remote spawn without appSessionId throws', async () => {
  const registry = createRemoteAgentsRegistry();
  registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => [raw],
  });
  const writer = fakeWriter();
  await assert.rejects(
    () => routing.wrapSpawn('claude', async () => undefined)('go', { projectPath: '/srv/app' }, writer),
    /remote spawn requires appSessionId/,
  );
  routing.dispose();
});

test('rpc error on session/start cleans up handler and rethrows', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => [raw],
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('claude', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: false, error: 'boom' });
  await assert.rejects(() => p, /boom/);
  // Handler cleaned up: a stray session push must not reach the writer.
  emitPush({ topic: 'session:s1', payload: { type: 'assistant' }, from: 'h1' });
  await tick();
  assert.equal(writer.sent.length, 0);
  routing.dispose();
});

test('complete before session/start rpc resolves still resolves, no sessionHost leak', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => (raw.type === 'complete' ? [] : [raw]),
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('claude', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  assert.ok(startFrame);
  // Complete arrives before the host answers session/start.
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  // Late rpc resolution must not re-register a sessionHost entry.
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  assert.equal(writer.sessionId, null, 'setSessionId not called for already-finished run');
  assert.equal(registry.getSessionHost('s1'), undefined, 'no leaked sessionHost entry');
  routing.dispose();
});

test('session event before rpc resolves still forwards to writer', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => (raw.type === 'complete' ? [] : [raw]),
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('claude', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  emitPush({ topic: 'session:s1', payload: { type: 'assistant', message: { role: 'assistant' } }, from: 'h1' });
  await tick();
  assert.equal(writer.sent.length, 1);
  assert.deepEqual(writer.sent[0], { type: 'assistant', message: { role: 'assistant' } });
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  assert.equal(writer.sessionId, 'P1');
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  routing.dispose();
});

test('approval push without live handler (or appSessionId) is dropped, no pending leak', () => {
  const registry = createRemoteAgentsRegistry();
  const routing = createRemoteRouting({
    lookupHost: () => null,
    registry,
    normalizeEvent: (raw) => [raw],
  });
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
  try {
    // live-host push for a session with no active run on main
    emitPush({
      topic: 'approval:reqD',
      payload: { appSessionId: 'ghost', approval: { name: 'Bash' } },
      from: 'h1',
    });
    assert.equal(registry.takePendingApproval('reqD'), undefined);
    // push with no appSessionId must not register an ''-keyed pending entry
    emitPush({ topic: 'approval:reqE', payload: { approval: { name: 'Bash' } }, from: 'h1' });
    assert.equal(registry.takePendingApproval('reqE'), undefined);
    assert.ok(warns.length >= 2, `expected drop warnings, got ${warns.length}`);
  } finally {
    console.warn = origWarn;
  }
  routing.dispose();
});

test('abort when host offline falls back to localAbort and logs', async () => {
  const registry = createRemoteAgentsRegistry();
  const routing = createRemoteRouting({
    lookupHost: () => null,
    registry,
    normalizeEvent: (raw) => [raw],
  });
  // sessionHost entry pointing at a host that is NOT registered -> offline
  registry.setSessionHost('s1', 'P1', 'h1');
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
  try {
    let localAbortCalled = false;
    const wrappedAbort = routing.wrapAbort(async () => {
      localAbortCalled = true;
      return true;
    });
    const ok = await wrappedAbort('P1');
    assert.equal(ok, true);
    assert.equal(localAbortCalled, true);
    assert.ok(warns.some((w) => w.includes('offline')), 'offline fallback warned');
  } finally {
    console.warn = origWarn;
  }
  routing.dispose();
});

test('host disconnect mid-run rejects the spawn with /went offline/ and cleans handler', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => (raw.type === 'complete' ? [] : [raw]),
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('claude', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  assert.ok(registry.getSessionHost('s1'));
  // The close handler in remote-agent.server.ts calls disconnect, which fires
  // the offline sweep this routing installed at construction.
  registry.onHostOfflineSweep?.(['s1']);
  await assert.rejects(() => p, /went offline/);
  // Handler cleaned up: a stray session push must not reach the writer.
  writer.sent.length = 0;
  emitPush({ topic: 'session:s1', payload: { type: 'assistant' }, from: 'h1' });
  await tick();
  assert.equal(writer.sent.length, 0);
  assert.equal(registry.getSessionHost('s1'), undefined);
  routing.dispose();
});

test('getPendingApprovalsForAppSession returns approvals for fresh runs', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => (raw.type === 'complete' ? [] : [raw]),
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('claude', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  emitPush({
    topic: 'approval:reqF',
    payload: { appSessionId: 's1', approval: { name: 'Write', input: { path: '/y' } } },
    from: 'h1',
  });
  await tick();
  const pend = routing.getPendingApprovalsForAppSession('s1');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].requestId, 'reqF');
  assert.equal(pend[0].toolName, 'Write');
  // provider-id variant resolves the same approval
  assert.equal(routing.getPendingApprovals('P1').length, 1);
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  // sweep removed the approval mirror too
  assert.equal(routing.getPendingApprovalsForAppSession('s1').length, 0);
  assert.equal(registry.getSessionHost('s1'), undefined);
  routing.dispose();
});

test('wrapSpawn(provider) threads provider + configEnv into session/start', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: (p) => (p === '/srv/app' ? 'h1' : null),
    registry,
    normalizeEvent: (raw) => [raw],
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('qoder', async () => undefined)(
    'do it',
    {
      appSessionId: 's1',
      projectPath: '/srv/app',
      cwd: '/srv/app',
      sessionId: null,
      configEnv: { QODER_PERSONAL_ACCESS_TOKEN: 'pat' },
    },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  assert.ok(startFrame, 'session/start rpc sent');
  const params = startFrame!.params as Record<string, unknown>;
  assert.equal(params.provider, 'qoder');
  assert.equal(params.appSessionId, 's1');
  assert.deepEqual(params.configEnv, { QODER_PERSONAL_ACCESS_TOKEN: 'pat' });
  registry.resolveRpc(startFrame!.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  routing.dispose();
});

test('_remoteNorm messages pass through w.send without normalizeEvent', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  let normalizeCalls = 0;
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => {
      normalizeCalls += 1;
      return [raw];
    },
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('codex', async () => undefined)(
    'do',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  writer.sent.length = 0;
  // The lite pushes an ALREADY-normalized message (T12 runners wrap it).
  const normalized = { kind: 'assistant', content: 'hi', sessionId: 'P1' };
  emitPush({ topic: 'session:s1', payload: { _remoteNorm: true, message: normalized }, from: 'h1' });
  await tick();
  assert.equal(writer.sent.length, 1);
  assert.deepEqual(writer.sent[0], normalized);
  assert.equal(normalizeCalls, 0, 'normalizeEvent must not run on _remoteNorm messages');
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  routing.dispose();
});

test('raw complete for a non-claude provider is finish-only (no re-normalize, no double complete)', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  let normalizeCalls = 0;
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => {
      normalizeCalls += 1;
      return [raw];
    },
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('opencode', async () => undefined)(
    'do',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  writer.sent.length = 0;
  // The runner already pushed its normalized terminal via _remoteNorm, then
  // the raw complete marker — the marker must ONLY finish, not normalize again.
  emitPush({
    topic: 'session:s1',
    payload: { _remoteNorm: true, message: { kind: 'complete', sessionId: 'P1', exitCode: 0 } },
    from: 'h1',
  });
  await tick();
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  const result = await p;
  assert.equal(result, undefined);
  assert.equal(normalizeCalls, 0, 'raw complete of non-claude must not hit normalizeEvent');
  const completes = writer.sent.filter((m) => (m as { kind?: string }).kind === 'complete');
  assert.equal(completes.length, 1, 'exactly one complete delivered');
  routing.dispose();
});

test('claude raw complete still normalizes into a CompleteMessage then finishes', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const seen: Record<string, unknown>[] = [];
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => {
      seen.push(raw);
      return [{ kind: 'complete', exitCode: 0 }];
    },
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('claude', async () => undefined)(
    'do',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  writer.sent.length = 0;
  emitPush({ topic: 'session:s1', payload: { type: 'complete', exitCode: 0 }, from: 'h1' });
  const result = await p;
  assert.equal(result, undefined);
  assert.equal(seen.length, 1, 'claude raw complete went through normalizeEvent');
  assert.deepEqual(writer.sent[0], { kind: 'complete', exitCode: 0 });
  routing.dispose();
});

test('permission_request carries the actual provider id, not a hardcoded claude', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => [raw],
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('qoder', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();
  emitPush({
    topic: 'approval:reqQ',
    payload: { appSessionId: 's1', approval: { name: 'Bash', input: { command: 'ls' } } },
    from: 'h1',
  });
  await tick();
  const permReq = writer.sent.find((m) => (m as Record<string, unknown>).kind === 'permission_request');
  assert.ok(permReq, 'permission_request forwarded');
  assert.equal((permReq as Record<string, unknown>).provider, 'qoder');
  assert.equal(routing.getPendingApprovalsForAppSession('s1').length, 1);
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  routing.dispose();
});

test('cancelled approval push forwards permission_cancelled and cleans the pending entry', async () => {
  const registry = createRemoteAgentsRegistry();
  const hostWs = registerHost(registry, 'h1');
  const routing = createRemoteRouting({
    lookupHost: () => 'h1',
    registry,
    normalizeEvent: (raw) => [raw],
  });
  const writer = fakeWriter();
  const p = routing.wrapSpawn('qoder', async () => undefined)(
    'go',
    { appSessionId: 's1', projectPath: '/srv/app', sessionId: null },
    writer,
  );
  await tick();
  const startFrame = hostWs.sent.find((f) => f.method === 'session/start')!;
  registry.resolveRpc(startFrame.id as string, { ok: true, data: { providerSessionId: 'P1' } });
  await tick();

  // A normal approval push first mirrors it as pending (the popup is shown).
  emitPush({
    topic: 'approval:reqC',
    payload: { appSessionId: 's1', approval: { name: 'Bash', input: { command: 'ls' } } },
    from: 'h1',
  });
  await tick();
  assert.equal(routing.getPendingApprovalsForAppSession('s1').length, 1, 'normal push mirrored');

  // The timeout/cancel marker on the SAME requestId must clear it, not mirror.
  emitPush({
    topic: 'approval:reqC',
    payload: { appSessionId: 's1', approval: { name: 'Bash', cancelled: true } },
    from: 'h1',
  });
  await tick();
  const cancelled = writer.sent.find((m) => (m as Record<string, unknown>).kind === 'permission_cancelled');
  assert.ok(cancelled, 'permission_cancelled forwarded');
  assert.equal((cancelled as Record<string, unknown>).requestId, 'reqC');
  assert.equal((cancelled as Record<string, unknown>).provider, 'qoder');
  // The first (normal) push still surfaced its permission_request; the cancel
  // marker must NOT add a second request, only the cancellation.
  assert.equal(
    writer.sent.filter((m) => (m as Record<string, unknown>).kind === 'permission_request').length,
    1,
    'permission_request surfaced from the normal push',
  );
  // The pending entry was cleaned from BOTH the registry and the local mirror.
  assert.equal(registry.takePendingApproval('reqC'), undefined, 'no stale registry pending entry');
  assert.equal(routing.getPendingApprovalsForAppSession('s1').length, 0, 'no stale local mirror');
  emitPush({ topic: 'session:s1', payload: { type: 'complete' }, from: 'h1' });
  await p;
  routing.dispose();
});
