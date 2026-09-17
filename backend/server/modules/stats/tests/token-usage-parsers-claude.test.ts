import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeLine, readUsageNumber } from '../services/token-usage-parsers.js';

/** 形状 A：仅 input/output（第三方模型经 llm-proxy 转发时的形状）。 */
const SHAPE_A = JSON.stringify({
  type: 'assistant',
  cwd: '/mnt/b/workdir/github/lovdex',
  sessionId: '631e2b8a-240d-4dfe-bcf3-91a577a1a1ea',
  timestamp: '2026-08-18T11:05:29.539Z',
  isSidechain: false,
  message: {
    id: 'msg_01f86402-aaf5-436f-ab18-fb6c65d3b2b3',
    model: 'DeepSeek-V4-Flash-0731',
    usage: { output_tokens: 0, input_tokens: 53478 },
  },
});

/** 形状 B：含 cache_read，无 cache_creation。 */
const SHAPE_B = JSON.stringify({
  type: 'assistant',
  cwd: '/mnt/b/workdir/github/lovdex',
  sessionId: 'sess-b',
  timestamp: '2026-08-18T12:00:00.000Z',
  message: {
    id: 'msg_b',
    model: 'claude-opus-4-8',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
  },
});

/** 形状 C：全套字段（官方 API 形状）。 */
const SHAPE_C = JSON.stringify({
  type: 'assistant',
  cwd: '/mnt/b/workdir/github/lovdex',
  sessionId: 'sess-c',
  timestamp: '2026-08-18T13:00:00.000Z',
  message: {
    id: 'msg_c',
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 10, output_tokens: 2,
      cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
      service_tier: 'standard', inference_geo: 'not_available', iterations: [],
    },
  },
});

test('readUsageNumber 把缺失/负数/字符串/NaN 一律收敛成非负整数', () => {
  assert.equal(readUsageNumber(undefined), 0);
  assert.equal(readUsageNumber(null), 0);
  assert.equal(readUsageNumber(-5), 0);
  assert.equal(readUsageNumber('42'), 42);
  assert.equal(readUsageNumber('abc'), 0);
  assert.equal(readUsageNumber(Number.NaN), 0);
  assert.equal(readUsageNumber(7.9), 7);
});

test('形状 A：input 不含缓存，四列分别落位', () => {
  const event = parseClaudeLine(JSON.parse(SHAPE_A));
  assert.ok(event);
  assert.equal(event.source, 'claude');
  assert.equal(event.model, 'DeepSeek-V4-Flash-0731');
  assert.equal(event.sessionId, '631e2b8a-240d-4dfe-bcf3-91a577a1a1ea');
  assert.equal(event.projectPath, '/mnt/b/workdir/github/lovdex');
  assert.equal(event.tsMs, Date.parse('2026-08-18T11:05:29.539Z'));
  assert.equal(event.inputTokens, 53478);
  assert.equal(event.outputTokens, 0);
  assert.equal(event.cacheReadTokens, 0);
  assert.equal(event.cacheCreationTokens, 0);
  assert.equal(event.dedupeKey, 'claude:msg_01f86402-aaf5-436f-ab18-fb6c65d3b2b3');
});

test('形状 B：cache_read 落在 cacheReadTokens，不混进 inputTokens', () => {
  const event = parseClaudeLine(JSON.parse(SHAPE_B));
  assert.ok(event);
  assert.equal(event.inputTokens, 100);
  assert.equal(event.outputTokens, 20);
  assert.equal(event.cacheReadTokens, 900);
  assert.equal(event.cacheCreationTokens, 0);
});

test('形状 C：四个字段齐全时全部落位，忽略未知字段', () => {
  const event = parseClaudeLine(JSON.parse(SHAPE_C));
  assert.ok(event);
  assert.equal(event.inputTokens, 10);
  assert.equal(event.outputTokens, 2);
  assert.equal(event.cacheReadTokens, 30);
  assert.equal(event.cacheCreationTokens, 40);
});

test('非 assistant / 无 usage / <synthetic> / 缺 id / 缺时间戳 都返回 null', () => {
  assert.equal(parseClaudeLine(null), null);
  assert.equal(parseClaudeLine({ type: 'user', message: { usage: { input_tokens: 1 } } }), null);
  assert.equal(parseClaudeLine({ type: 'assistant', message: {} }), null);
  assert.equal(
    parseClaudeLine({
      type: 'assistant', timestamp: '2026-08-18T11:05:29.539Z',
      message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 1 } },
    }),
    null,
  );
  assert.equal(
    parseClaudeLine({
      type: 'assistant', timestamp: '2026-08-18T11:05:29.539Z',
      message: { model: 'm', usage: { input_tokens: 1 } },
    }),
    null,
  );
  assert.equal(
    parseClaudeLine({
      type: 'assistant', message: { id: 'm', model: 'm', usage: { input_tokens: 1 } },
    }),
    null,
  );
});

test('缺 cwd 时 projectPath 为 null，但事件仍然产出', () => {
  const event = parseClaudeLine({
    type: 'assistant', timestamp: '2026-08-18T11:05:29.539Z',
    message: { id: 'm', model: 'm', usage: { input_tokens: 1 } },
  });
  assert.ok(event);
  assert.equal(event.projectPath, null);
});
