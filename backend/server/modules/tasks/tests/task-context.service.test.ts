import assert from 'node:assert/strict';
import test from 'node:test';

import { runTaskContextCompression, compactTranscriptToText, scheduleTaskContextCompression } from '../services/task-context.service.js';

const MESSAGES = [
  { role: 'user', content: '修登录页 500' },
  { role: 'assistant', content: '根因是 Nginx 代理超时，已改 upstream。' },
  { role: 'tool', toolName: 'Write', toolResult: 'ok\n'.repeat(400) },
];

test('compactTranscriptToText keeps user/assistant text and truncates tool results', () => {
  const text = compactTranscriptToText(MESSAGES);
  assert.match(text, /修登录页 500/);
  assert.match(text, /根因是 Nginx 代理超时/);
  assert.ok(text.split('\n').some((line) => line.startsWith('[tool Write]') && line.length <= 320));
});

test('runTaskContextCompression reads transcript, compresses, writes back', async () => {
  const calls: Array<[string, string]> = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: '修登录',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async ({ prompt }) => (prompt.includes('修登录页 500') ? '## 背景\n暂无' : null),
      writeBack: (taskId, summary) => calls.push([taskId, summary]),
    },
  });
  assert.deepEqual(calls, [['t1', '## 背景\n暂无']]);
});

test('runTaskContextCompression does not write back when runOneShot returns null', async () => {
  const calls: Array<[string, string]> = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => null,
      writeBack: (taskId, summary) => calls.push([taskId, summary]),
    },
  });
  assert.deepEqual(calls, []);
});

test('runTaskContextCompression swallows transcript read errors via onError', async () => {
  const errors: unknown[] = [];
  await runTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => { throw new Error('transcript gone'); },
      runOneShot: async () => { assert.fail('must not run after transcript read failure'); },
      writeBack: () => {},
    },
    onError: (e) => errors.push(e),
  });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /transcript gone/);
});

test('scheduleTaskContextCompression dedupes per in-flight task and swallows errors', async () => {
  let runs = 0;
  const errors: unknown[] = [];
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; throw new Error('boom'); },
      writeBack: () => {},
    },
    onError: (e) => errors.push(e),
  });
  // 第二发在 in-flight 期间应被去重
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; throw new Error('boom'); },
      writeBack: () => {},
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
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; return null; },
      writeBack: () => {},
    },
  });
  await new Promise((r) => setTimeout(r, 10)); // 第一发完成
  scheduleTaskContextCompression({
    sourceSessionId: 'src1',
    taskId: 't1',
    title: 'x',
    deps: {
      fetchHistory: async () => ({ messages: MESSAGES }),
      runOneShot: async () => { runs += 1; return null; },
      writeBack: () => {},
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs, 2); // 完成后再调度同一 taskId 应再次执行
});