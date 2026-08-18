import assert from 'node:assert/strict';
import test from 'node:test';

import { startHeadlessTaskRun } from '@/modules/websocket/services/headless-task-run.service.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionRow = {
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  is_operator: number;
};

function makeSpawnFn(captured: { command?: string; options?: Record<string, unknown>; writer?: unknown }) {
  return async (command: string, options: Record<string, unknown>, writer: unknown) => {
    captured.command = command;
    captured.options = options;
    captured.writer = writer;
  };
}

test('starts a run with connection=null and dispatches the provider runtime fire-and-forget', async () => {
  const session: SessionRow = {
    provider: 'claude',
    provider_session_id: null,
    project_path: '/proj',
    is_operator: 0,
  };
  const captured: { command?: string; options?: Record<string, unknown>; writer?: unknown } = {};
  let startRunCalls = 0;
  let completeCalls = 0;

  const ok = startHeadlessTaskRun(
    'sess-1',
    { content: 'do the thing', model: 'claude-sonnet-4-6', spawnFns: { claude: makeSpawnFn(captured) } as never },
    {
      getSessionById: () => session,
      startRun: (input) => {
        startRunCalls++;
        // The launcher must pass a null-ish connection so the writer's
        // addConnection no-ops — no browser socket in headless mode.
        assert.equal(input.appSessionId, 'sess-1');
        assert.equal(input.provider, 'claude');
        assert.equal(input.providerSessionId, null);
        assert.equal(input.userId, null);
        return { writer: { id: 'w' } };
      },
      completeRunIfCurrent: () => {
        completeCalls++;
      },
    },
  );

  assert.equal(ok, true);
  assert.equal(startRunCalls, 1);
  // The spawnFn runs in a detached async IIFE; let it settle.
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.command, 'do the thing');
  assert.equal(captured.options?.model, 'claude-sonnet-4-6');
  assert.equal(captured.options?.permissionMode, 'default');
  assert.equal(captured.options?.resume, false, 'fresh session (no provider_session_id) → resume=false');
  assert.equal(captured.options?.cwd, '/proj');
  assert.equal(captured.options?.projectPath, '/proj');
  assert.equal(captured.options?.isOperator, false);
  assert.equal(captured.options?.isTaskRun, true, 'server-side task runs carry isTaskRun so the runtime guards fan-out');
  assert.equal(captured.options?.includePartialMessages, true);
  assert.deepEqual(captured.writer, { id: 'w' });
  assert.equal(completeCalls, 1, 'safety net must run after the runtime settles');
});

test('resume=true and isOperator=true for an existing operator session with a provider id', async () => {
  const session: SessionRow = {
    provider: 'claude',
    provider_session_id: 'native-123',
    project_path: '/op-workspace',
    is_operator: 1,
  };
  const captured: { options?: Record<string, unknown> } = {};
  startHeadlessTaskRun(
    'sess-2',
    { content: 'continue', spawnFns: { claude: makeSpawnFn(captured as never) } as never },
    {
      getSessionById: () => session,
      startRun: () => ({ writer: {} }),
      completeRunIfCurrent: () => {},
    },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.options?.resume, true);
  assert.equal(captured.options?.sessionId, 'native-123');
  assert.equal(captured.options?.isOperator, true);
});

test('returns false for an unknown session', () => {
  const ok = startHeadlessTaskRun(
    'nope',
    { content: 'x', spawnFns: {} as never },
    {
      getSessionById: () => null,
      startRun: () => ({ writer: {} }),
      completeRunIfCurrent: () => {},
    },
  );
  assert.equal(ok, false);
});

test('returns false for an unsupported provider', () => {
  const ok = startHeadlessTaskRun(
    'sess-3',
    { content: 'x', spawnFns: {} as Record<LLMProvider, never> },
    {
      getSessionById: () => ({ provider: 'gemini', provider_session_id: null, project_path: '/p', is_operator: 0 }),
      startRun: () => ({ writer: {} }),
      completeRunIfCurrent: () => {},
    },
  );
  assert.equal(ok, false);
});

test('returns false when a run is already in progress (startRun returns null)', () => {
  let startRunCalls = 0;
  const ok = startHeadlessTaskRun(
    'sess-4',
    { content: 'x', spawnFns: { claude: makeSpawnFn({} as never) } as never },
    {
      getSessionById: () => ({ provider: 'claude', provider_session_id: null, project_path: '/p', is_operator: 0 }),
      startRun: () => {
        startRunCalls++;
        return null;
      },
      completeRunIfCurrent: () => {},
    },
  );
  assert.equal(ok, false);
  assert.equal(startRunCalls, 1, 'startRun is still attempted; the registry decides to reject');
});

test('a throwing spawnFn is swallowed and the safety net still runs', async () => {
  let completeCalls = 0;
  const ok = startHeadlessTaskRun(
    'sess-5',
    {
      content: 'x',
      spawnFns: {
        claude: async () => {
          throw new Error('runtime blew up');
        },
      } as never,
    },
    {
      getSessionById: () => ({ provider: 'claude', provider_session_id: null, project_path: '/p', is_operator: 0 }),
      startRun: () => ({ writer: {} }),
      completeRunIfCurrent: () => {
        completeCalls++;
      },
    },
  );
  assert.equal(ok, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(completeCalls, 1, 'finally must still complete the run after a runtime error');
});
