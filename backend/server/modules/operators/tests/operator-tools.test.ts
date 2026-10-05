import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperatorTools } from '@/modules/operators/operator.tools.js';
import { MAX_TASK_DISPATCH_DEPTH } from '@/modules/operators/task-run-guard.js';

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
  // A task the assistant creates runs unattended (start_task_execution has no
  // approval channel), so it must carry the auto-approve mode, not `default`.
  assert.equal((received as { permissionMode?: string }).permissionMode, 'autoApprove');

  // explicit projectPath overrides the context fallback
  await tools.create_task.handler({ title: 'y', projectPath: '/explicit' });
  assert.equal(received.projectPath, '/explicit');
});

test('create_task without projectPath lands in the assistant workspace when wired as operator context', async () => {
  let received: { projectPath?: string; isOperator?: boolean } = {};
  const fakeTasks = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't2', status: 'todo' };
    },
  };
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    contextProjectPath: '/lovdex-ws',
    contextIsOperatorWorkspace: true,
  });

  // omitted projectPath → Lovdex助手 workspace + is_operator flag, so the task
  // board「🤖 Lovdex 助手」filter (task.is_operator === 1) can surface it
  await tools.create_task.handler({ title: 'helper' });
  assert.equal(received.projectPath, '/lovdex-ws');
  assert.equal(received.isOperator, true);

  // explicit projectPath still wins and clears the operator flag
  await tools.create_task.handler({ title: 'helper', projectPath: '/explicit' });
  assert.equal(received.projectPath, '/explicit');
  assert.equal(received.isOperator, undefined);
});

test('create_task omits isOperator when not in the assistant workspace context', async () => {
  let received: { projectPath?: string; isOperator?: boolean } = {};
  const fakeTasks = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't3', status: 'todo' };
    },
  };
  // Manual buildOperatorTools usage without the workspace marker keeps the old
  // context-fallback behavior and never fiddles with the operator flag.
  const tools = buildOperatorTools({ tasks: fakeTasks as never, contextProjectPath: '/ctx' });
  await tools.create_task.handler({ title: 'plain' });
  assert.equal(received.projectPath, '/ctx');
  assert.equal(received.isOperator, undefined);
});

test('create_task stamps lineage (parent_task_id + dispatch_depth) when the assistant context is a task session', async () => {
  let received: { parentTaskId?: string | null; dispatchDepth?: number } = {};
  const fakeTasks = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't4', status: 'todo' };
    },
  };
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    contextSessionId: 'sess-parent',
    // The parent task is a depth-1 dispatch; the new child must be depth 2.
    lineage: () => ({ taskId: 'task-parent', depth: 1 }),
  });
  await tools.create_task.handler({ title: 'child' });
  assert.equal(received.parentTaskId, 'task-parent');
  assert.equal(received.dispatchDepth, 2);
});

test('create_task refuses to dispatch past the fan-out depth cap', async () => {
  const fakeTasks = {
    createTask: (i: unknown) => ({ task_id: 't5', status: 'todo' }),
  };
  // A depth already at the cap: the next child would exceed it.
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    lineage: () => ({ taskId: 'task-parent', depth: MAX_TASK_DISPATCH_DEPTH }),
  });
  await assert.rejects(() => tools.create_task.handler({ title: 'grandchild' }), /派发深度/);
});

test('list_tasks caps rows and projects a light shape (large-output guard)', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    task_id: `task-${i}`,
    title: `Task ${i}`,
    status: 'todo',
    priority: 'P2',
    description: 'x'.repeat(1000),
  }));
  const tools = buildOperatorTools({ tasks: { listTasks: () => rows } as never });
  // No limit → default 50.
  const dflt = (await tools.list_tasks.handler({})) as { total: number; tasks: unknown[]; hasMore: boolean };
  assert.equal(dflt.total, 250);
  assert.equal(dflt.tasks.length, 50, 'default page is 50');
  // An explicit limit is hard-capped at 200 even when the caller asks for more.
  const capped = (await tools.list_tasks.handler({ limit: 1000 })) as { total: number; tasks: unknown[]; hasMore: boolean };
  assert.equal(capped.tasks.length, 200, 'hard cap at 200 rows');
  assert.equal(capped.hasMore, true);
  // The projection must not leak the fat `description` field.
  assert.equal('description' in (capped.tasks[0] as Record<string, unknown>), false);
  assert.equal((capped.tasks[0] as { taskId?: string }).taskId, 'task-0');
});

test('list_tasks paginates with offset and honours a status filter', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    task_id: `task-${i}`,
    title: `Task ${i}`,
    status: i < 5 ? 'todo' : 'done',
    priority: 'P2',
  }));
  const seen: Array<{ status?: string }> = [];
  const tools = buildOperatorTools({
    tasks: { listTasks: (f: { status?: string }) => { seen.push(f); return rows.filter((r) => !f.status || r.status === f.status); } } as never,
  });
  const result = (await tools.list_tasks.handler({ status: 'done', limit: 2, offset: 1 })) as { tasks: Array<{ taskId?: string }>; hasMore: boolean };
  assert.equal(seen[0].status, 'done');
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].taskId, 'task-6');
  assert.equal(result.hasMore, true);
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
    const props = (tools as unknown as Record<string, { inputSchema: { properties: Record<string, { type?: string; enum?: string[]; description?: string }> } }>)[name].inputSchema.properties;
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

test('create_scheduled_task passes through to scheduledTasks.create', async () => {
  let received: Record<string, unknown> = {};
  const fakeScheduled = {
    create: (i: unknown) => { received = i as Record<string, unknown>; return { schedule_id: 's1' }; },
  };
  const tools = buildOperatorTools({ tasks: {} as never, scheduledTasks: fakeScheduled as never });
  await tools.create_scheduled_task.handler({ title: 't', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z', autoRun: 1 });
  assert.equal(received.scheduleType, 'once');
  assert.equal(received.autoRun, 1);
  assert.equal(received.title, 't');
  // An unattended schedule must never fall through to a null model (the most
  // expensive runtime default) or `default` permission mode (silent approval
  // timeouts) — the handler pins both to safe unattended defaults.
  assert.equal(received.executorModel, 'haiku', 'null model → cheap guard slot');
  assert.equal(received.permissionMode, 'autoApprove', 'no mode → autoApprove');

  // An explicit model/mode is preserved, not clobbered.
  const tools2 = buildOperatorTools({ tasks: {} as never, scheduledTasks: fakeScheduled as never });
  await tools2.create_scheduled_task.handler({ title: 't2', scheduleType: 'once', runAt: '2026-08-14T01:00:00.000Z', autoRun: 1, executorModel: 'DeepSeek-Flash', permissionMode: 'autoApprove' });
  assert.equal(received.executorModel, 'DeepSeek-Flash');
});

test('update_scheduled_task splits scheduleId from the rest', async () => {
  let received: { id?: string; rest?: Record<string, unknown> } = {};
  const fakeScheduled = {
    update: (id: string, u: unknown) => { received = { id, rest: u as Record<string, unknown> }; return { schedule_id: id }; },
  };
  const tools = buildOperatorTools({ tasks: {} as never, scheduledTasks: fakeScheduled as never });
  await tools.update_scheduled_task.handler({ scheduleId: 's1', enabled: 0, title: 'new' });
  assert.equal(received.id, 's1');
  assert.equal(received.rest?.enabled, 0);
  assert.equal(received.rest?.title, 'new');
});

test('list_scheduled_tasks maps enabled and leaves it undefined when omitted', async () => {
  const seen: Array<{ projectPath?: string; enabled?: boolean }> = [];
  const fakeScheduled = {
    list: (f: { projectPath?: string; enabled?: boolean }) => { seen.push(f); return []; },
  };
  const tools = buildOperatorTools({ tasks: {} as never, scheduledTasks: fakeScheduled as never });

  await tools.list_scheduled_tasks.handler({ enabled: 1 });
  assert.deepEqual(seen[0], { projectPath: undefined, enabled: true });

  await tools.list_scheduled_tasks.handler({ enabled: 0 });
  assert.deepEqual(seen[1], { projectPath: undefined, enabled: false });

  // Omitted enabled must NOT filter to disabled-only — it should stay undefined.
  await tools.list_scheduled_tasks.handler({});
  assert.deepEqual(seen[2], { projectPath: undefined, enabled: undefined });
});

test('get/delete_scheduled_task delegate to scheduledTasks', async () => {
  const calls: string[] = [];
  const fakeScheduled = {
    get: (id: string) => { calls.push(`get:${id}`); return { schedule_id: id }; },
    remove: (id: string) => { calls.push(`remove:${id}`); },
  };
  const tools = buildOperatorTools({ tasks: {} as never, scheduledTasks: fakeScheduled as never });

  const got = await tools.get_scheduled_task.handler({ scheduleId: 's9' });
  assert.deepEqual(got, { schedule_id: 's9' });

  const removed = await tools.delete_scheduled_task.handler({ scheduleId: 's9' });
  assert.deepEqual(removed, { success: true });
  assert.deepEqual(calls, ['get:s9', 'remove:s9']);
});

test('move_session_to_project delegates to the injected transfer service', async () => {
  let received: unknown;
  const fakeMove = async (i: unknown) => {
    received = i;
    return { alreadyInTarget: false, sessionId: 's1' };
  };
  const tools = buildOperatorTools({ tasks: {} as never, moveSessionToProject: fakeMove });

  const out = await tools.move_session_to_project.handler({ taskId: 't1', targetProjectPath: '/target' });
  assert.deepEqual(received, { taskId: 't1', targetProjectPath: '/target' });
  assert.deepEqual(out, { alreadyInTarget: false, sessionId: 's1' });
});

test('move_session_to_project fails clearly when the transfer service is not wired', async () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  await assert.rejects(
    () => tools.move_session_to_project.handler({ sessionId: 's1', targetProjectId: 'p1' }),
    /not wired/,
  );
});

test('move_session_to_project input schema declares task/session/target fields as strings', () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  const props = tools.move_session_to_project.inputSchema.properties as Record<string, { type?: string }>;
  for (const key of ['taskId', 'sessionId', 'targetProjectPath', 'targetProjectId']) {
    assert.equal(props[key]?.type, 'string', `${key} must be declared as a string property`);
  }
});

test('delete_task handler delegates to tasks.deleteTask', async () => {
  let received: string | undefined;
  const fakeTasks = {
    deleteTask: async (id: string) => {
      received = id;
      return { taskId: id, deletedSessionId: null };
    },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  const out = await tools.delete_task.handler({ taskId: 't1' });
  assert.equal(received, 't1');
  assert.deepEqual(out, { taskId: 't1', deletedSessionId: null });
});

test('delete_task input schema requires taskId', () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  assert.deepEqual(tools.delete_task.inputSchema.required, ['taskId']);
});

test('delete_session handler delegates to the injected delete service with cascade defaulting to false', async () => {
  const calls: Array<{ sessionId: string; cascade?: boolean }> = [];
  const tools = buildOperatorTools({
    tasks: {} as never,
    deleteSession: async (i: { sessionId: string; cascade?: boolean }) => {
      calls.push(i);
      return { sessionId: i.sessionId, action: 'deleted' };
    },
  });

  await tools.delete_session.handler({ sessionId: 's1' });
  assert.deepEqual(calls[0], { sessionId: 's1', cascade: false });

  await tools.delete_session.handler({ sessionId: 's2', cascade: true });
  assert.deepEqual(calls[1], { sessionId: 's2', cascade: true });
});

test('delete_session fails clearly when the delete service is not wired', async () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  await assert.rejects(() => tools.delete_session.handler({ sessionId: 's1' }), /not wired/);
});

test('delete_session input schema declares sessionId (string) + cascade (boolean)', () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  const props = tools.delete_session.inputSchema.properties as Record<string, { type?: string }>;
  assert.equal(props.sessionId?.type, 'string');
  assert.equal(props.cascade?.type, 'boolean');
  assert.deepEqual(tools.delete_session.inputSchema.required, ['sessionId']);
});

test('list_notifications forwards unreadOnly + clamps limit, and reports unreadCount', async () => {
  let received: { limit?: number; offset?: number; unreadOnly?: boolean } = {};
  const tools = buildOperatorTools({
    tasks: {} as never,
    notifications: {
      list: (o: { limit: number; offset: number; unreadOnly?: boolean }) => {
        received = o;
        return [{ notification_id: 'n1', title: 'A' }];
      },
      unreadCount: () => 3,
      markRead: () => null,
      markAllRead: () => {},
      emit: () => null,
    },
  });

  const res = (await tools.list_notifications.handler({ unreadOnly: 1 })) as {
    unreadCount: number;
    notifications: unknown[];
  };
  assert.equal(received.unreadOnly, true);
  assert.equal(received.limit, 20); // default
  assert.equal(res.unreadCount, 3);
  assert.equal(res.notifications.length, 1);

  // limit is clamped to the 1..100 window
  await tools.list_notifications.handler({ limit: 9999 });
  assert.equal(received.limit, 100);
  await tools.list_notifications.handler({ limit: 0 });
  assert.equal(received.limit, 1);

  // omitted unreadOnly → not filtered
  await tools.list_notifications.handler({});
  assert.equal(received.unreadOnly, false);
});

test('list_notifications fails clearly when the notification service is not wired', async () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  await assert.rejects(() => tools.list_notifications.handler({}), /not wired/);
});

test('mark_notification_read marks a single notification by id', async () => {
  let marked: string | null = null;
  const tools = buildOperatorTools({
    tasks: {} as never,
    notifications: {
      list: () => [],
      unreadCount: () => 1,
      markRead: (id: string) => {
        marked = id;
        return { notification_id: id, read_at: 'now' };
      },
      markAllRead: () => {},
      emit: () => null,
    },
  });

  const res = (await tools.mark_notification_read.handler({ notificationId: 'n1' })) as {
    success: boolean;
    unreadCount: number;
  };
  assert.equal(marked, 'n1');
  assert.equal(res.success, true);
  assert.equal(res.unreadCount, 1);
});

test('mark_notification_read all=1 marks every unread notification', async () => {
  let allCalled = false;
  const tools = buildOperatorTools({
    tasks: {} as never,
    notifications: {
      list: () => [],
      unreadCount: () => 0,
      markRead: () => null,
      markAllRead: () => {
        allCalled = true;
      },
      emit: () => null,
    },
  });

  const res = (await tools.mark_notification_read.handler({ all: 1 })) as { unreadCount: number };
  assert.equal(allCalled, true);
  assert.equal(res.unreadCount, 0);
});

test('mark_notification_read rejects unknown id and missing args', async () => {
  const tools = buildOperatorTools({
    tasks: {} as never,
    notifications: {
      list: () => [],
      unreadCount: () => 0,
      markRead: () => null, // simulates "not found"
      markAllRead: () => {},
      emit: () => null,
    },
  });

  await assert.rejects(() => tools.mark_notification_read.handler({}), /notificationId is required/);
  await assert.rejects(() => tools.mark_notification_read.handler({ notificationId: 'nope' }), /not found/);
});

test('send_notification 转发到 emit 并带上会话 id', async () => {
  const emitted: Array<Record<string, unknown>> = [];
  const tools = buildOperatorTools({
    tasks: {} as never,
    contextSessionId: 'sess-1',
    notifications: {
      list: () => [],
      unreadCount: () => 0,
      markRead: () => null,
      markAllRead: () => {},
      emit: (i: Record<string, unknown>) => { emitted.push(i); return { notification_id: 'n1' }; },
    },
  });

  const res = (await tools.send_notification.handler({
    severity: 'warning', title: '磁盘满', body: '97%', code: 'disk_full',
  })) as { success: boolean };

  assert.equal(res.success, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].severity, 'warning');
  assert.equal(emitted[0].title, '磁盘满');
  assert.equal(emitted[0].body, '97%');
  assert.equal(emitted[0].code, 'disk_full');
  assert.equal(emitted[0].sessionId, 'sess-1');
});

test('send_notification 拒绝非法 severity 与空 title', async () => {
  const tools = buildOperatorTools({
    tasks: {} as never,
    notifications: {
      list: () => [], unreadCount: () => 0, markRead: () => null, markAllRead: () => {},
      emit: () => ({ notification_id: 'n1' }),
    },
  });

  await assert.rejects(() => tools.send_notification.handler({ severity: 'fatal', title: 'x' }), /invalid severity/);
  await assert.rejects(() => tools.send_notification.handler({ severity: 'info', title: '   ' }), /title is required/);
});

test('send_notification 未接线时报错', async () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  await assert.rejects(() => tools.send_notification.handler({ severity: 'info', title: 'x' }), /not wired/);
});

test('send_notification schema 要求 severity + title', () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  assert.deepEqual(tools.send_notification.inputSchema.required, ['severity', 'title']);
});

test('list_sessions handler delegates to the injected list service', async () => {
  let received: unknown;
  const tools = buildOperatorTools({
    tasks: {} as never,
    listSessions: async (i: unknown) => {
      received = i;
      return { total: 0, sessions: [] };
    },
  });
  const out = await tools.list_sessions.handler({ projectPath: '/p', limit: 10 });
  assert.deepEqual(received, { projectPath: '/p', limit: 10 });
  assert.deepEqual(out, { total: 0, sessions: [] });
});

test('list_sessions fails clearly when the list service is not wired', async () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  await assert.rejects(() => tools.list_sessions.handler({}), /not wired/);
});

test('list_sessions input schema declares filter + pagination fields', () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  const props = tools.list_sessions.inputSchema.properties as Record<string, { type?: string }>;
  assert.equal(props.projectPath?.type, 'string');
  assert.equal(props.limit?.type, 'number');
  assert.equal(props.offset?.type, 'number');
  assert.equal(props.includeDeleted?.type, 'boolean');
});
