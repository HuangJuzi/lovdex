import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOpencodeRow } from '../services/token-usage-parsers.js';

/** 真实样本：tokens 满足 19112 + 16 + 1920 = 21048 = total，即 input 不含缓存。 */
const ASSISTANT_ROW = {
  id: 'msg_ff2651f19001UJ79vfB4y7APEB',
  session_id: 'ses_00d9ae2c2ffeLYG8SPbcdWnxvS',
  data: JSON.stringify({
    parentID: 'msg_ff2651d8b001hNncbCOtBf929k',
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/mnt/b/workdir/gitlab/moltbot', root: '/mnt/b/workdir/gitlab/moltbot' },
    cost: 0,
    tokens: {
      total: 21048, input: 19112, output: 16, reasoning: 0,
      cache: { write: 0, read: 1920 },
    },
    modelID: 'DeepSeek-V4-Flash-0731',
    providerID: 'sophnet',
    time: { created: 1786478141209, completed: 1786478147716 },
    finish: 'stop',
  }),
};

test('assistant 行映射成四列，reasoning 不重复计入 output', () => {
  const event = parseOpencodeRow(ASSISTANT_ROW, null);
  assert.ok(event);
  assert.equal(event.source, 'opencode');
  assert.equal(event.sessionId, 'ses_00d9ae2c2ffeLYG8SPbcdWnxvS');
  assert.equal(event.projectPath, '/mnt/b/workdir/gitlab/moltbot');
  assert.equal(event.model, 'DeepSeek-V4-Flash-0731');
  assert.equal(event.tsMs, 1786478141209);
  assert.equal(event.inputTokens, 19112);
  assert.equal(event.outputTokens, 16);
  assert.equal(event.cacheReadTokens, 1920);
  assert.equal(event.cacheCreationTokens, 0);
  assert.equal(event.dedupeKey, 'opencode:msg_ff2651f19001UJ79vfB4y7APEB');
});

test('cache.write 落在 cacheCreationTokens', () => {
  const event = parseOpencodeRow(
    {
      ...ASSISTANT_ROW,
      data: JSON.stringify({
        role: 'assistant',
        tokens: { input: 5, output: 1, cache: { write: 77, read: 0 } },
        modelID: 'm',
        time: { created: 1786478141209 },
      }),
    },
    null,
  );
  assert.ok(event);
  assert.equal(event.cacheCreationTokens, 77);
  assert.equal(event.cacheReadTokens, 0);
});

test('user 行 / 无 tokens / 坏 JSON / 无时间戳 都返回 null', () => {
  assert.equal(parseOpencodeRow({ ...ASSISTANT_ROW, data: JSON.stringify({ role: 'user' }) }, null), null);
  assert.equal(parseOpencodeRow({ ...ASSISTANT_ROW, data: JSON.stringify({ role: 'assistant' }) }, null), null);
  assert.equal(parseOpencodeRow({ ...ASSISTANT_ROW, data: '{oops' }, null), null);
  assert.equal(
    parseOpencodeRow(
      { ...ASSISTANT_ROW, data: JSON.stringify({ role: 'assistant', tokens: { input: 1 } }) },
      null,
    ),
    null,
  );
});

test('缺 path.cwd 时回落到 session.directory，缺 modelID 时标 unknown', () => {
  const event = parseOpencodeRow(
    {
      ...ASSISTANT_ROW,
      data: JSON.stringify({
        role: 'assistant', tokens: { input: 1, output: 1 }, time: { created: 1786478141209 },
      }),
    },
    '/fallback/dir',
  );
  assert.ok(event);
  assert.equal(event.projectPath, '/fallback/dir');
  assert.equal(event.model, 'unknown');
});
