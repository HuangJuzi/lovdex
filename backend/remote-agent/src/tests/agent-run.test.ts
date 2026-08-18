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

const baseParams = {
  appSessionId: 's1',
  providerSessionId: null,
  command: 'hi',
  cwd: '/tmp',
};

test('start forwards assistant passthrough then a terminal complete', async () => {
  const { push, pushed } = makePush();
  const querySdk: QuerySdkLike = async function* () {
    yield { type: 'assistant', session_id: 'prov-1', message: { role: 'assistant' } };
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const res = await mgr.start(baseParams);
  assert.equal(res.providerSessionId, 'prov-1');

  const sessionPushes = pushed.filter((p) => p.topic === 'session:s1');
  // assistant, result, complete
  assert.equal(sessionPushes.length, 3);

  const assistant = sessionPushes[0].payload as Record<string, unknown>;
  assert.equal(assistant.type, 'assistant');
  assert.equal(assistant.session_id, 'prov-1'); // snake preserved (passthrough)
  assert.equal(typeof assistant.eventId, 'string');

  const complete = sessionPushes[2].payload as Record<string, unknown>;
  assert.equal(complete.type, 'complete');
  assert.equal(complete.providerSessionId, 'prov-1');
  assert.equal(complete.done, true);
});

test('canUseTool emits an approval push and awaits the decision', async () => {
  const { push, pushed } = makePush();
  let permissionResult: unknown;

  const querySdk: QuerySdkLike = async function* (_command, options) {
    const canUseTool = (options as { canUseTool: Function }).canUseTool;
    permissionResult = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-1' });
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const startP = mgr.start(baseParams);

  // Let the generator run until it awaits the approval.
  await new Promise((r) => setTimeout(r, 10));
  const approvalPush = pushed.find((p) => p.topic.startsWith('approval:'));
  assert.ok(approvalPush, 'approval push emitted');
  const requestId = approvalPush!.topic.slice('approval:'.length);
  assert.equal(requestId, 'tu-1'); // tool_use_id used as requestId
  const payload = approvalPush!.payload as { appSessionId: string; approval: unknown };
  assert.equal(payload.appSessionId, 's1');

  const accepted = mgr.respond(requestId, { allow: true });
  assert.equal(accepted, true);

  await startP;
  assert.deepEqual(permissionResult, { behavior: 'allow' });
});

test('canUseTool deny produces a deny PermissionResult', async () => {
  const { push, pushed } = makePush();
  let permissionResult: unknown;

  const querySdk: QuerySdkLike = async function* (_command, options) {
    const canUseTool = (options as { canUseTool: Function }).canUseTool;
    permissionResult = await canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 'tu-2' });
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });
  const startP = mgr.start(baseParams);
  await new Promise((r) => setTimeout(r, 10));
  const approvalPush = pushed.find((p) => p.topic.startsWith('approval:'))!;
  const requestId = approvalPush.topic.slice('approval:'.length);
  mgr.respond(requestId, { deny: true });
  await startP;
  const pr = permissionResult as { behavior: string };
  assert.equal(pr.behavior, 'deny');
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
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(mgr.interrupt('nope'), false);
  assert.equal(mgr.interrupt('s1'), true);
  release();
  await startP;

  const sessionPushes = pushed.filter((p) => p.topic === 'session:s1');
  // only the first assistant (before gate) + complete; the post-gate events skipped
  const types = sessionPushes.map((p) => (p.payload as Record<string, unknown>).type);
  assert.deepEqual(types, ['assistant', 'complete']);
});

test('respond for unknown requestId returns false', () => {
  const { push } = makePush();
  const querySdk: QuerySdkLike = async function* () {};
  const mgr = createAgentRunManager({ push, querySdk });
  assert.equal(mgr.respond('does-not-exist', { allow: true }), false);
});

test('start rejects a second run for the same appSessionId', async () => {
  const { push } = makePush();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const querySdk: QuerySdkLike = async function* () {
    await gate;
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createAgentRunManager({ push, querySdk });

  const first = mgr.start(baseParams);
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(mgr.start(baseParams), /session already running/);
  release();
  await first;
});
