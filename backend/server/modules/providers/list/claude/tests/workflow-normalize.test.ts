import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SID = 'sess-1';

test('task_started (local_workflow) normalizes with workflowName + toolUseId', () => {
  const raw = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'T1',
    tool_use_id: 'TU_root',
    task_type: 'local_workflow',
    workflow_name: 'spec',
    description: 'running spec',
    uuid: 'u1',
    session_id: SID,
    timestamp: '2026-08-05T00:00:00.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'task_started');
  assert.equal(out[0].taskId, 'T1');
  assert.equal(out[0].toolUseId, 'TU_root');
  assert.equal(out[0].taskType, 'local_workflow');
  assert.equal(out[0].workflowName, 'spec');
  assert.equal(out[0].description, 'running spec');
});

test('task_progress normalizes usage + lastToolName', () => {
  const raw = {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'T1',
    tool_use_id: 'TU_root',
    description: 'agent:Explore scanning',
    last_tool_name: 'Grep',
    usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 5000 },
    summary: '3 files',
    uuid: 'u2',
    session_id: SID,
    timestamp: '2026-08-05T00:00:01.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'task_progress');
  assert.equal(out[0].taskId, 'T1');
  assert.equal(out[0].lastToolName, 'Grep');
  assert.deepEqual(out[0].usage, { total_tokens: 1234, tool_uses: 3, duration_ms: 5000 });
});

test('task_notification normalizes status + summary', () => {
  const raw = {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'T1',
    tool_use_id: 'TU_root',
    status: 'completed',
    summary: 'done',
    usage: { total_tokens: 2000, tool_uses: 5, duration_ms: 9000 },
    output_file: '/tmp/out.json',
    uuid: 'u3',
    session_id: SID,
    timestamp: '2026-08-05T00:00:02.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'task_notification');
  assert.equal(out[0].status, 'completed');
  assert.equal(out[0].summary, 'done');
  assert.equal(out[0].outputFile, '/tmp/out.json');
});

test('background_tasks_changed normalizes tasks[] (REPLACE payload)', () => {
  const raw = {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 'T1', task_type: 'local_workflow', description: 'spec' },
      { task_id: 'T2', task_type: 'local_workflow', description: 'review' },
    ],
    uuid: 'u4',
    session_id: SID,
    timestamp: '2026-08-05T00:00:03.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'background_tasks_changed');
  assert.equal(out[0].tasks?.length, 2);
  assert.equal(out[0].tasks?.[0].taskId, 'T1');
});

test('tool_progress normalizes parent chain + taskId', () => {
  const raw = {
    type: 'tool_progress',
    tool_use_id: 'TU_leaf',
    tool_name: 'Grep',
    parent_tool_use_id: 'TU_agent',
    task_id: 'T1',
    elapsed_time_seconds: 1.5,
    uuid: 'u5',
    session_id: SID,
    timestamp: '2026-08-05T00:00:04.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_progress');
  assert.equal(out[0].toolUseId, 'TU_leaf');
  assert.equal(out[0].toolName, 'Grep');
  assert.equal(out[0].parentToolUseId, 'TU_agent');
  assert.equal(out[0].taskId, 'T1');
  assert.equal(out[0].elapsedTimeSeconds, 1.5);
});

test('unhandled system subtypes (thinking_tokens) return empty', () => {
  const raw = {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 100,
    uuid: 'u6',
    session_id: SID,
    timestamp: '2026-08-05T00:00:05.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 0);
});

test('tool_result with local_workflow toolUseResult lifts runId + scriptPath', () => {
  const raw = {
    type: 'tool_result',
    toolCallId: 'TU_root',
    output: '{"status":"async_launched"}',
    toolUseResult: {
      status: 'async_launched',
      taskId: 'T1',
      taskType: 'local_workflow',
      workflowName: 'spec',
      runId: 'wf_abc',
      scriptPath: '/home/.claude/projects/x/sess-1/workflows/wf.js',
      transcriptDir: '/home/.claude/projects/x/sess-1/subagents',
      summary: 'launched',
    },
    uuid: 'u7',
    session_id: SID,
    timestamp: '2026-08-05T00:00:06.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].runId, 'wf_abc');
  assert.equal(out[0].scriptPath, '/home/.claude/projects/x/sess-1/workflows/wf.js');
  assert.equal(out[0].workflowName, 'spec');
  assert.equal(out[0].taskId, 'T1');
  assert.equal(out[0].summary, 'launched');
});

test('tool_result with remote_agent toolUseResult does NOT lift fields', () => {
  const raw = {
    type: 'tool_result',
    toolCallId: 'TU_root2',
    output: 'launched',
    toolUseResult: { status: 'remote_launched', taskId: 'T9', taskType: 'remote_agent' },
    uuid: 'u8',
    session_id: SID,
    timestamp: '2026-08-05T00:00:07.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].runId, undefined);
  assert.equal(out[0].scriptPath, undefined);
});

test('user-content tool_result with local_workflow toolUseResult lifts fields', () => {
  const raw = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'TU_root', content: 'ok', is_error: false },
      ],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: 'T1',
      taskType: 'local_workflow',
      workflowName: 'spec',
      runId: 'wf_abc',
      scriptPath: '/p/wf.js',
      transcriptDir: '/p/subagents',
      summary: 'launched',
    },
    subagentTools: [],
    uuid: 'u9',
    session_id: SID,
    timestamp: '2026-08-05T00:00:08.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  const tr = out.find((m) => m.kind === 'tool_result');
  assert.ok(tr, 'tool_result present');
  assert.equal(tr.runId, 'wf_abc');
  assert.equal(tr.scriptPath, '/p/wf.js');
  assert.equal(tr.summary, 'launched');
});
