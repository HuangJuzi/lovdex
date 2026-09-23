import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePermissionMode } from './resolvePermissionMode';

const VALID = ['default', 'auto', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'] as const;

const base = {
  sessionMode: null,
  taskMode: null,
  providerLastMode: null,
  providerDefault: 'default',
  validModes: VALID,
} as const;

test('the session choice outranks everything', () => {
  assert.equal(
    resolvePermissionMode({ ...base, sessionMode: 'default', taskMode: 'autoApprove', providerLastMode: 'plan' }),
    'default',
  );
});

test('a task mode outranks the provider-level memory', () => {
  assert.equal(
    resolvePermissionMode({ ...base, taskMode: 'autoApprove', providerLastMode: 'plan' }),
    'autoApprove',
  );
});

test('without a session or task, the provider memory is used', () => {
  assert.equal(resolvePermissionMode({ ...base, providerLastMode: 'plan' }), 'plan');
});

test('with nothing set, the provider default wins', () => {
  assert.equal(resolvePermissionMode(base), 'default');
});

test('an invalid candidate is skipped, not returned', () => {
  // sessionMode 来自 localStorage，可能是别的 provider 留下的值。
  assert.equal(
    resolvePermissionMode({ ...base, sessionMode: 'garbage', taskMode: 'autoApprove' }),
    'autoApprove',
  );
  assert.equal(
    resolvePermissionMode({ ...base, sessionMode: '', taskMode: null, providerLastMode: 'dontAsk' }),
    'default',
  );
});

test('null and undefined candidates never win', () => {
  assert.equal(resolvePermissionMode({ ...base, sessionMode: undefined, taskMode: undefined }), 'default');
});
