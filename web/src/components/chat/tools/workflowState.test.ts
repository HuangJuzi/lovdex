import assert from 'node:assert/strict';
import test from 'node:test';

import { applyWorkflowEvent, resolveWorkflowRoot, seedWorkflowStateFromHistory, type WorkflowState } from './workflowState';

test('task_started creates a root entry with running status', () => {
  const state = applyWorkflowEvent(undefined, {
    kind: 'task_started',
    taskId: 'T1',
    toolUseId: 'TU_root',
    taskType: 'local_workflow',
    workflowName: 'spec',
    description: 'spec',
  });
  assert(state);
  assert.equal(state.status, 'running');
  assert.equal(state.workflowName, 'spec');
  assert.equal(state.agents.length, 0);
});

test('task_progress adds an agent node', () => {
  let state: WorkflowState | undefined;
  state = applyWorkflowEvent(state, { kind: 'task_started', taskId: 'T1', toolUseId: 'TU_root', taskType: 'local_workflow', workflowName: 'spec', description: 'spec' });
  state = applyWorkflowEvent(state, { kind: 'task_progress', taskId: 'T1', toolUseId: 'TU_root', description: 'agent:Explore', lastToolName: 'Grep', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 } });
  assert(state);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].taskId, 'T1');
  assert.equal(state.agents[0].lastToolName, 'Grep');
  assert.equal(state.agents[0].tools.length, 0);
});

test('task_progress with same taskId merges (updates lastToolName)', () => {
  let state: WorkflowState | undefined;
  state = applyWorkflowEvent(state, { kind: 'task_started', taskId: 'T1', toolUseId: 'TU_root', taskType: 'local_workflow', workflowName: 'spec', description: 'spec' });
  state = applyWorkflowEvent(state, { kind: 'task_progress', taskId: 'T1', toolUseId: 'TU_root', description: 'a', lastToolName: 'Grep', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
  state = applyWorkflowEvent(state, { kind: 'task_progress', taskId: 'T1', toolUseId: 'TU_root', description: 'b', lastToolName: 'Read', usage: { total_tokens: 2, tool_uses: 2, duration_ms: 2 } });
  assert(state);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].lastToolName, 'Read');
});

test('tool_progress attaches a leaf under the agent with matching taskId', () => {
  let state: WorkflowState | undefined;
  state = applyWorkflowEvent(state, { kind: 'task_started', taskId: 'T1', toolUseId: 'TU_root', taskType: 'local_workflow', workflowName: 'spec', description: 'spec' });
  state = applyWorkflowEvent(state, { kind: 'task_progress', taskId: 'T1', toolUseId: 'TU_root', description: 'a', lastToolName: 'Grep', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
  state = applyWorkflowEvent(state, { kind: 'tool_progress', toolUseId: 'TU_leaf', toolName: 'Read', parentToolUseId: 'TU_agent', taskId: 'T1', elapsedTimeSeconds: 0.5 });
  assert(state);
  assert.equal(state.agents[0].tools.length, 1);
  assert.equal(state.agents[0].tools[0].toolName, 'Read');
  assert.equal(state.agents[0].tools[0].toolUseId, 'TU_leaf');
});

test('task_notification sets terminal status + notification', () => {
  let state: WorkflowState | undefined;
  state = applyWorkflowEvent(state, { kind: 'task_started', taskId: 'T1', toolUseId: 'TU_root', taskType: 'local_workflow', workflowName: 'spec', description: 'spec' });
  state = applyWorkflowEvent(state, { kind: 'task_notification', taskId: 'T1', toolUseId: 'TU_root', status: 'completed', summary: 'ok', usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 } });
  assert(state);
  assert.equal(state.status, 'completed');
  assert.equal(state.notification?.summary, 'ok');
});

test('background_tasks_changed is ignored by applyWorkflowEvent (handled separately)', () => {
  const state = applyWorkflowEvent(undefined, { kind: 'background_tasks_changed', tasks: [] });
  assert.equal(state, undefined);
});

test('events for unknown taskId (no task_started) are ignored', () => {
  const state = applyWorkflowEvent(undefined, { kind: 'task_progress', taskId: 'T9', toolUseId: 'TU', description: 'x', lastToolName: undefined, usage: undefined });
  assert.equal(state, undefined);
});

test('applyWorkflowEvent returns a NEW reference on task_progress', () => {
  let state: WorkflowState | undefined;
  state = applyWorkflowEvent(state, { kind: 'task_started', taskId: 'T1', toolUseId: 'TU_root', taskType: 'local_workflow', workflowName: 'spec', description: 'spec' });
  const state1 = state;
  state = applyWorkflowEvent(state, { kind: 'task_progress', taskId: 'T1', toolUseId: 'TU_root', description: 'a', lastToolName: 'Grep', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
  assert.notEqual(state, state1);
});

test('tool_progress without taskId falls back to parentToolUseId match', () => {
  let state: WorkflowState | undefined;
  state = applyWorkflowEvent(state, { kind: 'task_started', taskId: 'T1', toolUseId: 'TU_root', taskType: 'local_workflow', workflowName: 'spec', description: 'spec' });
  state = applyWorkflowEvent(state, { kind: 'task_progress', taskId: 'T1', toolUseId: 'TU_agent', description: 'a', lastToolName: 'Grep', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
  state = applyWorkflowEvent(state, { kind: 'tool_progress', toolUseId: 'TU_leaf', toolName: 'Read', parentToolUseId: 'TU_agent', elapsedTimeSeconds: 0.5 });
  assert(state);
  assert.equal(state.agents[0].tools.length, 1);
  assert.equal(state.agents[0].tools[0].toolName, 'Read');
});

test('resolveWorkflowRoot: task_started returns its own toolUseId', () => {
  const root = resolveWorkflowRoot({}, null, { kind: 'task_started', taskId: 'T1', toolUseId: 'TU_root', taskType: 'local_workflow', workflowName: 'spec', description: 'spec' });
  assert.equal(root, 'TU_root');
});

test('resolveWorkflowRoot: task_progress routes via taskId → root map', () => {
  const root = resolveWorkflowRoot({ T1: 'TU_root' }, 'TU_leaf', { kind: 'task_progress', taskId: 'T1', toolUseId: 'TU_leaf', description: 'a' });
  assert.equal(root, 'TU_root');
});

test('resolveWorkflowRoot: tool_progress routes via taskId → root map', () => {
  const root = resolveWorkflowRoot({ T1: 'TU_root' }, 'TU_leaf', { kind: 'tool_progress', toolUseId: 'TU_leaf', toolName: 'Read', taskId: 'T1', elapsedTimeSeconds: 0.5 });
  assert.equal(root, 'TU_root');
});

test('resolveWorkflowRoot: tool_progress without taskId falls back to event toolUseId', () => {
  const root = resolveWorkflowRoot({ T1: 'TU_root' }, 'TU_leaf', { kind: 'tool_progress', toolUseId: 'TU_leaf', toolName: 'Read', elapsedTimeSeconds: 0.5 });
  assert.equal(root, 'TU_leaf');
});

test('resolveWorkflowRoot: unknown taskId with no fallback returns undefined', () => {
  const root = resolveWorkflowRoot({ T1: 'TU_root' }, null, { kind: 'task_progress', taskId: 'T9', toolUseId: null, description: 'x' });
  assert.equal(root, undefined);
});

test('resolveWorkflowRoot: background_tasks_changed is not routable', () => {
  const root = resolveWorkflowRoot({}, null, { kind: 'background_tasks_changed', tasks: [] });
  assert.equal(root, undefined);
});

test('seedWorkflowStateFromHistory seeds a Workflow tool_use into an empty map', () => {
  const ws: WorkflowState = {
    status: 'completed',
    workflowName: 'spec',
    agents: [],
    notification: { status: 'completed', summary: 'ok' },
  };
  const result = seedWorkflowStateFromHistory({}, [
    { kind: 'tool_use', toolName: 'Workflow', toolId: 'TU_1', workflowState: ws },
  ]);
  assert.deepEqual(result, { TU_1: ws });
});

test('seedWorkflowStateFromHistory does NOT overwrite a live tree with a terminal notification', () => {
  const live: WorkflowState = {
    status: 'completed',
    agents: [{ taskId: 'T1', description: 'agent:Explore', tools: [] }],
    notification: { status: 'completed', summary: 'live summary', usage: { total_tokens: 5, tool_uses: 1, duration_ms: 50 } },
  };
  const history: WorkflowState = {
    status: 'completed',
    agents: [],
    notification: { status: 'completed', summary: 'history summary' },
  };
  const prev = { TU_1: live };
  const result = seedWorkflowStateFromHistory(prev, [
    { kind: 'tool_use', toolName: 'Workflow', toolId: 'TU_1', workflowState: history },
  ]);
  // Same reference returned when nothing changes; the live (fresher) tree is kept.
  assert.equal(result, prev);
  assert.equal(result.TU_1, live);
});

test('seedWorkflowStateFromHistory ignores non-Workflow / missing-workflowState messages', () => {
  const ws: WorkflowState = {
    status: 'completed',
    agents: [],
    notification: { status: 'completed', summary: 'x' },
  };
  const result = seedWorkflowStateFromHistory({}, [
    { kind: 'tool_use', toolName: 'Bash', toolId: 'TU_1', workflowState: ws },
    { kind: 'tool_use', toolName: 'Workflow', toolId: 'TU_2' },
    { kind: 'tool_use', toolName: 'Workflow', toolId: 'TU_3', workflowState: ws },
    { kind: 'text' },
  ]);
  assert.deepEqual(result, { TU_3: ws });
});
