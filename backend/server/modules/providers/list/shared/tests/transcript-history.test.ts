import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assembleHistoryRecords,
  parseAgentToolsContent,
  parseJsonlRecords,
  readTranscriptDir,
} from '@/modules/providers/list/shared/transcript-history.js';

/**
 * Shared content-based transcript parsing (claude + qoder both consume it for
 * local AND remote history). Behavior mirrors the pre-refactor per-provider
 * `getSessionMessages`/`parseAgentTools` exactly, so the cases here are the
 * contract the refactor and the remote `session/messages` path both rely on.
 */

const oneRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user',
  sessionId: 'sid-1',
  uuid: 'u-1',
  timestamp: '2026-08-20T01:00:00Z',
  message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ...overrides,
});

test('parseJsonlRecords parses lines and skips blank/malformed rows', () => {
  const content = [
    JSON.stringify(oneRecord()),
    '',
    'not-json{',
    JSON.stringify(oneRecord({ uuid: 'u-2' })),
  ].join('\n');

  const records = parseJsonlRecords(content);

  assert.equal(records.length, 2);
  assert.equal(records[1].uuid, 'u-2');
});

test('assembleHistoryRecords filters to the provider session id and sorts by timestamp', () => {
  const transcript = [
    JSON.stringify(oneRecord({ uuid: 'later', timestamp: '2026-08-20T01:00:05Z' })),
    JSON.stringify(oneRecord({ uuid: 'other-sid', sessionId: 'sid-other', timestamp: '2026-08-20T01:00:01Z' })),
    JSON.stringify(oneRecord({ uuid: 'first', timestamp: '2026-08-20T01:00:00Z' })),
  ].join('\n');

  const records = assembleHistoryRecords(transcript, {}, 'sid-1');

  assert.deepEqual(
    records.map((r) => r.uuid),
    ['first', 'later'],
  );
});

test('assembleHistoryRecords attaches subagentTools from agent file content', () => {
  const transcript = [
    JSON.stringify(
      oneRecord({
        type: 'assistant',
        uuid: 'task-msg',
        timestamp: '2026-08-20T01:00:02Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: { prompt: 'go' } }],
        },
        toolUseResult: { agentId: 'agent-xyz' },
      }),
    ),
    JSON.stringify(oneRecord()),
  ].join('\n');

  const agentJsonl = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-20T01:00:03Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-08-20T01:00:04Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents of /a\n' }],
      },
    }),
  ].join('\n');

  const records = assembleHistoryRecords(transcript, { 'agent-xyz': agentJsonl }, 'sid-1');
  const taskMsg = records.find((r) => r.uuid === 'task-msg');

  assert.ok(taskMsg, 'task message present');
  assert.ok(Array.isArray(taskMsg.subagentTools));
  assert.equal(taskMsg.subagentTools[0].toolId, 't1');
  assert.equal(taskMsg.subagentTools[0].toolName, 'Read');
  assert.deepEqual(taskMsg.subagentTools[0].toolInput, { file_path: '/a' });
  assert.deepEqual(taskMsg.subagentTools[0].toolResult, {
    content: 'contents of /a\n',
    isError: false,
  });
});

test('parseAgentToolsContent maps tool_use + tool_result into tool objects', () => {
  const agentJsonl = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-20T01:00:03Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-08-20T01:00:04Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] },
    }),
  ].join('\n');

  const tools = parseAgentToolsContent(agentJsonl);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolId, 't1');
  assert.deepEqual(tools[0].toolResult, { content: 'boom', isError: true });
});

test('readTranscriptDir returns main transcript + agent file contents', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'transcript-dir-'));
  try {
    const mainPath = path.join(dir, 'sid-1.jsonl');
    await writeFile(mainPath, '{"a":1}\n', 'utf8');
    await writeFile(path.join(dir, 'agent-xyz.jsonl'), '{"b":2}\n', 'utf8');
    await writeFile(path.join(dir, 'unrelated.txt'), 'not a transcript', 'utf8');

    const { transcript, agentFiles } = await readTranscriptDir(mainPath, dir);

    assert.equal(transcript, '{"a":1}\n');
    assert.deepEqual(Object.keys(agentFiles), ['xyz']);
    assert.equal(agentFiles.xyz, '{"b":2}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readTranscriptDir tolerates a missing main file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'transcript-dir-'));
  try {
    const { transcript, agentFiles } = await readTranscriptDir(path.join(dir, 'missing.jsonl'), dir);
    assert.equal(transcript, '');
    assert.deepEqual(agentFiles, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});