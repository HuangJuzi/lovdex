import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeRunManager, type QuerySdkLike } from '../agent-run.js';
import { handleRpc } from '../rpc-dispatch.js';
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

const baseParams = {
  appSessionId: 's1',
  providerSessionId: null,
  command: 'hi',
  cwd: '/tmp',
};

const cfg = { roots: ['/tmp'] } as never;

test('registry: claude provider returns a full run-manager surface', () => {
  const mgr = createRunManagerFor('claude', { push: () => {}, roots: ['/tmp'] });
  assert.equal(typeof mgr.start, 'function');
  assert.equal(typeof mgr.respond, 'function');
  assert.equal(typeof mgr.whenDone, 'function');
  assert.equal(typeof mgr.interrupt, 'function');
  assert.equal(typeof mgr.interruptAll, 'function');
});

test('registry: unimplemented provider throws not-implemented (until Task 12)', () => {
  assert.throws(() => createRunManagerFor('codex', { push: () => {}, roots: ['/tmp'] }), /not implemented/);
  assert.throws(() => createRunManagerFor('opencode', { push: () => {}, roots: ['/tmp'] }), /not implemented/);
  assert.throws(() => createRunManagerFor('qoder', { push: () => {}, roots: ['/tmp'] }), /not implemented/);
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

test('dispatch: session/start with codex provider raises not-implemented', async () => {
  await assert.rejects(
    handleRpc(
      'session/start',
      { ...baseParams, provider: 'codex' },
      cfg,
    ),
    /not implemented/,
  );
});

test('dispatch: session/interrupt and approval/respond shape responses on unknown targets', async () => {
  assert.deepEqual(await handleRpc('session/interrupt', { appSessionId: 'nope' }, cfg), { interrupted: false });
  assert.deepEqual(
    await handleRpc('approval/respond', { requestId: 'x', decision: { allow: true } }, cfg),
    { accepted: false },
  );
});
