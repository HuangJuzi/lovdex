import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import {
  aggregateWorkflowState,
  ClaudeSessionsProvider,
} from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SID = 'sess-1';

// A single Workflow run captured in one JSONL stream: the Workflow tool_use,
// the SDK task_started/task_progress/task_notification system events, a
// tool_progress leaf, and the WorkflowOutput tool_result.
const WORKFLOW_RECORDS: Array<Record<string, unknown>> = [
  {
    type: 'tool_use', toolName: 'Workflow', toolInput: { script: 'x' }, toolCallId: 'TU_root',
    sessionId: SID, uuid: 'a1', timestamp: '2026-08-05T00:00:00.000Z',
  },
  {
    type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'TU_root',
    task_type: 'local_workflow', workflow_name: 'spec', description: 'spec',
    sessionId: SID, uuid: 'a2', timestamp: '2026-08-05T00:00:01.000Z',
  },
  {
    type: 'system', subtype: 'task_progress', task_id: 'T1', tool_use_id: 'TU_root',
    description: 'agent:Explore', last_tool_name: 'Grep',
    usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
    sessionId: SID, uuid: 'a3', timestamp: '2026-08-05T00:00:02.000Z',
  },
  {
    type: 'tool_progress', tool_use_id: 'TU_leaf', tool_name: 'Read',
    parent_tool_use_id: 'TU_agent', task_id: 'T1', elapsed_time_seconds: 0.5,
    sessionId: SID, uuid: 'a4', timestamp: '2026-08-05T00:00:03.000Z',
  },
  {
    type: 'system', subtype: 'task_notification', task_id: 'T1', tool_use_id: 'TU_root',
    status: 'completed', summary: 'ok',
    usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 },
    sessionId: SID, uuid: 'a5', timestamp: '2026-08-05T00:00:04.000Z',
  },
  {
    type: 'tool_result', toolCallId: 'TU_root', output: '',
    toolUseResult: {
      status: 'async_launched', taskId: 'T1', taskType: 'local_workflow',
      runId: 'wf_x', scriptPath: '/p/wf.js',
    },
    sessionId: SID, uuid: 'a6', timestamp: '2026-08-05T00:00:05.000Z',
  },
];

// ── Contract test: the aggregation shape ────────────────────────────────
// Exercises the production aggregateWorkflowState (the exact function
// fetchHistory calls) directly, independent of the DB-backed reader.
test('workflow events aggregate into a workflowState on the Workflow tool_use', () => {
  const normalized = WORKFLOW_RECORDS.flatMap((r) => provider.normalizeMessage(r, SID));
  assert.ok(
    normalized.some((m) => m.kind === 'task_started' && m.toolUseId === 'TU_root'),
    'normalizeMessage produces task_started from system records',
  );

  const aggregated = aggregateWorkflowState(normalized);

  const wf = aggregated.find((m) => m.kind === 'tool_use' && m.toolName === 'Workflow');
  assert.ok(wf, 'Workflow tool_use present');
  assert.ok(wf.workflowState, 'workflowState attached');
  assert.equal(wf.workflowState.status, 'completed');
  assert.equal(wf.workflowState.workflowName, 'spec');
  assert.equal(wf.workflowState.agents.length, 1);
  assert.equal(wf.workflowState.agents[0].taskId, 'T1');
  assert.equal(wf.workflowState.agents[0].lastToolName, 'Grep');
  assert.equal(wf.workflowState.agents[0].tools.length, 1);
  assert.equal(wf.workflowState.agents[0].tools[0].toolName, 'Read');
  assert.equal(wf.workflowState.notification?.summary, 'ok');
  // WorkflowOutput fields hoisted from the matching tool_result so the
  // tool_use message is a self-contained card (re-run/resume buttons).
  assert.equal(wf.runId, 'wf_x');
  assert.equal(wf.scriptPath, '/p/wf.js');
});

// ── Real fetchHistory integration: temp JSONL + isolated DB ─────────────
async function withIsolatedDatabase(
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'wf-history-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('fetchHistory aggregates workflowState onto the Workflow tool_use (real JSONL)', async () => {
  await withIsolatedDatabase(async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'wf-history-jsonl-'));
    const projectDir = path.join(tempDirectory, 'projects', 'encoded-cwd');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'sess-1.jsonl');
    await writeFile(jsonlPath, WORKFLOW_RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    try {
      // provider_session_id and session_id are both 'sess-1' for a provider-native
      // session, so getSessionById('sess-1') resolves the row whose jsonl_path
      // the reader opens.
      sessionsDb.createSession(SID, 'claude', tempDirectory, undefined, undefined, undefined, jsonlPath);

      const result = await provider.fetchHistory(SID, { limit: null, offset: 0 });

      const wf = result.messages.find((m) => m.kind === 'tool_use' && m.toolName === 'Workflow');
      assert.ok(wf, 'fetchHistory returns the Workflow tool_use');
      assert.ok(wf.workflowState, 'fetchHistory attaches workflowState to the Workflow tool_use');
      assert.equal(wf.workflowState.status, 'completed');
      assert.equal(wf.workflowState.workflowName, 'spec');
      assert.equal(wf.workflowState.agents.length, 1);
      assert.equal(wf.workflowState.agents[0].taskId, 'T1');
      assert.equal(wf.workflowState.agents[0].lastToolName, 'Grep');
      assert.equal(wf.workflowState.agents[0].tools.length, 1);
      assert.equal(wf.workflowState.agents[0].tools[0].toolName, 'Read');
      assert.equal(wf.workflowState.notification?.summary, 'ok');
      assert.equal(wf.runId, 'wf_x');
      assert.equal(wf.scriptPath, '/p/wf.js');
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
