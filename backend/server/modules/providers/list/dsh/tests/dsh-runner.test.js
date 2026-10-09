import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { agent, client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// The test seam: `runDshTurn` is the ACP-driving core, split from process
// spawning so a test can drive it against an in-process fake agent (the SDK's
// transport-free `clientApp.connect(agentApp)` path). No real `dsh` binary runs.
import { resolveDshToolApproval, runDshTurn } from '../../../../../dsh-acp-runner.js';

// The fake agent announces this id from `session/new`; every assertion keys off
// it so a change in the runner's session handling fails loudly here.
const SESSION_ID = 'sess-1';
const CWD = process.cwd();

// Connections opened by the tests, closed in `after` so nothing is left open.
const connections = [];
after(() => {
  for (const connection of connections) {
    try {
      connection.close();
    } catch {
      // already closed
    }
  }
});

/**
 * Collects the normalized messages the runner hands to its writer.
 *
 * The real gateway writer (ChatSessionWriter) receives message OBJECTS and is
 * responsible for stringifying/fan-out, so the fake collects either shape.
 */
function makeWs() {
  const messages = [];
  return {
    messages,
    userId: null,
    send(raw) {
      messages.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
    },
  };
}

/**
 * Builds an in-process fake ACP agent.
 *
 * `script({ notify, request })` runs inside the `session/prompt` handler:
 * `notify(update)` emits a `session/update` for SESSION_ID, and
 * `request(method, params)` issues a call back into the client (used for the
 * permission round-trip). The handler always stops the turn with `end_turn`.
 */
function buildFakeAgent(script) {
  return agent({ name: 'fake-dsh' })
    .onRequest('initialize', async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', async () => ({ sessionId: SESSION_ID }))
    .onRequest('session/prompt', async (ctx) => {
      await script({
        notify: (update) => ctx.client.notify('session/update', { sessionId: SESSION_ID, update }),
        request: (method, params) => ctx.client.request(method, params),
      });
      return { stopReason: 'end_turn' };
    });
}

/** Pairs a fake agent with a real client and drives one turn through runDshTurn. */
function drive(fakeAgent, options, ws) {
  const connection = client({ name: 'lovdex' }).connect(fakeAgent);
  connections.push(connection);
  return runDshTurn(connection.agent, options, ws);
}

/** Resolves with the first buffered message matching `predicate`, or rejects. */
function waitFor(messages, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = messages.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for a matching message (saw: ${messages.map((m) => m.kind).join(', ')})`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** The offer list used by every permission test, with observable option ids. */
const PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
];

test('runDshTurn streams a normalized text message and emits session_created + one complete', async () => {
  const ws = makeWs();
  const fake = buildFakeAgent(async ({ notify }) => {
    await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } });
  });

  await drive(fake, { cwd: CWD, sessionId: null, prompt: 'hello' }, ws);

  const text = ws.messages.find((m) => m.kind === 'text');
  assert.ok(text, 'expected an assistant text message mapped from ACP');
  assert.equal(text.content, 'hi there');
  assert.equal(text.provider, 'dsh');

  const created = ws.messages.find((m) => m.kind === 'session_created');
  assert.ok(created, 'expected a session_created event');
  assert.equal(created.newSessionId, SESSION_ID);
  assert.equal(created.provider, 'dsh');

  const completes = ws.messages.filter((m) => m.kind === 'complete');
  assert.equal(completes.length, 1, 'exactly one terminal complete per run');
  assert.equal(completes[0].aborted, false);
  assert.equal(completes[0].provider, 'dsh');
});

test('approval round-trip: allow selects an offered allow_* option', async () => {
  const ws = makeWs();
  let received = null;
  const fake = buildFakeAgent(async ({ request }) => {
    received = await request('session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-1', title: 'Bash', rawInput: { command: 'ls' } },
      options: PERMISSION_OPTIONS,
    });
  });

  const run = drive(fake, { cwd: CWD, sessionId: 'app-1', prompt: 'go' }, ws);

  const pending = await waitFor(ws.messages, (m) => m.kind === 'permission_request');
  assert.equal(pending.toolName, 'Bash');
  assert.equal(pending.provider, 'dsh');
  assert.deepEqual(pending.input, { command: 'ls' });

  const resolved = resolveDshToolApproval(pending.requestId, { allow: true });
  assert.equal(resolved, true, 'the pending approval was found and resolved');

  await run;

  assert.ok(received, 'the agent received a permission response');
  assert.equal(received.outcome.outcome, 'selected');
  assert.ok(
    ['allow-once', 'allow-always'].includes(received.outcome.optionId),
    `optionId must be an offered allow_* id, got ${received.outcome.optionId}`,
  );

  const completes = ws.messages.filter((m) => m.kind === 'complete');
  assert.equal(completes.length, 1);
});

test('approval round-trip: deny selects an offered reject_* option', async () => {
  const ws = makeWs();
  let received = null;
  const fake = buildFakeAgent(async ({ request }) => {
    received = await request('session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-2', title: 'Write', rawInput: { file_path: '/etc/hosts' } },
      options: PERMISSION_OPTIONS,
    });
  });

  const run = drive(fake, { cwd: CWD, sessionId: 'app-2', prompt: 'go' }, ws);

  const pending = await waitFor(ws.messages, (m) => m.kind === 'permission_request');
  assert.equal(resolveDshToolApproval(pending.requestId, { allow: false }), true);

  await run;

  assert.ok(received, 'the agent received a permission response');
  assert.equal(received.outcome.outcome, 'selected');
  assert.equal(received.outcome.optionId, 'reject-once');

  assert.equal(ws.messages.filter((m) => m.kind === 'complete').length, 1);
});

test('approval timeout: unanswered request is rejected and permission_cancelled(timeout) is emitted', async () => {
  const ws = makeWs();
  let received = null;
  const fake = buildFakeAgent(async ({ request }) => {
    received = await request('session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-3', title: 'Bash', rawInput: { command: 'rm -rf /' } },
      options: PERMISSION_OPTIONS,
    });
  });

  await drive(
    fake,
    { cwd: CWD, sessionId: 'app-3', prompt: 'go', toolApprovalTimeoutMs: 40 },
    ws,
  );

  const cancelled = ws.messages.find((m) => m.kind === 'permission_cancelled');
  assert.ok(cancelled, 'expected a permission_cancelled event');
  assert.equal(cancelled.reason, 'timeout');

  assert.ok(received, 'the agent still received an answer after the timeout');
  assert.equal(received.outcome.outcome, 'selected');
  assert.equal(received.outcome.optionId, 'reject-once', 'timeout picks the reject option');

  assert.equal(ws.messages.filter((m) => m.kind === 'complete').length, 1);
});

test('auto-approve answers without emitting a popup or leaving a pending entry', async () => {
  const ws = makeWs();
  let received = null;
  const fake = buildFakeAgent(async ({ request }) => {
    received = await request('session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-4', title: 'Bash', rawInput: { command: 'ls -la' } },
      options: PERMISSION_OPTIONS,
    });
  });

  await drive(fake, { cwd: CWD, sessionId: 'app-4', prompt: 'go', autoApprove: true }, ws);

  assert.equal(ws.messages.filter((m) => m.kind === 'permission_request').length, 0, 'no popup under auto-approve');
  assert.ok(ws.messages.find((m) => m.kind === 'permission_auto'), 'auto decision surfaced');
  assert.ok(received && received.outcome.outcome === 'selected');
  assert.ok(['allow-once', 'allow-always'].includes(received.outcome.optionId));
});

test('a supplied session id is resumed through session/resume, not re-created', async () => {
  const ws = makeWs();
  // The fake records which method the runner used to attach the session, and
  // answers session/resume the way a real dsh does (no sessionId in the reply).
  const calls = [];
  const fake = agent({ name: 'fake-dsh' })
    .onRequest('initialize', async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/resume', async () => {
      calls.push('resume');
      return {};
    })
    .onRequest('session/new', async () => {
      calls.push('new');
      return { sessionId: 'fresh-id' };
    })
    .onRequest('session/prompt', async (ctx) => {
      await ctx.client.notify('session/update', {
        sessionId: 'resumed-id',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed ok' } },
      });
      return { stopReason: 'end_turn' };
    });

  await drive(fake, { cwd: CWD, sessionId: 'resumed-id', prompt: 'again' }, ws);

  assert.deepEqual(calls, ['resume'], 'a supplied id must resume, never session/new');
  const created = ws.messages.find((m) => m.kind === 'session_created');
  assert.ok(created, 'a resumed run still announces its session');
  // sessionId carries the id the caller already knows; newSessionId the agent's.
  assert.equal(created.sessionId, 'resumed-id');
  assert.equal(created.newSessionId, 'resumed-id');
  assert.equal(ws.messages.filter((m) => m.kind === 'complete').length, 1);
});

test('a refused resume falls back to a fresh session instead of failing the run', async () => {
  const ws = makeWs();
  const calls = [];
  const fake = agent({ name: 'fake-dsh' })
    .onRequest('initialize', async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/resume', async () => {
      calls.push('resume');
      // Mirrors real dsh: "Invalid params: session is not resumable: <id>".
      throw new Error('session is not resumable: stale-id');
    })
    .onRequest('session/new', async () => {
      calls.push('new');
      return { sessionId: 'fresh-id' };
    })
    .onRequest('session/prompt', async () => ({ stopReason: 'end_turn' }));

  await drive(fake, { cwd: CWD, sessionId: 'stale-id', prompt: 'go' }, ws);

  assert.deepEqual(calls, ['resume', 'new'], 'a refused resume must fall back to session/new');
  const created = ws.messages.find((m) => m.kind === 'session_created');
  assert.ok(created, 'the fallback run still announces the fresh session');
  assert.equal(created.newSessionId, 'fresh-id');
  assert.equal(ws.messages.filter((m) => m.kind === 'complete').length, 1);
});

test('a model selection is pushed through session/set_config_option', async () => {
  const ws = makeWs();
  const applied = [];
  const fake = agent({ name: 'fake-dsh' })
    .onRequest('initialize', async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', async () => ({ sessionId: SESSION_ID }))
    .onRequest('session/set_config_option', async (ctx) => {
      applied.push([ctx.params.configId, ctx.params.value]);
      return { configOptions: [] };
    })
    .onRequest('session/prompt', async () => ({ stopReason: 'end_turn' }));

  await drive(
    fake,
    { cwd: CWD, sessionId: null, prompt: 'go', model: '["deepseek-official","deepseek-v4-pro"]', effort: 'max' },
    ws,
  );

  assert.deepEqual(applied, [
    ['model', '["deepseek-official","deepseek-v4-pro"]'],
    ['reasoning_effort', 'max'],
  ]);
  assert.equal(ws.messages.filter((m) => m.kind === 'complete').length, 1);
});

test('the neutral "default" model slot is left to the runtime', async () => {
  const ws = makeWs();
  const applied = [];
  const fake = agent({ name: 'fake-dsh' })
    .onRequest('initialize', async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', async () => ({ sessionId: SESSION_ID }))
    .onRequest('session/set_config_option', async (ctx) => {
      applied.push([ctx.params.configId, ctx.params.value]);
      return { configOptions: [] };
    })
    .onRequest('session/prompt', async () => ({ stopReason: 'end_turn' }));

  await drive(fake, { cwd: CWD, sessionId: null, prompt: 'go', model: 'default' }, ws);

  assert.deepEqual(applied, [], 'the neutral slot must not be sent as a route');
});
