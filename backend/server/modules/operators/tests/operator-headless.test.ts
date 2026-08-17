import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOperatorSdkTools,
  runOperatorHeadless,
  adaptTasksServiceForOperatorTools,
} from '@/claude-sdk.js';

/**
 * Minimal fake OperatorToolDeps.tasks — stubs every method the operator tool
 * set references so buildOperatorTools/buildOperatorSdkTools can wire without
 * the real TasksService. Only `writeSummary` is exercised here; the rest just
 * need to exist so the tool handlers can be constructed.
 */
function fakeTasks() {
  return {
    createTask: (i: unknown) => ({ task_id: 't1', ...(i as object) }),
    listTasks: () => [],
    getTask: (id: string) => ({ task_id: id }),
    writeSummary: (id: string, i: unknown) => ({ task_id: id, ...(i as object) }),
    startExecution: (id: string) => ({ task_id: id, started: true }),
    updateTask: (id: string, u: unknown) => ({ task_id: id, ...(u as object) }),
    moveTask: (id: string, status: string) => ({ task_id: id, status }),
  };
}

function fakeDeps() {
  return {
    tasks: fakeTasks(),
    projects: {
      getProjectPaths: () => [],
      getProjectPathById: () => null,
    },
    sessions: {
      fetchHistory: () => ({ messages: [], total: 0 }),
    },
    contextProjectPath: null,
  };
}

/** An async iterable that drains immediately — simulates a query() result. */
function emptyIterable() {
  return (async function* () {
    /* no messages */
  })();
}

test('buildOperatorSdkTools includes the closed operator tool set', () => {
  const tools = buildOperatorSdkTools(fakeDeps() as never);
  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes('write_task_summary'), `write_task_summary missing: ${names.join(',')}`);
  // safety boundary: no built-in bash/Edit/Write leak in the operator tool set
  for (const forbidden of ['Bash', 'Edit', 'Write', 'Read', 'AskUserQuestion']) {
    assert.ok(!names.includes(forbidden), `${forbidden} leaked into operator tools`);
  }
});

test('adaptTasksServiceForOperatorTools forwards priority from createTask to the service', () => {
  let received: { priority?: string } = {};
  const fakeSvc = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't1' };
    },
    listTasks: () => [],
    getTask: () => null,
    writeSummary: () => ({}),
    startExecution: () => ({}),
    updateTask: () => ({}),
    moveTask: () => ({}),
  };
  const adapted = adaptTasksServiceForOperatorTools(fakeSvc);
  adapted.createTask({ projectPath: '/p', title: 't', priority: 'P1' });
  assert.equal(received.priority, 'P1', 'priority must reach the real service, not be dropped by the adapter');
});

test('SDK input schema surfaces priority as a P0-P3 enum, not a bare string', () => {
  // Regression: buildOperatorTools declares priority with an enum, but
  // jsonSchemaToZodRawShape used to drop it — the model saw `priority?: string`
  // with no hint of valid values, so it guessed "high"/numbers and got rejected
  // only at the handler. The SDK schema must carry the exact allowed values so
  // the model can pick a valid priority up front.
  const tools = buildOperatorSdkTools(fakeDeps() as never);
  const createTask = tools.find((t: { name: string }) => t.name === 'create_task');
  assert.ok(createTask, 'create_task tool missing');
  const priority = (createTask as { inputSchema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }).inputSchema.priority;
  assert.ok(priority, 'create_task SDK inputSchema must declare priority');

  for (const valid of ['P0', 'P1', 'P2', 'P3']) {
    assert.equal(priority.safeParse(valid).success, true, `priority ${valid} must be accepted by the schema`);
  }
  assert.equal(priority.safeParse(undefined).success, true, 'priority must stay optional');
  assert.equal(priority.safeParse('P9').success, false, 'out-of-enum priority must be rejected by the schema');
  assert.equal(priority.safeParse(1).success, false, 'numeric priority must be rejected by the schema');
  assert.equal(priority.safeParse('high').success, false, 'free-text priority must be rejected by the schema');
});

test('runOperatorHeadless calls query with prompt containing sessionId/taskId/title', async () => {
  let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
  const queryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => {
    captured = params;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'Implement login',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  const prompt = String(captured.prompt);
  assert.ok(prompt.includes('sess-123'), `prompt missing sessionId: ${prompt}`);
  assert.ok(prompt.includes('task-456'), `prompt missing taskId: ${prompt}`);
  assert.ok(prompt.includes('Implement login'), `prompt missing title: ${prompt}`);

  const options = captured.options!;
  // operator MCP server wired
  const mcp = options.mcpServers as Record<string, unknown>;
  assert.ok(mcp && mcp['lovdex-operator'], 'operator mcp server not wired');
  // closed tool set: built-in tools disabled
  assert.deepEqual(options.tools, [], 'built-in tools not disabled');
  // headless: no websocket sink plumbed through the SDK options
  assert.ok(!('ws' in options) && !('writer' in options), 'ws/writer leaked into headless options');
});

test('default verdict prompt + systemPrompt anchor on final output and weigh quality+verification+finish', async () => {
  let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
  const queryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => {
    captured = params;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'Implement login',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  const prompt = String(captured.prompt);
  // final output is the decisive signal
  assert.ok(prompt.includes('finalOutput'), 'prompt should name finalOutput as the first-class signal');
  // the verdict must weigh actual quality + verification + finish, not just the trailing wording
  assert.ok(/实际产出质量|验证结果|是否真正收尾/.test(prompt), 'prompt should weigh quality+verification+finish, not just trailing wording');
  // needs_review stays available for genuine user-decision pending
  assert.ok(prompt.includes('needs_review'), 'prompt should mention needs_review verdict');
  assert.ok(/提问|确认|决策/.test(prompt), 'prompt should still reference pending questions / decisions');
  // done is reachable when work is substantively complete
  assert.ok(prompt.includes('done'), 'prompt should still describe the done condition');

  const options = captured.options!;
  const sys = String(options.systemPrompt ?? '');
  assert.ok(sys.includes('finalOutput'), 'systemPrompt should anchor on finalOutput');
  assert.ok(sys.includes('needs_review'), 'systemPrompt should mention needs_review');
});

test('default verdict prompt treats verified work with only a routine commit/push tail as done, not failed/blocked', async () => {
  // Regression: case 49e08eb1 — root cause located, fix landed, unit + E2E all
  // green, only the commit/push remained, and the agent ended with a polite
  // "要我提交并推送吗？". The old prompt forced needs_review/blocked on any
  // trailing question regardless of work done. The new prompt must instruct
  // that a routine commit/push tail (the agent's expected duty per Lovdex
  // user preference) does NOT block done.
  let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
  const queryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => {
    captured = params;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'Fix Lovdex 助手新建 session BUG',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  const prompt = String(captured.prompt);
  // routine commit/push/merge is the agent's duty, not a user-decision gate
  assert.ok(/提交|推送|合入/.test(prompt), 'prompt should reference routine commit/push/merge tail');
  assert.ok(/例行|Agent.*职责|不算用户决策门/.test(prompt), 'prompt should mark routine commit/push as the agent duty, not a user gate');
  // a trailing question alone must NOT force needs_review/blocked when work is done + verified
  assert.ok(/问句结尾不足以判|礼貌性收尾提问应判 done|不否定完成度/.test(prompt), 'prompt should state a trailing question does not block done');
  // verification signal must be part of the decision
  assert.ok(/验证通过|验证结果|单测|E2E|构建/.test(prompt), 'prompt should reference verification outcome as a decision input');

  const options = captured.options!;
  const sys = String(options.systemPrompt ?? '');
  assert.ok(/问句结尾不足以判|礼貌性收尾提问应判 done/.test(sys), 'systemPrompt should also state trailing question does not block done');
});

test('default verdict prompt reserves needs_review for genuine user-decision pending, not routine commit tail', async () => {
  // needs_review must survive for real user decisions (choosing an approach,
  // business direction, authorizing an external op) — distinct from a routine
  // commit/push tail that maps to done.
  let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
  const queryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => {
    captured = params;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'Pick a deployment strategy',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  const prompt = String(captured.prompt);
  assert.ok(prompt.includes('needs_review'), 'prompt should still describe needs_review for genuine user decisions');
  assert.ok(/选方案|业务方向|授权|必须用户.*决策/.test(prompt), 'prompt should describe genuine user-decision cases for needs_review');
});

test('runOperatorHeadless prior-verdict context: unrelated AND fully-wrapped appended work may keep done', async () => {
  let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
  const queryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => {
    captured = params;
    return emptyIterable();
  };

  const deps = {
    ...fakeDeps(),
    tasks: {
      ...fakeTasks(),
      // The task already carries an AI verdict from an earlier run (survives reopen).
      getTask: () => ({ task_id: 'task-456', ai_summary: '已完成登录', verdict_at: '2026-08-12T00:00:00Z' }),
    },
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'Implement login',
    queryFn: queryFn as never,
    deps: deps as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  const prompt = String(captured.prompt);
  assert.ok(prompt.includes('此前已被 AI 判定'), `prompt should mention the prior verdict: ${prompt}`);
  // keeping done survives only when the appended work is BOTH unrelated AND itself complete
  assert.ok(/追加工作.*无关.*收尾|无关.*追加工作.*收尾/.test(prompt), 'prompt should tie keeping done to unrelated + complete appended work');
  assert.ok(/可维持 done|维持 done/.test(prompt), 'prompt should preserve the ability to keep done for unrelated complete follow-up');

  const options = captured.options!;
  const sys = String(options.systemPrompt ?? '');
  assert.ok(/无关.*收尾.*可维持 done|可维持 done.*无关/.test(sys), 'systemPrompt should also allow keeping done for unrelated complete follow-up');
});

test('runOperatorHeadless prior-verdict context is a weak reference: plan-only / waiting-review appended work must not be kept done', async () => {
  // Regression: case 47d1fdff — a security task already judged done receives an
  // appended request (change password) that is only a spec with no code landed,
  // and the session pauses waiting for review. The old prompt made the done prior
  // a strong bias ("追加工作与主任务无关 → 保持 done"), so the verdict stayed
  // done instead of judging the actual output (only_plan / needs_review / blocked).
  let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
  const queryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => {
    captured = params;
    return emptyIterable();
  };

  const deps = {
    ...fakeDeps(),
    tasks: {
      ...fakeTasks(),
      getTask: () => ({ task_id: 'task-456', ai_summary: '已完成登录', verdict_at: '2026-08-12T00:00:00Z' }),
    },
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'Implement login',
    queryFn: queryFn as never,
    deps: deps as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  const prompt = String(captured.prompt);
  assert.ok(prompt.includes('弱参考'), 'prompt should mark the prior verdict as a weak reference');
  assert.ok(/only_plan|needs_review|blocked/.test(prompt), 'prompt should keep only_plan/needs_review/blocked reachable despite a done prior');
  assert.ok(/追加工作.*计划|等 review|只有 spec|未实现|代码未写|没有落地/.test(prompt), 'prompt should explicitly name plan-only / unimplemented / waiting-review appended work as independently judged');
  assert.ok(/独立评审|不得.*done|历史.*done|强行.*done/.test(prompt), 'prompt must forbid the history prior from forcing done on incomplete appended work');

  const options = captured.options!;
  const sys = String(options.systemPrompt ?? '');
  assert.ok(sys.includes('弱参考'), 'systemPrompt should also treat the prior verdict as a weak reference');
});

test('runOperatorHeadless swallows query failures (logs, does not throw)', async () => {
  const throwingQuery = () => {
    return (async function* () {
      throw new Error('boom from claude');
    })();
  };

  // must not reject
  await runOperatorHeadless({
    sessionId: 's',
    taskId: 't',
    title: 'x',
    queryFn: throwingQuery as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });
});

test('runOperatorHeadless returns early without calling query when auto_verdict_enabled is false', async () => {
  let called = false;
  const queryFn = () => {
    called = true;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 's',
    taskId: 't',
    title: 'x',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: false,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  assert.equal(called, false, 'query was called despite auto_verdict_enabled=false');
});

test('runOperatorHeadless returns early when operator disabled', async () => {
  let called = false;
  const queryFn = () => {
    called = true;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 's',
    taskId: 't',
    title: 'x',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: false,
      auto_verdict_enabled: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  assert.equal(called, false, 'query was called despite enabled=false');
});
