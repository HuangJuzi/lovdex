import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCodexFile } from '../services/token-usage-parsers.js';

/** 用真实 codex session 的字段形状构造：session_meta 带 cwd，turn_context 带 model，
 *  token_count 带累计 total_token_usage（注意 codex 的 input_tokens 含 cached）。 */
function codexFile(): string {
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: '019f62b2-89a5-7513-b05e-d3f84b1e60a2',
        cwd: '/mnt/b/workdir/github/lovdex',
        model_provider: 'sophnet',
      },
    }),
    JSON.stringify({
      type: 'turn_context',
      payload: { cwd: '/mnt/b/workdir/github/lovdex', model: 'gpt-5.5' },
    }),
    // 第一次累计：全部当作增量
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-14T22:14:56.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000, cached_input_tokens: 400,
            output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050,
          },
        },
      },
    }),
    // 第二次累计：只取相对上次的增量
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-14T22:14:58.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1300, cached_input_tokens: 500,
            output_tokens: 80, reasoning_output_tokens: 30, total_tokens: 1380,
          },
        },
      },
    }),
    '',
  ];
  return lines.join('\n');
}

test('累计值差分成区间事件，且 input 扣除 cached', () => {
  const events = parseCodexFile(codexFile(), '/tmp/x.jsonl');
  assert.equal(events.length, 2);

  const [first, second] = events;
  assert.equal(first.source, 'codex');
  assert.equal(first.model, 'gpt-5.5');
  assert.equal(first.sessionId, '019f62b2-89a5-7513-b05e-d3f84b1e60a2');
  assert.equal(first.projectPath, '/mnt/b/workdir/github/lovdex');
  assert.equal(first.tsMs, Date.parse('2026-07-14T22:14:56.000Z'));
  // 首次以 0 为基准：input = 1000-400 = 600，cache_read = 400，output = 50
  assert.equal(first.inputTokens, 600);
  assert.equal(first.cacheReadTokens, 400);
  assert.equal(first.outputTokens, 50);
  assert.equal(first.cacheCreationTokens, 0);
  assert.equal(first.dedupeKey, 'codex:019f62b2-89a5-7513-b05e-d3f84b1e60a2:3');

  // 增量：input 300-100 = 200，cached 100，output 30
  assert.equal(second.inputTokens, 200);
  assert.equal(second.cacheReadTokens, 100);
  assert.equal(second.outputTokens, 30);
  assert.equal(second.dedupeKey, 'codex:019f62b2-89a5-7513-b05e-d3f84b1e60a2:4');
});

test('同一文件重复解析结果完全一致（保证 INSERT OR IGNORE 幂等）', () => {
  const a = parseCodexFile(codexFile(), '/tmp/x.jsonl');
  const b = parseCodexFile(codexFile(), '/tmp/x.jsonl');
  assert.deepEqual(a, b);
});

test('取不到 model 时标为 unknown 而不是丢弃', () => {
  const text = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's1', cwd: '/p' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-14T22:14:56.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } },
    }),
  ].join('\n');
  const events = parseCodexFile(text, '/tmp/y.jsonl');
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'unknown');
});

test('损坏行与无增量的重复上报都被跳过，且不打断后续解析', () => {
  const text = [
    '{ this is not json',
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's2', cwd: '/p' } }),
    JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-14T22:14:56.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } },
    }),
    // 累计值没变 → 增量为 0 → 不产出事件
    JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-14T22:14:57.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } },
    }),
    JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-14T22:14:58.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, output_tokens: 2 } } },
    }),
  ].join('\n');
  const events = parseCodexFile(text, '/tmp/z.jsonl');
  assert.equal(events.length, 2);
  assert.equal(events[0].inputTokens, 10);
  assert.equal(events[1].inputTokens, 10);
});
