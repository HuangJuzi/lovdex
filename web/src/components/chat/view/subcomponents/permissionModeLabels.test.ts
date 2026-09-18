import test from 'node:test';
import assert from 'node:assert/strict';

import type { PermissionMode } from '../../types/types';

import { LABEL_KEYS, getPermissionModeLabelKeys } from './permissionModeLabels';
import type { PermissionModeLabelKeys } from './permissionModeLabels';

// The expected table is spelled out here on purpose: this test is what pins
// each mode to its OWN keys. Prefix/shape/distinctness assertions all pass even
// if two modes' keys are swapped, so they are not a substitute for this.
//
// The runtime list below cannot catch a newly added mode on its own; the real
// guard is the `Record<PermissionMode, …>` in permissionModeLabels.ts — adding a
// mode to the union without adding a label turns typecheck red.
const ALL_MODES: PermissionMode[] = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'];

const EXPECTED: Record<PermissionMode, PermissionModeLabelKeys> = {
  default: { shortKey: 'codex.modesShort.default', fullKey: 'codex.modes.default' },
  auto: { shortKey: 'codex.modesShort.auto', fullKey: 'codex.modes.auto' },
  acceptEdits: { shortKey: 'codex.modesShort.acceptEdits', fullKey: 'codex.modes.acceptEdits' },
  bypassPermissions: {
    shortKey: 'codex.modesShort.bypassPermissions',
    fullKey: 'codex.modes.bypassPermissions',
  },
  plan: { shortKey: 'codex.modesShort.plan', fullKey: 'codex.modes.plan' },
};

test('maps each permission mode to its own i18n keys', () => {
  assert.deepEqual(LABEL_KEYS, EXPECTED);
  for (const mode of ALL_MODES) {
    assert.deepEqual(getPermissionModeLabelKeys(mode), EXPECTED[mode], `${mode} label keys`);
  }
});

test('unknown values fall back to default instead of throwing or returning undefined', () => {
  assert.deepEqual(getPermissionModeLabelKeys('garbage'), LABEL_KEYS.default);
  assert.deepEqual(getPermissionModeLabelKeys(''), LABEL_KEYS.default);
  // 组件 prop 的类型是 PermissionMode | string，所以未知值不是异常路径而是常态。
});
