import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLinkedTaskModel } from './useChatProviderState';

test('linked task with explicit executor_model resolves to that model', () => {
  assert.equal(resolveLinkedTaskModel('claude-opus-4-8', 'default'), 'claude-opus-4-8');
  assert.equal(resolveLinkedTaskModel('  claude-sonnet-4-6  ', 'default'), 'claude-sonnet-4-6');
});

test('linked task with blank model (默认模型) resolves to the provider catalog default', () => {
  assert.equal(resolveLinkedTaskModel(null, 'default'), 'default');
  assert.equal(resolveLinkedTaskModel('', 'gpt-5.4'), 'gpt-5.4');
});

test('linked task with blank model and no catalog default yet returns null', () => {
  assert.equal(resolveLinkedTaskModel(null, undefined), null);
});

test('no linked task (undefined) always returns null regardless of catalog default', () => {
  assert.equal(resolveLinkedTaskModel(undefined, 'default'), null);
  assert.equal(resolveLinkedTaskModel(undefined, undefined), null);
});
