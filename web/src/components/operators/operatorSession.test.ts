import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOperatorSession,
  ensureOperatorSession,
  resetOperatorCreateFlow,
  resetOperatorSessionFlow,
  type OperatorSessionDeps,
} from './operatorSession';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type FakeCalls = { settings: number; listSessions: number; createSession: number };

const makeDeps = (overrides: Partial<OperatorSessionDeps> & { latestSessionId?: string | null } = {}) => {
  const calls: FakeCalls = { settings: 0, listSessions: 0, createSession: 0 };
  const createdIds: string[] = [];
  const { latestSessionId, ...depsOverrides } = overrides;
  return {
    calls,
    createdIds,
    deps: {
      settings: async () => {
        calls.settings++;
        return jsonResponse({ interactive_chat_enabled: true });
      },
      listSessions: async () => {
        calls.listSessions++;
        return jsonResponse({
          data: { sessions: latestSessionId ? [{ session_id: latestSessionId }] : [] },
        });
      },
      createSession: async () => {
        calls.createSession++;
        const id = `s${calls.createSession}`;
        createdIds.push(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse({ data: { sessionId: id } }, 201);
      },
      ...depsOverrides,
    } as OperatorSessionDeps,
  };
};

// The module-level flows map is shared across tests — always start clean.
const reset = () => resetOperatorSessionFlow();

test('StrictMode remount: two concurrent ensure calls share one createSession POST', async () => {
  reset();
  const { calls, deps } = makeDeps();

  // React.StrictMode in dev remounts the component; both mounts run the effect
  // back-to-back. Both must resolve to the SAME flow → one POST total.
  const [a, b] = await Promise.all([
    ensureOperatorSession(true, deps),
    ensureOperatorSession(true, deps),
  ]);

  assert.equal(calls.createSession, 1, 'both mounts must share one createSession');
  assert.deepEqual(a, { ok: true, sessionId: 's1' });
  assert.deepEqual(b, { ok: true, sessionId: 's1' });
});

test('sticky flow: a call after the flow settled reuses the result (no duplicate POST)', async () => {
  reset();
  const { calls, deps } = makeDeps();

  const first = await ensureOperatorSession(true, deps);
  // The second mount's flow can reach the create step AFTER the first mount's
  // POST settled (they await their own settings()/listSessions() first). The
  // sticky flow must return the same session instead of POSTing again.
  const second = await ensureOperatorSession(true, deps);

  assert.equal(calls.createSession, 1);
  assert.deepEqual(first, { ok: true, sessionId: 's1' });
  assert.deepEqual(second, { ok: true, sessionId: 's1' });
});

test('explicit reset clears the sticky flow so the next call creates a fresh session', async () => {
  reset();
  const { calls, deps } = makeDeps();

  await ensureOperatorSession(true, deps);
  resetOperatorSessionFlow(true);
  const result = await ensureOperatorSession(true, deps);

  assert.equal(calls.createSession, 2, 'reset must force a new POST');
  assert.deepEqual(result, { ok: true, sessionId: 's2' });
});

test('failure clears its own flow entry so a later call retries', async () => {
  reset();
  const { deps } = makeDeps({
    createSession: async () => new Response('{}', { status: 500 }),
  });

  const failed = await ensureOperatorSession(true, deps);
  assert.deepEqual(failed, { ok: false, reason: 'http', status: 500 });

  // Recover the deps to a working create and verify the next call retries fresh.
  const { calls: calls2, deps: deps2 } = makeDeps();
  const result = await ensureOperatorSession(true, deps2);
  assert.equal(calls2.createSession, 1);
  assert.deepEqual(result, { ok: true, sessionId: 's1' });
});

test('disabled interactive chat returns a disabled result without creating', async () => {
  reset();
  const { calls, deps } = makeDeps({
    settings: async () => jsonResponse({ interactive_chat_enabled: false }),
  });

  const result = await ensureOperatorSession(true, deps);

  assert.deepEqual(result, { ok: false, reason: 'disabled' });
  assert.equal(calls.createSession, 0);
});

test('reuse path returns the latest session without creating', async () => {
  reset();
  const { calls, deps } = makeDeps({ latestSessionId: 'existing-1' });

  const result = await ensureOperatorSession(false, deps);

  assert.deepEqual(result, { ok: true, sessionId: 'existing-1' });
  assert.equal(calls.createSession, 0);
});

test('reuse path with no sessions creates one', async () => {
  reset();
  const { calls, deps } = makeDeps();

  const result = await ensureOperatorSession(false, deps);

  assert.deepEqual(result, { ok: true, sessionId: 's1' });
  assert.equal(calls.createSession, 1);
});

test('missing sessionId in the response surfaces as missing-id', async () => {
  reset();
  const { deps } = makeDeps({
    createSession: async () => jsonResponse({ data: {} }, 201),
  });

  const result = await ensureOperatorSession(true, deps);

  assert.deepEqual(result, { ok: false, reason: 'missing-id' });
});

test('createOperatorSession passes the chosen provider through to createSession', async () => {
  reset();
  resetOperatorCreateFlow();
  let seenProvider: string | undefined;
  const { deps } = makeDeps({
    createSession: async (provider) => {
      seenProvider = provider;
      return jsonResponse({ data: { sessionId: 's-opencode' } }, 201);
    },
  });

  const result = await createOperatorSession('opencode', deps);

  assert.equal(seenProvider, 'opencode');
  assert.deepEqual(result, { ok: true, sessionId: 's-opencode' });
});

test('createOperatorSession single-flights concurrent confirms into one POST', async () => {
  reset();
  resetOperatorCreateFlow();
  const { calls, deps } = makeDeps();

  const [a, b] = await Promise.all([
    createOperatorSession('claude', deps),
    createOperatorSession('claude', deps),
  ]);

  assert.equal(calls.createSession, 1, 'two confirms must share one createSession');
  assert.deepEqual(a, { ok: true, sessionId: 's1' });
  assert.deepEqual(b, { ok: true, sessionId: 's1' });
});

test('resetOperatorCreateFlow forces a fresh POST on the next confirm', async () => {
  reset();
  resetOperatorCreateFlow();
  const { calls, deps } = makeDeps();

  await createOperatorSession('claude', deps);
  resetOperatorCreateFlow('claude');
  const result = await createOperatorSession('claude', deps);

  assert.equal(calls.createSession, 2, 'reset must force a new POST');
  assert.deepEqual(result, { ok: true, sessionId: 's2' });
});

test('createOperatorSession failure clears its entry so a retry POSTs again', async () => {
  reset();
  resetOperatorCreateFlow();
  const failing = makeDeps({
    createSession: async () => new Response('{}', { status: 500 }),
  }).deps;

  const failed = await createOperatorSession('qoder', failing);
  assert.deepEqual(failed, { ok: false, reason: 'http', status: 500 });

  const { calls: calls2, deps: deps2 } = makeDeps();
  const result = await createOperatorSession('qoder', deps2);
  assert.equal(calls2.createSession, 1);
  assert.deepEqual(result, { ok: true, sessionId: 's1' });
});