import assert from 'node:assert/strict';
import test from 'node:test';

import { runTaskContextCompression, scheduleTaskContextCompression } from '../services/task-context.service.js';

const MESSAGES = [
  { role: 'user', content: '修登录页 500' },
  { role: 'assistant', content: '根因是 Nginx 代理超时，已改 upstream。' },
  { role: 'tool', toolName: 'Write', toolResult: 'ok\n'.repeat(400) },
];

test('runTaskContextCompression reads transcript, compresses, writes result', async () => {
  const calls: Array<{ taskId: string; result: { status: string; summary?: string } }> = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: '修登录',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async ({ prompt }) => (prompt.includes('修登录页 500') ? '## 背景\n暂无' : null),
      writeResult: (taskId, result) => calls.push({ taskId, result }),
    },
  });
  assert.deepEqual(calls, [{ taskId: 't1', result: { status: 'ready', summary: '## 背景\n暂无' } }]);
});

test('runTaskContextCompression writes failed when runOneShot returns null', async () => {
  const calls: Array<{ taskId: string; result: { status: string } }> = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => null,
      writeResult: (taskId, result) => calls.push({ taskId, result }),
    },
  });
  assert.deepEqual(calls, [{ taskId: 't1', result: { status: 'failed' } }]);
});

test('runTaskContextCompression swallows transcript read errors via onError and writes failed', async () => {
  const errors: unknown[] = [];
  const results: Array<{ taskId: string; result: { status: string } }> = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => { throw new Error('transcript gone'); },
      runOneShot: async () => { assert.fail('must not run after transcript read failure'); },
      writeResult: (taskId, result) => results.push({ taskId, result }),
    },
    onError: (e) => errors.push(e),
  });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /transcript gone/);
  assert.deepEqual(results, [{ taskId: 't1', result: { status: 'failed' } }]);
});

test('scheduleTaskContextCompression dedupes per in-flight task and swallows errors', async () => {
  let runs = 0;
  const errors: unknown[] = [];
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; throw new Error('boom'); },
      writeResult: () => {},
    },
    onError: (e) => errors.push(e),
  });
  // 第二发在 in-flight 期间应被去重
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; throw new Error('boom'); },
      writeResult: () => {},
    },
    onError: (e) => errors.push(e),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, 1);
  assert.equal(errors.length, 1);
});

test('scheduleTaskContextCompression reruns a taskId after the first run completes', async () => {
  let runs = 0;
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; return null; },
      writeResult: () => {},
    },
  });
  await new Promise((r) => setTimeout(r, 10)); // 第一发完成
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; return null; },
      writeResult: () => {},
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs, 2); // 完成后再调度同一 taskId 应再次执行
});

test('raw mode writes transcript verbatim (no LLM) and never calls runOneShot', async () => {
  let written!: { taskId: string; result: { status: string; raw?: string } };
  let calledRunOneShot = false;
  await runTaskContextCompression({
    sourceSessionId: 's',
    taskId: 't',
    title: 'x',
    mode: 'raw',
    deps: {
      fetchHistory: async () => ({ messages: [{ role: 'user', content: 'hello raw' }] }),
      runOneShot: async () => { calledRunOneShot = true; return 'S'; },
      writeResult: (tid, result) => { written = { taskId: tid, result: result as { status: string; raw?: string } }; },
    },
  });
  assert.equal(calledRunOneShot, false);
  assert.equal(written?.taskId, 't');
  assert.equal(written?.result.status, 'ready');
  assert.ok(written?.result.raw?.includes('hello raw'));
});

test('summary mode success writes status ready + summary', async () => {
  let written!: { taskId: string; result: { status: string; summary?: string } };
  await runTaskContextCompression({
    sourceSessionId: 's',
    taskId: 't',
    title: 'x',
    mode: 'summary',
    deps: {
      fetchHistory: async () => ({ messages: [{ role: 'user', content: 'hello' }] }),
      runOneShot: async () => '压缩结果',
      writeResult: (tid, result) => { written = { taskId: tid, result: result as { status: string; summary?: string } }; },
    },
  });
  assert.equal(written?.taskId, 't');
  assert.equal(written?.result.status, 'ready');
  assert.equal(written?.result.summary, '压缩结果');
});
