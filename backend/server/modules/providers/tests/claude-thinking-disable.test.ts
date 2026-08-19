import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldDisableClaudeThinking } from '@/claude-sdk.js';

/**
 * Third-party reasoning models (DeepSeek/Kimi/GLM via the sophnet proxy)
 * emit their reasoning phase as standalone thinking-only assistant turns,
 * tripping the CLI's "no visible output" nudge loop. shouldDisableClaudeThinking
 * decides whether a session's effective model must skip extended thinking.
 */

test('slot "default" that resolves to a listed model disables thinking', () => {
  assert.equal(
    shouldDisableClaudeThinking('default', {
      defaultModel: 'DeepSeek-V4-Flash-0731',
      disableThinkingModels: 'DeepSeek-V4-Flash-0731,DeepSeek-V4-Pro-0813',
    }),
    true,
  );
});

test('slot "haiku" that resolves to a listed model disables thinking', () => {
  assert.equal(
    shouldDisableClaudeThinking('haiku', {
      haikuModel: 'DeepSeek-V4-Flash-0731',
      disableThinkingModels: 'DeepSeek-V4-Flash-0731',
    }),
    true,
  );
});

test('explicit listed model id disables thinking', () => {
  assert.equal(
    shouldDisableClaudeThinking('Kimi-K3', {
      disableThinkingModels: 'Kimi-K3',
    }),
    true,
  );
});

test('slot resolving to an Anthropic model keeps thinking enabled', () => {
  assert.equal(
    shouldDisableClaudeThinking('sonnet', {
      sonnetModel: 'claude-opus-4-8',
      disableThinkingModels: 'DeepSeek-V4-Flash-0731,Kimi-K3',
    }),
    false,
  );
});

test('prefix-level false positives: substring does not match', () => {
  assert.equal(
    shouldDisableClaudeThinking('DeepSeek-V4-Flash-0731-dev', {
      disableThinkingModels: 'DeepSeek-V4-Flash-0731',
    }),
    false,
  );
});

test('unlisted explicit model keeps thinking enabled', () => {
  assert.equal(
    shouldDisableClaudeThinking('claude-opus-4-8', {
      disableThinkingModels: 'DeepSeek-V4-Flash-0731',
    }),
    false,
  );
});

test('empty or missing config never disables', () => {
  assert.equal(shouldDisableClaudeThinking('default', undefined), false);
  assert.equal(shouldDisableClaudeThinking('default', {}), false);
  assert.equal(shouldDisableClaudeThinking('DeepSeek-V4-Flash-0731', { disableThinkingModels: '' }), false);
});

test('tolerates whitespace and empty entries in the list', () => {
  assert.equal(
    shouldDisableClaudeThinking('GLM-5.2', {
      disableThinkingModels: ' , DeepSeek-V4-Flash-0731 , GLM-5.2 , ',
    }),
    true,
  );
});

test('null/undefined model never disables', () => {
  assert.equal(shouldDisableClaudeThinking(null, { disableThinkingModels: 'Kimi-K3' }), false);
  assert.equal(shouldDisableClaudeThinking(undefined, { disableThinkingModels: 'Kimi-K3' }), false);
});