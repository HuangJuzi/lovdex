import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_OPERATOR_CONFIG,
  type OperatorConfig,
} from '@/modules/operators/operator.config.js';
import {
  __resetAutoVerdictQueue,
  scheduleAutoVerdict,
} from '@/modules/operators/operator-verdict.service.js';
import type { VerdictLlmOutcome } from '@/modules/operators/operator-verdict-llm.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';
import type { AiVerdict } from '@/shared/task-status.js';
import type { TaskRow, TaskStatus } from '@/shared/types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks so async pump()/finally callbacks settle. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** A controllable promise for the concurrency test. */
function makeDeferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cfgWith(overrides: Partial<OperatorConfig> = {}): OperatorConfig {
  return { ...DEFAULT_OPERATOR_CONFIG, ...overrides };
}

/** Config pinned to the legacy full-provider verdict path. */
function providerCfg(overrides: Partial<OperatorConfig> = {}): OperatorConfig {
  return cfgWith({ verdict_mode: 'provider', ...overrides });
}

// ---------------------------------------------------------------------------
// TaskRow fake (mirrors operator-summary.test.ts)
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: 't1',
    project_path: '/p',
    title: 'x',
    description: null,
    status: 'in_progress',
    sub_status: null,
    executor_provider: 'claude',
    executor_model: null,
    position: 1,
    session_id: 's1',
    source_schedule_id: null,
    permission_mode: 'default',
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ai_summary: null,
    verdict_reason: null,
    verdict_at: null,
    priority: 'P2',
    deadline: null,
    is_operator: 0,
    label: 'other',
    remark: null,
    context_summary: null,
    context_source_session_id: null,
    context_mode: 'none',
    context_status: null,
    context_raw: null,
    ...overrides,
  };
}

function makeDb(rows: TaskRow[]) {
  const tasks = new Map<string, TaskRow>(rows.map((r) => [r.task_id, r]));
  const db = {
    createTask: () => {
      throw new Error('createTask not used');
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskBySessionId: (sid: string) =>
      [...tasks.values()].find((r) => r.session_id === sid) ?? null,
    listTasks: () => [...tasks.values()],
    updateTask: () => {
      throw new Error('updateTask not used');
    },
    updateTaskStatus: (id: string, status: string) => {
      const t = tasks.get(id);
      if (t) t.status = status as TaskStatus;
    },
    updateTaskSubStatus: (id: string, sub: string | null) => {
      const t = tasks.get(id);
      if (t) t.sub_status = sub as TaskRow['sub_status'];
    },
    clearVerdictFields: (id: string) => {
      const t = tasks.get(id);
      if (t) { t.ai_summary = null; t.verdict_reason = null; t.verdict_at = null; }
    },
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
    writeSummary: (
      taskId: string,
      input: { summary: string; verdict: AiVerdict; reason?: string | null },
    ): TaskRow | null => {
      const t = tasks.get(taskId);
      if (!t) return null;
      t.ai_summary = input.summary;
      t.sub_status = input.verdict;
      t.verdict_reason = input.reason ?? null;
      t.verdict_at = new Date().toISOString();
      return t;
    },
  };
  return db as unknown as TaskDbLike;
}

// ===========================================================================
// Part A: onSessionStatus('completed') → onTaskCompleted hook
// ===========================================================================

test('onSessionStatus completed calls onTaskCompleted with (taskId, title, sessionId)', () => {
  const rows: TaskRow[] = [
    makeRow({ task_id: 't1', title: 'fix bug', session_id: 's1', status: 'in_progress' }),
  ];
  let captured: { taskId?: string; title?: string; sessionId?: string | null } = {};
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    onTaskCompleted: (taskId, title, sessionId) => {
      captured = { taskId, title, sessionId };
    },
  });

  svc.onSessionStatus('s1', 'completed');

  // status transition happened first
  assert.equal(rows[0].status, 'in_review');
  // then the hook fired with the row's identifying fields
  assert.equal(captured.taskId, 't1');
  assert.equal(captured.title, 'fix bug');
  assert.equal(captured.sessionId, 's1');
});

test('onSessionStatus completed fires onTaskCompleted even when task was not in_progress', () => {
  // A session that completes while the task is already in_review (e.g. a resumed
  // run) should still trigger the auto-verdict hook.
  const rows: TaskRow[] = [
    makeRow({ task_id: 't2', title: 're-check', session_id: 's2', status: 'in_review' }),
  ];
  let called = false;
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    onTaskCompleted: () => {
      called = true;
    },
  });

  svc.onSessionStatus('s2', 'completed');
  assert.ok(called, 'onTaskCompleted should fire on every completed session');
});

test('onSessionStatus completed without onTaskCompleted opt is a no-op (backward compat)', () => {
  const rows: TaskRow[] = [
    makeRow({ task_id: 't1', session_id: 's1', status: 'in_progress' }),
  ];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  // must not throw
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_review');
});

// ===========================================================================
// Part B: scheduleAutoVerdict unit tests
// ===========================================================================

test('scheduleAutoVerdict calls runHeadless once for a non-operator session (provider mode)', async () => {
  __resetAutoVerdictQueue();
  let calls = 0;
  const spy = async () => {
    calls++;
  };

  scheduleAutoVerdict('s1', 't1', 'fix bug', false, spy, () => providerCfg());
  await flush();

  assert.equal(calls, 1);
});

test('scheduleAutoVerdict does NOT call runHeadless for an operator session (recursion guard)', async () => {
  __resetAutoVerdictQueue();
  let calls = 0;
  const spy = async () => {
    calls++;
  };

  scheduleAutoVerdict('s1', 't1', 'x', true, spy, () => cfgWith());
  await flush();

  assert.equal(calls, 0, 'operator session triggered its own verdict');
});

test('scheduleAutoVerdict does NOT call runHeadless when auto_verdict_enabled is false', async () => {
  __resetAutoVerdictQueue();
  let calls = 0;
  const spy = async () => {
    calls++;
  };

  scheduleAutoVerdict('s1', 't1', 'x', false, spy, () =>
    cfgWith({ auto_verdict_enabled: false }),
  );
  await flush();

  assert.equal(calls, 0, 'runHeadless called despite auto_verdict_enabled=false');
});

test('scheduleAutoVerdict does NOT call runHeadless when operator disabled', async () => {
  __resetAutoVerdictQueue();
  let calls = 0;
  const spy = async () => {
    calls++;
  };

  scheduleAutoVerdict('s1', 't1', 'x', false, spy, () => cfgWith({ enabled: false }));
  await flush();

  assert.equal(calls, 0, 'runHeadless called despite enabled=false');
});

test('scheduleAutoVerdict queues jobs beyond max_concurrent (3rd not run until a slot frees)', async () => {
  __resetAutoVerdictQueue();
  const calls: string[] = [];
  const deferreds: ReturnType<typeof makeDeferred>[] = [];
  const spy = async (args: { sessionId: string }) => {
    calls.push(args.sessionId);
    const d = makeDeferred();
    deferreds.push(d);
    return d.promise;
  };
  const getConfig = () => providerCfg({ max_concurrent: 2 });

  // schedule 3 jobs; max_concurrent=2 → only 2 should start immediately
  scheduleAutoVerdict('s1', 't1', 'x', false, spy, getConfig);
  scheduleAutoVerdict('s2', 't2', 'x', false, spy, getConfig);
  scheduleAutoVerdict('s3', 't3', 'x', false, spy, getConfig);
  await flush();

  assert.equal(calls.length, 2, `expected 2 active, got ${calls.length}`);
  assert.deepEqual(calls, ['s1', 's2']);

  // free a slot → the 3rd job should start
  deferreds[0].resolve();
  await flush();

  assert.equal(calls.length, 3, '3rd job did not start after a slot freed');
  assert.equal(calls[2], 's3');

  // clean up: resolve remaining deferreds so no dangling promises
  deferreds[1].resolve();
  deferreds[2].resolve();
  await flush();
});

test('scheduleAutoVerdict swallows runHeadless rejection (does not throw, does not crash)', async () => {
  __resetAutoVerdictQueue();
  const spy = async () => {
    throw new Error('headless boom');
  };

  // must not throw synchronously
  assert.doesNotThrow(() => {
    scheduleAutoVerdict('s1', 't1', 'x', false, spy, () => cfgWith());
  });

  // must not produce an unhandled rejection — flush and survive
  await flush();
});

// ===========================================================================
// Part C: verdict_mode routing (llm-first, provider fallback)
//
// The 'llm' default itself is asserted in operator-config.test.ts; here `cfgWith()`
// inherits DEFAULT_OPERATOR_CONFIG, so every test below runs in llm mode unless
// it asks for providerCfg().
// ===========================================================================

test('llm mode calls runLlm and does NOT spawn a headless provider run when a verdict is written', async () => {
  __resetAutoVerdictQueue();
  let headless = 0;
  let llm = 0;

  scheduleAutoVerdict(
    's1', 't1', 'x', false,
    async () => { headless++; },
    () => cfgWith(),
    async () => { llm++; return 'written'; },
  );
  await flush();

  assert.equal(llm, 1);
  assert.equal(headless, 0, 'a written LLM verdict must not also run the provider');
});

test('llm mode does NOT fall back when the LLM path deliberately skipped', async () => {
  __resetAutoVerdictQueue();
  let headless = 0;

  scheduleAutoVerdict(
    's1', 't1', 'x', false,
    async () => { headless++; },
    () => cfgWith(),
    async () => 'skipped',
  );
  await flush();

  assert.equal(headless, 0, 'skipped means no evidence — a provider run would skip too');
});

test('llm mode falls back to runHeadless when the LLM path failed', async () => {
  __resetAutoVerdictQueue();
  let headless = 0;

  scheduleAutoVerdict(
    's1', 't1', 'x', false,
    async () => { headless++; },
    () => cfgWith(),
    async () => 'failed',
  );
  await flush();

  assert.equal(headless, 1);
});

test('llm mode falls back to runHeadless when runLlm rejects (never propagates)', async () => {
  __resetAutoVerdictQueue();
  let headless = 0;

  assert.doesNotThrow(() => {
    scheduleAutoVerdict(
      's1', 't1', 'x', false,
      async () => { headless++; },
      () => cfgWith(),
      async () => { throw new Error('llm boom'); },
    );
  });
  await flush();

  assert.equal(headless, 1, 'a throwing LLM channel must degrade to the provider path');
});

test('provider mode never calls runLlm', async () => {
  __resetAutoVerdictQueue();
  let llm = 0;
  let headless = 0;

  scheduleAutoVerdict(
    's1', 't1', 'x', false,
    async () => { headless++; },
    () => providerCfg(),
    async () => { llm++; return 'written'; },
  );
  await flush();

  assert.equal(headless, 1);
  assert.equal(llm, 0);
});

test('llm mode keeps the operator recursion guard', async () => {
  __resetAutoVerdictQueue();
  let llm = 0;
  let headless = 0;

  scheduleAutoVerdict(
    's1', 't1', 'x', true,
    async () => { headless++; },
    () => cfgWith(),
    async () => { llm++; return 'written'; },
  );
  await flush();

  assert.equal(llm, 0, 'operator session triggered its own LLM verdict');
  assert.equal(headless, 0);
});

test('llm mode keeps the auto_verdict_enabled / enabled gates', async () => {
  __resetAutoVerdictQueue();
  let llm = 0;
  const spy = async (): Promise<VerdictLlmOutcome> => { llm++; return 'written'; };

  scheduleAutoVerdict('s1', 't1', 'x', false, async () => {}, () =>
    cfgWith({ auto_verdict_enabled: false }), spy);
  scheduleAutoVerdict('s2', 't2', 'x', false, async () => {}, () =>
    cfgWith({ enabled: false }), spy);
  await flush();

  assert.equal(llm, 0);
});

test('llm mode forwards verdict_llm_prompt_override from config to runLlm', async () => {
  __resetAutoVerdictQueue();
  const seen: Array<string | null | undefined> = [];

  scheduleAutoVerdict(
    's1', 't1', 'x', false,
    async () => {},
    () => cfgWith({ verdict_llm_prompt_override: '只看 E2E' }),
    async (args) => { seen.push(args.promptOverride); return 'written'; },
  );
  await flush();

  assert.deepEqual(seen, ['只看 E2E']);
});

test('llm mode forwards a null override unchanged (built-in criteria)', async () => {
  __resetAutoVerdictQueue();
  const seen: Array<string | null | undefined> = [];

  scheduleAutoVerdict(
    's1', 't1', 'x', false,
    async () => {},
    () => cfgWith({ verdict_llm_prompt_override: null }),
    async (args) => { seen.push(args.promptOverride); return 'written'; },
  );
  await flush();

  assert.deepEqual(seen, [null]);
});

test('llm mode queues jobs beyond max_concurrent just like provider mode', async () => {
  __resetAutoVerdictQueue();
  const started: string[] = [];
  const deferreds: ReturnType<typeof makeDeferred>[] = [];
  const runLlm = async (args: { sessionId: string }): Promise<VerdictLlmOutcome> => {
    started.push(args.sessionId);
    const d = makeDeferred();
    deferreds.push(d);
    await d.promise;
    return 'written';
  };
  const getConfig = () => cfgWith({ max_concurrent: 2 });

  scheduleAutoVerdict('s1', 't1', 'x', false, async () => {}, getConfig, runLlm);
  scheduleAutoVerdict('s2', 't2', 'x', false, async () => {}, getConfig, runLlm);
  scheduleAutoVerdict('s3', 't3', 'x', false, async () => {}, getConfig, runLlm);
  await flush();

  assert.deepEqual(started, ['s1', 's2'], 'max_concurrent=2 should gate the 3rd LLM job');

  deferreds[0].resolve();
  await flush();
  assert.equal(started.length, 3);

  deferreds[1].resolve();
  deferreds[2].resolve();
  await flush();
});

// ---------------------------------------------------------------------------
// Ensure module-level queue is clean for any later test files in the suite.
// ---------------------------------------------------------------------------

test('cleanup: reset queue after trigger tests', () => {
  __resetAutoVerdictQueue();
});
