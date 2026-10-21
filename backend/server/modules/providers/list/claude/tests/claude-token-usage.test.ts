import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeTokenBudget,
  parseClaudeTranscriptTokenUsage,
} from '@/modules/providers/list/claude/claude-token-usage.js';

const CONTEXT_WINDOW = 160000;

function assistantLine(usage: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-21T04:30:38.581Z',
    message: {
      id: 'msg_01',
      role: 'assistant',
      model: 'DeepSeek-V4.1-Flash-1017',
      content: [{ type: 'text', text: 'ok' }],
      usage,
    },
    ...overrides,
  });
}

test('buildClaudeTokenBudget reports the per-step prompt (cache included) + completion', () => {
  const budget = buildClaudeTokenBudget({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 980,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 73216,
        output_tokens: 1,
      },
    },
  }, CONTEXT_WINDOW);

  assert.ok(budget);
  assert.equal(budget.used, 74297);
  assert.equal(budget.inputTokens, 74296);
  assert.equal(budget.outputTokens, 1);
  assert.equal(budget.cacheReadTokens, 73216);
  assert.equal(budget.cacheCreationTokens, 100);
  assert.equal(budget.cacheTokens, 73316);
  assert.equal(budget.total, CONTEXT_WINDOW);
  assert.deepEqual(budget.breakdown, { input: 74296, output: 1 });
});

test('buildClaudeTokenBudget ignores the terminal result message (cumulative totals)', () => {
  // The SDK result carries the run's totals across every turn. Letting it
  // through made the badge jump from ~74K (context) to millions after a turn.
  const budget = buildClaudeTokenBudget({
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 49586,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1641856,
      output_tokens: 6888,
    },
    modelUsage: {
      'DeepSeek-V4.1-Flash-1017': {
        inputTokens: 49586,
        outputTokens: 6888,
        cacheReadInputTokens: 1641856,
        cacheCreationInputTokens: 0,
      },
    },
  }, CONTEXT_WINDOW);

  assert.equal(budget, null);
});

test('buildClaudeTokenBudget ignores legacy modelUsage-only payloads', () => {
  assert.equal(buildClaudeTokenBudget({
    type: 'result',
    modelUsage: { model: { cumulativeInputTokens: 10, cumulativeOutputTokens: 2 } },
  }, CONTEXT_WINDOW), null);
});

test('buildClaudeTokenBudget accepts messages without a nested message usage', () => {
  const budget = buildClaudeTokenBudget({
    usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 900 },
  }, CONTEXT_WINDOW);

  assert.equal(budget?.used, 1005);
  assert.equal(budget?.inputTokens, 1000);
});

test('buildClaudeTokenBudget returns null for messages with no usage', () => {
  assert.equal(buildClaudeTokenBudget({ type: 'user' }, CONTEXT_WINDOW), null);
  assert.equal(buildClaudeTokenBudget(null, CONTEXT_WINDOW), null);
  assert.equal(buildClaudeTokenBudget('nope', CONTEXT_WINDOW), null);
});

test('parseClaudeTranscriptTokenUsage takes the newest assistant usage entry', () => {
  const text = [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    assistantLine({ input_tokens: 5512, output_tokens: 191, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    JSON.stringify({ type: 'user', message: { content: 'again' } }),
    assistantLine({ input_tokens: 980, output_tokens: 311, cache_read_input_tokens: 82688, cache_creation_input_tokens: 0 }),
    JSON.stringify({ type: 'last-prompt', timestamp: null }),
  ].join('\n');

  const usage = parseClaudeTranscriptTokenUsage(text, CONTEXT_WINDOW);

  assert.equal(usage.used, 83979);
  assert.equal(usage.inputTokens, 83668);
  assert.equal(usage.outputTokens, 311);
  assert.equal(usage.cacheReadTokens, 82688);
  assert.equal(usage.total, CONTEXT_WINDOW);
});

test('parseClaudeTranscriptTokenUsage skips <synthetic> entries (API error messages)', () => {
  // A failed turn ends with a synthetic assistant message whose usage is all
  // zeros. Stopping there reported 0 tokens for a session that had real usage.
  const text = [
    assistantLine({ input_tokens: 620, output_tokens: 41, cache_read_input_tokens: 41000, cache_creation_input_tokens: 0 }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_error',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: 400 model not supported' }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
  ].join('\n');

  const usage = parseClaudeTranscriptTokenUsage(text, CONTEXT_WINDOW);

  assert.equal(usage.used, 41661);
  assert.equal(usage.inputTokens, 41620);
  assert.equal(usage.cacheReadTokens, 41000);
});

test('parseClaudeTranscriptTokenUsage returns zeros when nothing usable exists', () => {
  const empty = parseClaudeTranscriptTokenUsage('', CONTEXT_WINDOW);
  assert.equal(empty.used, 0);
  assert.equal(empty.total, CONTEXT_WINDOW);

  const malformed = parseClaudeTranscriptTokenUsage('not json\n{"type":"assistant"}', CONTEXT_WINDOW);
  assert.equal(malformed.used, 0);
});
