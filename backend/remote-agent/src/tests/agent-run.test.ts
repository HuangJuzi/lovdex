import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRunManager, type QuerySdkLike } from '../agent-run.js';

type Pushed = { topic: string; payload: unknown };

function makePush() {
  const pushed: Pushed[] = [];
  return {
    push: (topic: string, payload: unknown) => pushed.push({ topic, payload }),
    pushed,
  };
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const baseParams = {
  appSessionId: 's1',
  providerSessionId: null,
  command: 'hi',
  cwd: '/tmp',
};

test('start resolves early with the first event session_id; passthrough then terminal complete', async () => {
  const { push, pushed } = makePush();
  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-1', message: { role: 'assistant' } };
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  // start() resolves as soon as the first session-bearing event lands — NOT at
  // end of run (that would starve main's rpc waiter and discard the id).
  const res = await mgr.start(baseParams);
  assert.equal(res.providerSessionId, 'prov-1');
  await mgr.whenDone('s1');

  const sessionPushes = pushed.filter((p) => p.topic === 'session:s1');
  assert.equal(sessionPushes.length, 3); // assistant, result, complete

  const assistant = sessionPushes[0].payload as Record<string, unknown>;
  assert.equal(assistant.type, 'assistant');
  assert.equal(assistant.session_id, 'prov-1'); // snake preserved (passthrough)
  assert.equal(typeof assistant.eventId, 'string');

  const complete = sessionPushes[2].payload as Record<string, unknown>;
  assert.equal(complete.type, 'complete');
  assert.equal(complete.providerSessionId, 'prov-1');
  assert.equal(complete.done, true);
});

test('C1: start resolves early (before the loop finishes) when providerSessionId is given', async () => {
  const { push, pushed } = makePush();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));

  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-x', message: {} };
    await gate; // loop parked; run still active
    yield { type: 'result', session_id: 'prov-x', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const res = await mgr.start({ ...baseParams, providerSessionId: 'prov-x' });
  // Fast resolve while the loop is still parked on the gate.
  assert.equal(res.providerSessionId, 'prov-x');
  assert.equal(pushed.filter((p) => p.topic === 'session:s1').length, 1); // only the first assistant

  release();
  await mgr.whenDone('s1');
  const complete = pushed.find(
    (p) => p.topic === 'session:s1' && (p.payload as Record<string, unknown>).type === 'complete',
  );
  assert.ok(complete, 'complete pushed after the loop actually ends');
});

test('C2: resume carries the providerSessionId string, never a boolean, and sessionId is unset', async () => {
  // With a providerSessionId: resume is the string id, sessionId is absent.
  {
    const { push } = makePush();
    let captured: Record<string, unknown> | undefined;
    const querySdk: QuerySdkLike = async function* (_command, options) {
      captured = options;
      yield { type: 'assistant', session_id: 'prov-9', message: {} };
      yield { type: 'result', session_id: 'prov-9', subtype: 'success' };
    };
    const mgr = createAgentRunManager({ push, querySdk });
    await mgr.start({ ...baseParams, providerSessionId: 'prov-9' });
    await mgr.whenDone('s1');
    assert.equal(captured!.resume, 'prov-9'); // string passthrough
    assert.equal(captured!.sessionId, undefined); // not the mutually-exclusive field
    assert.notEqual(captured!.resume, true); // never the boolean form
  }

  // Without a providerSessionId: resume is absent (undefined), not a boolean.
  {
    const { push } = makePush();
    let captured: Record<string, unknown> | undefined;
    const querySdk: QuerySdkLike = async function* (_command, options) {
      captured = options;
      yield { type: 'assistant', session_id: 'prov-fresh', message: {} };
      yield { type: 'result', session_id: 'prov-fresh', subtype: 'success' };
    };
    const mgr = createAgentRunManager({ push, querySdk });
    await mgr.start({ ...baseParams, appSessionId: 's2' });
    await mgr.whenDone('s2');
    assert.equal(captured!.resume, undefined);
    assert.equal(captured!.sessionId, undefined);
  }
});

test('canUseTool emits an approval push and awaits the decision', async () => {
  const { push, pushed } = makePush();
  let permissionResult: unknown;

  const querySdk: QuerySdkLike = async function* (_command, options) {
    yield { type: 'assistant', session_id: 'prov-1', message: { role: 'assistant' } };
    const canUseTool = (options as { canUseTool: Function }).canUseTool;
    permissionResult = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-1' });
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const startP = mgr.start(baseParams);
  await waitFor(() => pushed.some((p) => p.topic.startsWith('approval:')));
  const approvalPush = pushed.find((p) => p.topic.startsWith('approval:'));
  assert.ok(approvalPush, 'approval push emitted');
  const requestId = approvalPush!.topic.slice('approval:'.length);
  assert.equal(requestId, 'tu-1'); // tool_use_id used as requestId
  const payload = approvalPush!.payload as { appSessionId: string; approval: unknown };
  assert.equal(payload.appSessionId, 's1');

  assert.equal(mgr.respond(requestId, { allow: true }), true);
  await startP;
  await mgr.whenDone('s1');
  // The CLI schema requires updatedInput on allow (the original tool input when
  // the decision carries no explicit override).
  assert.deepEqual(permissionResult, { behavior: 'allow', updatedInput: { command: 'ls' } });
});

test('allow decision carries updatedInput across every allow branch (CLI schema)', async () => {
  const showResult = async (
    respondWith: unknown,
    toolInput: Record<string, unknown>,
  ): Promise<unknown> => {
    const localPushed: Pushed[] = [];
    let captured: unknown;
    const querySdk: QuerySdkLike = async function* (_command, options) {
      yield { type: 'assistant', session_id: 'prov-allow', message: {} };
      const canUseTool = (options as { canUseTool: Function }).canUseTool;
      captured = await canUseTool('Bash', toolInput, { toolUseID: 'tu-allow' });
      yield { type: 'result', session_id: 'prov-allow', subtype: 'success' };
    };
    const mgr = createAgentRunManager({ push: (t, p) => localPushed.push({ topic: t, payload: p }), querySdk });
    const startP = mgr.start({ ...baseParams, appSessionId: 's-allow' });
    await waitFor(() => localPushed.some((p) => p.topic.startsWith('approval:')));
    const requestId = localPushed.find((p) => p.topic.startsWith('approval:'))!.topic.slice('approval:'.length);
    mgr.respond(requestId, respondWith);
    await startP;
    await mgr.whenDone('s-allow');
    return captured;
  };

  // { allow: true } without updatedInput falls back to the original tool input.
  assert.deepEqual(
    await showResult({ allow: true }, { command: 'ls' }),
    { behavior: 'allow', updatedInput: { command: 'ls' } },
  );
  // 'allow' truthy scalar path also falls back to the original input.
  assert.deepEqual(
    await showResult(true, { command: 'pwd' }),
    { behavior: 'allow', updatedInput: { command: 'pwd' } },
  );
  // SDK-shaped passthrough with an explicit updatedInput keeps the override.
  assert.deepEqual(
    await showResult({ behavior: 'allow', updatedInput: { command: 'ls -la' } }, { command: 'ls' }),
    { behavior: 'allow', updatedInput: { command: 'ls -la' } },
  );
});

test('canUseTool deny produces a deny PermissionResult', async () => {
  const { push, pushed } = makePush();
  let permissionResult: unknown;

  const querySdk: QuerySdkLike = async function* (_command, options) {
    yield { type: 'assistant', session_id: 'prov-1', message: { role: 'assistant' } };
    const canUseTool = (options as { canUseTool: Function }).canUseTool;
    permissionResult = await canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 'tu-2' });
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });
  const startP = mgr.start(baseParams);
  await waitFor(() => pushed.some((p) => p.topic.startsWith('approval:')));
  const approvalPush = pushed.find((p) => p.topic.startsWith('approval:'))!;
  const requestId = approvalPush.topic.slice('approval:'.length);
  mgr.respond(requestId, { deny: true });
  await startP;
  await mgr.whenDone('s1');
  const pr = permissionResult as { behavior: string };
  assert.equal(pr.behavior, 'deny');
});

test('approval timeout auto-denies, pushes cancelled, and respond settles once', async () => {
  const { push, pushed } = makePush();
  let permissionResult: unknown;

  const querySdk: QuerySdkLike = async function* (_command, options) {
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    const canUseTool = (options as { canUseTool: Function }).canUseTool;
    permissionResult = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-timeout' });
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk, approvalTimeoutMs: 20 });

  const startP = mgr.start(baseParams);
  await waitFor(() => pushed.some((p) => p.topic.startsWith('approval:')));
  const approvalPush = pushed.find((p) => p.topic.startsWith('approval:'))!;
  const requestId = approvalPush.topic.slice('approval:'.length);

  // Wait for the timer to fire → cancelled approval push.
  await waitFor(() =>
    pushed.some(
      (p) =>
        p.topic === `approval:${requestId}` &&
        (p.payload as { approval?: { cancelled?: boolean } }).approval?.cancelled === true,
    ),
  );

  await startP;
  await mgr.whenDone('s1');
  const pr = permissionResult as { behavior: string };
  assert.equal(pr.behavior, 'deny');

  // respond racing the timer settles once: the timeout already settled it.
  assert.equal(mgr.respond(requestId, { allow: true }), false);
});

test('interrupt breaks the loop but still pushes complete; unknown session returns false', async () => {
  const { push, pushed } = makePush();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));

  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    await gate; // wait until the test interrupts
    yield { type: 'assistant', session_id: 'prov-1', message: { after: true } };
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const startP = mgr.start(baseParams);
  await waitFor(() => pushed.some((p) => p.topic === 'session:s1'));

  assert.equal(mgr.interrupt('nope'), false);
  assert.equal(mgr.interrupt('s1'), true);
  release();
  await startP;
  await mgr.whenDone('s1');

  const sessionPushes = pushed.filter((p) => p.topic === 'session:s1');
  const types = sessionPushes.map((p) => (p.payload as Record<string, unknown>).type);
  assert.deepEqual(types, ['assistant', 'complete']);
});

test('C3: abort-induced throw still pushes terminal complete and does not reject start', async () => {
  const { push, pushed } = makePush();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));

  // Simulates the real SDK routing subprocess exitError into the stream after
  // abort: the generator THROWS once released.
  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    await gate;
    throw new Error('exitError: process exited with code -2');
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const startP = mgr.start(baseParams);
  await waitFor(() => pushed.some((p) => p.topic === 'session:s1'));
  mgr.interrupt('s1');
  release();

  const res = await startP;
  assert.equal(res.providerSessionId, 'prov-1');
  await mgr.whenDone('s1');

  const sessionPushes = pushed.filter((p) => p.topic === 'session:s1');
  const complete = sessionPushes.find((p) => (p.payload as Record<string, unknown>).type === 'complete');
  assert.ok(complete, 'terminal complete pushed despite abort-induced throw');
  assert.equal(sessionPushes.length, 2); // assistant + complete (the throw did not push result)
});

test('respond for unknown requestId returns false', () => {
  const { push } = makePush();
  const querySdk: QuerySdkLike = async function* () {};
  const mgr = createAgentRunManager({ push, querySdk });
  assert.equal(mgr.respond('does-not-exist', { allow: true }), false);
});

test('I1: genuine (non-abort) loop error pushes one terminal complete with exitCode 1 + error', async () => {
  const { push, pushed } = makePush();
  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    throw new Error('model backend 500');
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const startP = mgr.start(baseParams);
  await waitFor(() => pushed.some((p) => p.topic === 'session:s1'));
  await startP;
  await mgr.whenDone('s1');

  const sessionPushes = pushed.filter((p) => p.topic === 'session:s1');
  const completes = sessionPushes.filter((p) => (p.payload as Record<string, unknown>).type === 'complete');
  // exactly ONE terminal frame (not a failed one followed by a clean exitCode 0)
  assert.equal(completes.length, 1);
  const complete = completes[0].payload as Record<string, unknown>;
  assert.equal(complete.exitCode, 1);
  assert.equal(complete.error, 'model backend 500');
  assert.equal(complete.done, true);
});

test('start rejects a second run for the same appSessionId', async () => {
  const { push } = makePush();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    await gate;
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  // The run is registered synchronously inside start(), before its first await.
  const first = mgr.start(baseParams);
  await assert.rejects(mgr.start(baseParams), /session already running/);
  release();
  await first;
  await mgr.whenDone('s1');
});

test('I4: start() rejects a cwd outside the configured roots', async () => {
  const { push } = makePush();
  const querySdk: QuerySdkLike = async function* () {};
  const mgr = createAgentRunManager({ push, querySdk, roots: ['/tmp'] });

  // /etc exists but escapes the /tmp root → the allowlisted-fs resolve throws.
  await assert.rejects(mgr.start({ ...baseParams, cwd: '/etc' }), /outside allowed root/);
  // /tmp/definitely-not-a-real-dir-xyz is inside /tmp but missing → rejected.
  await assert.rejects(
    mgr.start({ ...baseParams, cwd: '/tmp/definitely-not-a-real-dir-xyz' }),
    /outside allowed roots/,
  );
});

test('I4: start() accepts a cwd inside the configured roots', async () => {
  const { push, pushed } = makePush();
  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-ok', message: {} };
  };
  const mgr = createAgentRunManager({ push, querySdk, roots: ['/tmp'] });
  const res = await mgr.start({ ...baseParams, cwd: '/tmp' });
  assert.equal(res.providerSessionId, 'prov-ok');
  await mgr.whenDone('s1');
  assert.equal(
    pushed.filter((p) => p.topic === 'session:s1' && (p.payload as Record<string, unknown>).type === 'complete').length,
    1,
  );
});

test('I2: interruptAll stops every active run and settles approvals', async () => {
  const { push, pushed } = makePush();
  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((r) => (releaseA = r));
  let releaseB: () => void = () => {};
  const gateB = new Promise<void>((r) => (releaseB = r));

  const querySdk: QuerySdkLike = async function* () {
    await gateA;
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    await gateB;
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  // start() registers each run synchronously before its first await, so both
  // runs are active the moment the two start() calls return (the generators
  // are parked on their gates and have yielded nothing yet).
  const runA = mgr.start({ ...baseParams, appSessionId: 'a1' });
  const runB = mgr.start({ ...baseParams, appSessionId: 'b1' });

  assert.equal(mgr.interruptAll(), 2);
  releaseA();
  releaseB();
  await runA;
  await runB;
  await mgr.whenDone('a1');
  await mgr.whenDone('b1');

  // Interrupted runs complete with exactly one terminal frame each (abort path).
  for (const sid of ['a1', 'b1']) {
    const completes = pushed.filter(
      (p) => p.topic === `session:${sid}` && (p.payload as Record<string, unknown>).type === 'complete',
    );
    assert.equal(completes.length, 1, `${sid} got exactly one terminal complete`);
  }
  // interruptAll is idempotent: no runs left to interrupt.
  assert.equal(mgr.interruptAll(), 0);
});