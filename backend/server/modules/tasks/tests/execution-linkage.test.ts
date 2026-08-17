import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { AiVerdict, PersistedSubStatus } from '@/shared/task-status.js';
import type { TaskRow } from '@/shared/types.js';

type Row = TaskRow & { status: TaskRow['status'] };
function makeDb(initial: Row[]) {
  const rows = [...initial];
  return {
    createTask: (_i: unknown) => rows[0] ?? ({} as TaskRow),
    getTask: (id: string) => rows.find(t => t.task_id === id) ?? null,
    getTaskBySessionId: (sid: string) => rows.find(t => t.session_id === sid) ?? null,
    listTasks: (filter: { status?: TaskRow['status'] } = {}) => filter.status ? rows.filter(t => t.status === filter.status) : rows,
    updateTask: (id: string, u: Partial<TaskRow>) => ({ task_id: id, ...u } as TaskRow),
    updateTaskStatus: (id: string, status: TaskRow['status']) => { const t = rows.find(x => x.task_id === id); if (t) t.status = status; },
    updateTaskSubStatus: (id: string, sub: PersistedSubStatus | null) => { const t = rows.find(x => x.task_id === id); if (t) t.sub_status = sub; },
    clearVerdictFields: (id: string) => { const t = rows.find(x => x.task_id === id); if (t) { t.ai_summary = null; t.verdict_reason = null; t.verdict_at = null; } },
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
    writeSummary: (id: string, input: { summary: string; verdict: AiVerdict; reason?: string | null }) => {
      const t = rows.find(x => x.task_id === id);
      if (!t) return null;
      t.ai_summary = input.summary;
      t.sub_status = input.verdict;
      t.verdict_reason = input.reason ?? null;
      return t;
    },
  };
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    task_id: 't1',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'todo',
    sub_status: null,
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id: 's1',
    source_schedule_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ai_summary: null,
    verdict_reason: null,
    verdict_at: null,
    priority: 'P2',
    deadline: null,
    is_operator: 0,
    label: 'other',
    remark: null,
    ...overrides,
  };
}

test('session running advances todo → in_progress', () => {
  const rows = [makeRow({ status: 'todo', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
});

test('session completed advances in_progress → in_review', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_review');
});

test('session failed keeps the task in_progress, persists sub_status=failed, re-emits', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  svc.onSessionStatus('s1', 'failed');
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(rows[0].sub_status, 'failed');
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
});

test('session aborted rolls back in_progress → todo and clears sub_status', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1', sub_status: 'failed' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'aborted');
  assert.equal(rows[0].status, 'todo');
  assert.equal(rows[0].sub_status, null);
});

test('session event for unknown session is a no-op', () => {
  const svc = createTasksService(makeDb([]), { broadcast: () => {} });
  svc.onSessionStatus('nope', 'running');
});

test('running reopens an in_review task to in_progress (resume from review)', () => {
  const rows = [makeRow({ status: 'in_review', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
});

test('running reopens a done task to in_progress (agent works again)', () => {
  const rows = [makeRow({ status: 'done', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'running');
  // A done task the user reopened still goes back to in_progress; the follow-up
  // completion just must not re-run the AI verdict (covered in the status tests).
  assert.equal(rows[0].status, 'in_progress');
});

test('running on an already in_progress task re-emits to refresh realtime flags', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
});

test('in_review resume loop: running → in_progress → completed → in_review', () => {
  const rows = [makeRow({ status: 'in_review', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_review');
});

test('running broadcast carries actor engine', () => {
  const rows = [makeRow({ status: 'todo', session_id: 's1' })];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  svc.onSessionStatus('s1', 'running');
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
  assert.equal((events[0] as { actor: string }).actor, 'engine');
});

test('failed then running: persisted failed sub_status clears on the fresh run', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'failed');
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(rows[0].sub_status, 'failed');
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(rows[0].sub_status, null);
});

test('startExecution links a session without moving a todo task', () => {
  const rows = [makeRow({ status: 'todo', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  const result = svc.startExecution('t1', (provider, projectPath) => `session-${provider}-${projectPath}`);
  assert.deepEqual(result, { sessionId: 'session-claude-/p' });
  // No auto-advance: the running session event drives todo → in_progress.
  assert.equal(rows[0].status, 'todo');
});

test('startExecution todo then running advances to in_progress (full flow)', () => {
  const rows = [makeRow({ status: 'todo', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.startExecution('t1', () => 'session-claude-/p');
  assert.equal(rows[0].status, 'todo');
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
});

test('startExecution leaves an already in_progress task untouched', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.startExecution('t1', () => 'session-claude-/p');
  assert.equal(rows[0].status, 'in_progress');
});

test('onSessionApproval broadcasts approval marker without changing status', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  svc.onSessionApproval('s1', true);
  assert.equal(rows[0].status, 'in_progress');
  assert.equal((events[0] as { approval?: { pending: boolean } }).approval?.pending, true);
  assert.equal((events[0] as { actor: string }).actor, 'engine');
  svc.onSessionApproval('s1', false);
  assert.equal((events[1] as { approval?: { pending: boolean } }).approval?.pending, false);
});

test('listTasks decorates approval_pending from the injected pending-sessions map', () => {
  const rows = [
    makeRow({ task_id: 't1', status: 'in_progress', session_id: 's1' }),
    makeRow({ task_id: 't2', status: 'in_progress', session_id: 's2' }),
    makeRow({ task_id: 't3', status: 'todo', session_id: null }),
  ];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
  });
  const list = svc.listTasks();
  const byId = Object.fromEntries(list.map((t) => [t.task_id, t]));
  assert.equal(byId.t1.approval_pending, true);
  assert.equal(byId.t2.approval_pending, false);
  assert.equal(byId.t3.approval_pending, false);
});

test('getTask decorates approval_pending so the detail page reconstructs the marker', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
  });
  assert.equal(svc.getTask('t1')?.approval_pending, true);
});

test('onSessionApproval stamps approval_pending on the broadcast task row', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), {
    broadcast: (e) => events.push(e),
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
  });
  svc.onSessionApproval('s1', true);
  assert.equal((events[0] as { task: { approval_pending?: boolean } }).task.approval_pending, true);
});

test('approval_pending defaults to false when no pending-sessions source is wired', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  assert.equal(svc.getTask('t1')?.approval_pending, false);
});

// ---------------------------------------------------------------------------
// Verdict trigger must align with task lifecycle: a run that ends while the
// session is paused on an interactive tool (AskUserQuestion / ExitPlanMode) is
// a PAUSE waiting for a human decision, not a completion. Moving the task to
// in_review and firing the auto-verdict hook on the intermediate "plan ready,
// how to proceed?" text is what mislabels in-progress work as failed/only_plan.
// ---------------------------------------------------------------------------

test('completed with a pending AskUserQuestion does NOT move to in_review and does NOT fire onTaskCompleted', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  let completedCalls = 0;
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
    onTaskCompleted: () => { completedCalls++; },
  });
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_progress', 'task stays in_progress (paused, not done)');
  assert.equal(rows[0].sub_status, 'waiting_answer', 'persists waiting_answer so a stopped session is not shown as 进行中');
  assert.equal(completedCalls, 0, 'auto-verdict hook must not fire at a user-decision gate');
});

test('completed with a pending ExitPlanMode does NOT move to in_review and does NOT fire onTaskCompleted', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  let completedCalls = 0;
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'ExitPlanMode']]),
    onTaskCompleted: () => { completedCalls++; },
  });
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(rows[0].sub_status, 'waiting_plan');
  assert.equal(completedCalls, 0);
});

test('decorate surfaces persisted waiting_answer for an in_progress task whose run has ended (no live pending approval)', () => {
  // After the run ends at an AskUserQuestion the in-memory pending-approval map
  // is cleared; the board must still show "等你回答" from the persisted tag, not
  // "进行中".
  const rows = [makeRow({ status: 'in_progress', session_id: 's1', sub_status: 'waiting_answer' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map(),
  });
  assert.equal(svc.getTask('t1')?.sub_status, 'waiting_answer');
});

test('reconcileFailedTasks skips a task paused waiting for a human decision (not an orphan)', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1', sub_status: 'waiting_answer' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  const changed = svc.reconcileFailedTasks(() => new Set());
  assert.equal(changed, 0, 'a task waiting for a human answer is not a crashed/orphaned run');
  assert.equal(rows[0].sub_status, 'waiting_answer');
});

test('completed with no pending approval still moves to in_review and fires onTaskCompleted (regression)', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  let completedCalls = 0;
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map(),
    onTaskCompleted: () => { completedCalls++; },
  });
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_review');
  assert.equal(completedCalls, 1);
});

test('completed with a pending non-interactive tool approval still triggers verdict (only interactive gates)', () => {
  // A pending Bash approval at complete-time is not the AskUserQuestion pause
  // case; only interactive tools (AskUserQuestion/ExitPlanMode) gate the verdict.
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  let completedCalls = 0;
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'Bash']]),
    onTaskCompleted: () => { completedCalls++; },
  });
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_review');
  assert.equal(completedCalls, 1);
});

test('decorate derives waiting_answer for an in_progress task pending AskUserQuestion', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
  });
  assert.equal(svc.getTask('t1')?.sub_status, 'waiting_answer');
});

test('decorate derives waiting_plan for an in_progress task pending ExitPlanMode', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'ExitPlanMode']]),
  });
  assert.equal(svc.getTask('t1')?.sub_status, 'waiting_plan');
});

test('decorate surfaces a persisted failed tag on an in_progress task', () => {
  const rows = [makeRow({ task_id: 't1', status: 'in_progress', session_id: 's1', sub_status: 'failed' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  const list = svc.listTasks();
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(list[0]?.sub_status, 'failed');
});

test('decorate derives running for an in_progress task with no persisted tag', () => {
  const rows = [makeRow({ task_id: 't1', status: 'in_progress', session_id: 's1', sub_status: null })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  const list = svc.listTasks();
  assert.equal(list[0]?.sub_status, 'running');
});

test('decorate derives pending_acceptance for an in_review task awaiting the verdict', () => {
  const rows = [makeRow({ task_id: 't1', status: 'in_review', session_id: 's1', sub_status: null })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  const list = svc.listTasks();
  assert.equal(list[0]?.sub_status, 'pending_acceptance');
});
