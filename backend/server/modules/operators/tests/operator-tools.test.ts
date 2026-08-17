import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperatorTools } from '@/modules/operators/operator.tools.js';

test('create_task handler defaults status to todo + uses contextProjectPath', async () => {
  let received: { projectPath?: string; title?: string; status?: string } = {};
  const fakeTasks = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't1', status: 'todo' };
    },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never, contextProjectPath: '/ctx-proj' });

  await tools.create_task.handler({ title: 'x' });
  assert.equal(received.status, 'todo');
  assert.equal(received.projectPath, '/ctx-proj');

  // explicit projectPath overrides the context fallback
  await tools.create_task.handler({ title: 'y', projectPath: '/explicit' });
  assert.equal(received.projectPath, '/explicit');
});

test('create_task handler forwards priority to the tasks service', async () => {
  let received: { priority?: string } = {};
  const fakeTasks = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't1', status: 'todo' };
    },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never, contextProjectPath: '/ctx' });

  // explicit priority is forwarded verbatim
  await tools.create_task.handler({ title: 'urgent', priority: 'P1' });
  assert.equal(received.priority, 'P1');

  // omitted priority is not injected — the service applies its own P2 default
  await tools.create_task.handler({ title: 'plain' });
  assert.equal(received.priority, undefined);
});

test('create_task handler rejects an invalid priority', async () => {
  const fakeTasks = { createTask: () => ({ task_id: 't1' }) };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  // The model can send any string; cast simulates an out-of-enum value at runtime.
  await assert.rejects(
    () => tools.create_task.handler({ title: 'x', priority: 'P9' as never }),
    /invalid priority/,
  );
});

test('update_task handler forwards priority to the tasks service', async () => {
  let received: Record<string, unknown> = {};
  const fakeTasks = {
    updateTask: (id: string, u: unknown) => {
      received = { id, ...(u as object) };
      return { task_id: id };
    },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });

  await tools.update_task.handler({ taskId: 't1', priority: 'P0' });
  assert.equal(received.id, 't1');
  assert.equal(received.priority, 'P0');

  // title + priority can be updated together
  await tools.update_task.handler({ taskId: 't2', title: 'renamed', priority: 'P3' });
  assert.equal(received.title, 'renamed');
  assert.equal(received.priority, 'P3');
});

test('update_task handler rejects an invalid priority', async () => {
  const fakeTasks = { updateTask: () => ({ task_id: 't1' }) };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await assert.rejects(
    () => tools.update_task.handler({ taskId: 't1', priority: 'PX' as never }),
    /invalid priority/,
  );
});

test('create_task/update_task input schema declares priority as P0-P3 enum', () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  for (const name of ['create_task', 'update_task']) {
    const props = tools[name].inputSchema.properties as Record<string, { type?: string; enum?: string[]; description?: string }>;
    const priority = props.priority;
    assert.ok(priority, `${name} inputSchema must declare priority`);
    assert.equal(priority.type, 'string');
    assert.deepEqual(priority.enum, ['P0', 'P1', 'P2', 'P3']);
    assert.ok(typeof priority.description === 'string' && priority.description.length > 0,
      `${name} priority must carry a description so the model knows the valid values`);
  }
});

test('write_task_summary handler delegates to service', async () => {
  let called = false;
  const fakeTasks = { writeSummary: () => { called = true; return { verdict: 'done' }; } };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await tools.write_task_summary.handler({ taskId: 't1', summary: 's', verdict: 'done' });
  assert.equal(called, true);
});

test('write_task_summary handler rejects invalid verdict', async () => {
  const fakeTasks = { writeSummary: () => ({ verdict: 'done' }) };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await assert.rejects(() =>
    tools.write_task_summary.handler({ taskId: 't1', summary: 's', verdict: 'bogus' }),
  );
});

test('start_task_execution forwards the injected createSession to tasks.startExecution', async () => {
  // Regression for "createSession is not a function": buildOperatorTools must
  // pass the wired deps.createSession through to startExecution. index.js wires
  // it into initOperatorHeadless; a missing dep (the old wiring) made the
  // handler call startExecution(taskId, undefined) and crash in the service.
  let receivedId: string | undefined;
  let receivedCreateSession: unknown;
  const createSession = () => 'sess-created';
  const fakeTasks = {
    startExecution: (id: string, cs: unknown) => {
      receivedId = id;
      receivedCreateSession = cs;
      return { sessionId: 'sess-created' };
    },
  };
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    createSession,
    startTaskRun: () => true,
  });

  const out = await tools.start_task_execution.handler({ taskId: 't1' });
  assert.equal(receivedId, 't1');
  assert.equal(receivedCreateSession, createSession, 'createSession must be passed through, not undefined');
  assert.deepEqual(out, { sessionId: 'sess-created' });
});

test('start_task_execution passes provider/projectPath/isOperator to the injected createSession', async () => {
  // Mirrors tasks.service.startExecution: createSession(provider, projectPath, isOperator).
  // Guards that the operator tool set keeps dispatching real session allocation.
  let receivedArgs: unknown[] = [];
  const createSession = (...args: unknown[]) => {
    receivedArgs = args;
    return 'sess-xyz';
  };
  const fakeTasks = {
    startExecution: (_id: string, cs: (p: string, proj: string, isOp?: boolean) => string) =>
      cs('claude', '/workspace/proj', true),
  };
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    createSession,
    startTaskRun: () => true,
  });

  const out = await tools.start_task_execution.handler({ taskId: 't1' });
  assert.equal(out, 'sess-xyz');
  assert.deepEqual(receivedArgs, ['claude', '/workspace/proj', true]);
});

test('start_task_execution invokes startTaskRun with (taskId, sessionId) after startExecution', async () => {
  // The fix for "start_task_execution only creates a session, never runs the
  // agent": after startExecution returns a sessionId, the handler must call the
  // injected headless launcher so the task actually starts. Returns the
  // sessionId so the operator can still inspect the session.
  const createSession = () => 'sess-run';
  const fakeTasks = {
    startExecution: () => ({ sessionId: 'sess-run' }),
  };
  let launchCalls: Array<{ taskId: string; sessionId: string }> = [];
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    createSession,
    startTaskRun: (taskId: string, sessionId: string) => {
      launchCalls.push({ taskId, sessionId });
      return true;
    },
  });

  const out = await tools.start_task_execution.handler({ taskId: 't9' });
  assert.deepEqual(out, { sessionId: 'sess-run' });
  assert.deepEqual(launchCalls, [{ taskId: 't9', sessionId: 'sess-run' }]);
});

test('start_task_execution swallows a throwing startTaskRun and still returns the sessionId', async () => {
  // A headless-launch failure must not crash the tool — the session is already
  // created and linked, so the operator can still inspect it. Mirrors the error
  // isolation of scheduleAutoVerdict.
  const createSession = () => 'sess-throw';
  const fakeTasks = {
    startExecution: () => ({ sessionId: 'sess-throw' }),
  };
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    createSession,
    startTaskRun: () => {
      throw new Error('boom');
    },
  });

  const out = await tools.start_task_execution.handler({ taskId: 't1' });
  assert.deepEqual(out, { sessionId: 'sess-throw' });
});

test('start_task_execution still returns sessionId when startTaskRun is not wired', async () => {
  // Backward compat / pure-logic test fixtures omit startTaskRun. The handler
  // must not require it — it just skips the launch and returns the session.
  const createSession = () => 'sess-bare';
  const fakeTasks = {
    startExecution: () => ({ sessionId: 'sess-bare' }),
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never, createSession });

  const out = await tools.start_task_execution.handler({ taskId: 't1' });
  assert.deepEqual(out, { sessionId: 'sess-bare' });
});

test('get_session_transcript returns finalOutput = newest assistant text (offset 0)', async () => {
  const messages = [
    { role: 'user', content: '开头' },
    { role: 'assistant', content: '我在改代码' },
    { role: 'tool', kind: 'tool', toolName: 'Bash', toolResult: 'ok' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '要我按你惯常的方式提交并推送吗？还是先在 dev server 里看效果？' },
  ];
  const fakeSessions = {
    fetchHistory: async () => ({ messages, total: messages.length, hasMore: false }),
  };
  const tools = buildOperatorTools({ tasks: {} as never, sessions: fakeSessions as never });
  const out = await tools.get_session_transcript.handler({ sessionId: 's' });
  assert.equal(out.finalOutput, '要我按你惯常的方式提交并推送吗？还是先在 dev server 里看效果？');
  assert.ok(out.transcript.includes('要我按你惯常的方式提交并推送吗？'), 'final question should also appear in transcript');
  assert.equal(out.offset, 0);
  assert.equal(out.limit, 40);
});

test('get_session_transcript finalOutput stays the newest assistant text when paginating older pages', async () => {
  const tailMessages = [{ role: 'assistant', content: '最终输出：全部完成，无待决策事项' }];
  const pageMessages = [{ role: 'user', content: '一段更早的历史消息' }];
  const fakeSessions = {
    fetchHistory: async (_id: string, opts: { limit?: number; offset?: number }) => {
      const offset = opts?.offset ?? 0;
      return { messages: offset === 0 ? tailMessages : pageMessages, total: 100, hasMore: true };
    },
  };
  const tools = buildOperatorTools({ tasks: {} as never, sessions: fakeSessions as never });
  const out = await tools.get_session_transcript.handler({ sessionId: 's', offset: 40, limit: 40 });
  assert.equal(out.finalOutput, '最终输出：全部完成，无待决策事项');
  assert.ok(out.transcript.includes('一段更早的历史消息'), 'page should carry the requested older slice');
});

test('get_session_transcript finalOutput is null when no assistant text exists', async () => {
  const fakeSessions = {
    fetchHistory: async () => ({ messages: [{ role: 'user', content: '只有用户消息' }], total: 1, hasMore: false }),
  };
  const tools = buildOperatorTools({ tasks: {} as never, sessions: fakeSessions as never });
  const out = await tools.get_session_transcript.handler({ sessionId: 's' });
  assert.equal(out.finalOutput, null);
});
