import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLinkedTaskModel, resolveSessionComposerModel } from './useChatProviderState';

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

test('session override wins over the linked task executor_model', () => {
  assert.equal(
    resolveSessionComposerModel({
      sessionOverrideModel: 'claude-opus-4-8',
      linkedTaskModel: 'claude-sonnet-4-6',
      catalogDefault: 'default',
      currentModel: 'claude-sonnet-4-6',
    }),
    'claude-opus-4-8',
  );
});

test('session override wins over a task that leaves the model blank', () => {
  assert.equal(
    resolveSessionComposerModel({
      sessionOverrideModel: 'claude-opus-4-8',
      linkedTaskModel: null,
      catalogDefault: 'default',
      currentModel: 'default',
    }),
    'claude-opus-4-8',
  );
});

test('session override is trimmed only when the override is the deciding input', () => {
  assert.equal(
    resolveSessionComposerModel({
      sessionOverrideModel: '  claude-opus-4-8  ',
      linkedTaskModel: 'claude-sonnet-4-6',
      catalogDefault: 'default',
      currentModel: 'claude-sonnet-4-6',
    }),
    'claude-opus-4-8',
  );
});

test('task-linked session without override follows the task executor_model', () => {
  assert.equal(
    resolveSessionComposerModel({
      sessionOverrideModel: undefined,
      linkedTaskModel: 'codex-gpt-5.4',
      catalogDefault: 'gpt-5.4',
      currentModel: 'gpt-5.4',
    }),
    'codex-gpt-5.4',
  );
});

test('task-linked session with blank model falls back to the catalog default', () => {
  assert.equal(
    resolveSessionComposerModel({
      sessionOverrideModel: undefined,
      linkedTaskModel: '',
      catalogDefault: 'opencode/deepseek-v4-flash-free',
      currentModel: 'something-stale',
    }),
    'opencode/deepseek-v4-flash-free',
  );
});

test('task-linked blank model with no catalog default keeps the current model', () => {
  assert.equal(
    resolveSessionComposerModel({
      sessionOverrideModel: undefined,
      linkedTaskModel: null,
      catalogDefault: undefined,
      currentModel: 'my-default',
    }),
    'my-default',
  );
});

test('plain session without override keeps the per-provider model unchanged', () => {
  assert.equal(
    resolveSessionComposerModel({
      sessionOverrideModel: undefined,
      linkedTaskModel: undefined,
      catalogDefault: 'default',
      currentModel: 'claude-sonnet-4-6',
    }),
    'claude-sonnet-4-6',
  );
});
