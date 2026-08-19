import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeRunManager, type QuerySdkLike } from '../agent-run.js';
import {
  __resetRunManagersForTests,
  __setDispatchQuerySdkForTests,
  handleRpc,
  setPushEmitter,
} from '../rpc-dispatch.js';
import { createRunManagerFor } from '../providers/registry.js';
import { makeSessionStartParamsSchema } from '../../../server/shared/agent-runtime/protocol.js';

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

const cfg = { roots: ['/tmp'] } as never;

// Isolate the dispatch-level run-manager cache: clear the injected SDK so the
// real claude bridge is never consulted, and drop every cached manager so a
// prior test's parked runs or injected querySdk cannot leak into the next one
// (a leftover cached manager would ignore a later test's fresh fake SDK, and a
// leftover run would pollute the "unknown target" assertions).
beforeEach(() => {
  __setDispatchQuerySdkForTests(null);
  __resetRunManagersForTests();
});
afterEach(() => {
  __setDispatchQuerySdkForTests(null);
  __resetRunManagersForTests();
});

test('registry: every provider returns a full run-manager surface', () => {
  for (const provider of ['claude', 'codex', 'opencode', 'qoder'] as const) {
    const mgr = createRunManagerFor(provider, { push: () => {}, roots: ['/tmp'] });
    assert.equal(typeof mgr.start, 'function');
    assert.equal(typeof mgr.respond, 'function');
    assert.equal(typeof mgr.whenDone, 'function');
    assert.equal(typeof mgr.interrupt, 'function');
    assert.equal(typeof mgr.interruptAll, 'function');
  }
});

test('session/start schema defaults provider to claude and configEnv to {}', () => {
  const parsed = makeSessionStartParamsSchema().parse({
    appSessionId: 's1',
    providerSessionId: null,
    command: 'hi',
    cwd: '/tmp',
  });
  assert.equal(parsed.provider, 'claude');
  assert.deepEqual(parsed.configEnv, {});
});

test('session/start schema surfaces the provider + configEnv fields', () => {
  const parsed = makeSessionStartParamsSchema().parse({
    appSessionId: 's1',
    providerSessionId: null,
    provider: 'codex',
    command: 'hi',
    cwd: '/tmp',
    configEnv: { OPENAI_API_KEY: 'sk-…' },
  });
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.configEnv.OPENAI_API_KEY, 'sk-…');
});

test('configEnv is merged over process.env into the SDK options (per start() call)', async () => {
  const { push } = makePush();
  let captured: Record<string, unknown> | undefined;
  const querySdk: QuerySdkLike = async function* (_command, options) {
    captured = options;
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createClaudeRunManager({ push, querySdk, roots: ['/tmp'] });

  const res = await mgr.start({
    ...baseParams,
    configEnv: { FOO: 'bar', NODE_ENV: 'override' },
  });
  assert.equal(res.providerSessionId, 'prov-1');
  await mgr.whenDone('s1');

  const env = captured!.env as Record<string, string>;
  assert.equal(env.FOO, 'bar'); // configEnv keys land
  assert.equal(env.NODE_ENV, 'override'); // configEnv wins over process.env
  assert.equal(env.PATH, process.env.PATH); // bare-env strip would drop PATH
});

test('configEnv absent ⇒ no env key set on the SDK options', async () => {
  const { push } = makePush();
  let captured: Record<string, unknown> | undefined;
  const querySdk: QuerySdkLike = async function* (_command, options) {
    captured = options;
    yield { type: 'assistant', session_id: 'prov-1', message: {} };
    yield { type: 'result', session_id: 'prov-1', subtype: 'success' };
  };
  const mgr = createClaudeRunManager({ push, querySdk, roots: ['/tmp'] });
  await mgr.start({ ...baseParams, configEnv: {} });
  await mgr.whenDone('s1');
  assert.equal(captured!.env, undefined);
});

test('dispatch: session/start rejects a cwd outside the roots for every provider', async () => {
  // Non-spawning wiring check: each provider manager validates the cwd against
  // the allowlisted roots before touching its CLI/SDK. (The fs layer throws
  // either "path outside allowed root" for an escape attempt or
  // "cwd outside allowed roots" for a missing/non-directory target.)
  for (const provider of ['codex', 'opencode', 'qoder'] as const) {
    await assert.rejects(
      handleRpc(
        'session/start',
        { ...baseParams, appSessionId: `s-out-${provider}`, provider, cwd: '/nope/outside' },
        cfg,
      ),
      /outside allowed/,
    );
  }
});

test('dispatch: session/interrupt and approval/respond shape responses on unknown targets', async () => {
  assert.deepEqual(await handleRpc('session/interrupt', { appSessionId: 'nope' }, cfg), { interrupted: false });
  assert.deepEqual(
    await handleRpc('approval/respond', { requestId: 'x', decision: { allow: true } }, cfg),
    { accepted: false },
  );
});

test('dispatch: session/interrupt routes to the provider manager that started the run', async () => {
  const collected: Pushed[] = [];
  setPushEmitter((t, p) => collected.push({ topic: t, payload: p }));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  __setDispatchQuerySdkForTests(async function* () {
    yield { type: 'assistant', session_id: 'prov-disp', message: {} };
    await gate; // stay active until the test interrupts
    yield { type: 'result', session_id: 'prov-disp', subtype: 'success' };
  });

  const start = await handleRpc(
    'session/start',
    { ...baseParams, appSessionId: 'd-int', command: 'why', configEnv: { X: '1' } },
    cfg,
  );
  assert.equal((start as { providerSessionId: string }).providerSessionId, 'prov-disp');

  const res = await handleRpc('session/interrupt', { appSessionId: 'd-int' }, cfg);
  assert.deepEqual(res, { interrupted: true });

  release();
  await waitFor(() =>
    collected.some(
      (p) => p.topic === 'session:d-int' && (p.payload as { type?: string }).type === 'complete',
    ),
  );
});

test('dispatch: approval/respond resolves a pending canUseTool decision across handleRpc', async () => {
  const collected: Pushed[] = [];
  setPushEmitter((t, p) => collected.push({ topic: t, payload: p }));
  let decision: unknown;
  __setDispatchQuerySdkForTests(async function* (_command, options) {
    yield { type: 'assistant', session_id: 'prov-appr', message: {} };
    const canUseTool = (options as { canUseTool: Function }).canUseTool;
    decision = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-disp' });
    yield { type: 'result', session_id: 'prov-appr', subtype: 'success' };
  });

  const startP = handleRpc('session/start', { ...baseParams, appSessionId: 'd-appr' }, cfg);
  await waitFor(() => collected.some((p) => p.topic === 'approval:tu-disp'));

  const res = await handleRpc('approval/respond', { requestId: 'tu-disp', decision: { allow: true } }, cfg);
  assert.deepEqual(res, { accepted: true });

  await startP;
  assert.deepEqual(decision, { behavior: 'allow' });
  await waitFor(() =>
    collected.some(
      (p) => p.topic === 'session:d-appr' && (p.payload as { type?: string }).type === 'complete',
    ),
  );
});
