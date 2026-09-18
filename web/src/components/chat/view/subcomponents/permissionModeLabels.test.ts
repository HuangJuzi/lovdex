import test from 'node:test';
import assert from 'node:assert/strict';

import { LABEL_KEYS, getPermissionModeLabelKeys } from './permissionModeLabels';
import type { PermissionMode } from '../../types/types';

// 与 PermissionMode 联合类型保持同步的运行时清单。
// 注意：真正拦住「往联合类型里加了 mode 却忘了补标签」的是 permissionModeLabels.ts
// 里那个 Record<PermissionMode, …> —— 少一个键 typecheck 就红。本清单只保证
// 这份测试自己不会漏测。
const ALL_MODES: PermissionMode[] = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'];

test('every permission mode maps to a short key and a full key', () => {
  for (const mode of ALL_MODES) {
    const { shortKey, fullKey } = getPermissionModeLabelKeys(mode);
    assert.match(shortKey, /^codex\.modesShort\./, `${mode} shortKey`);
    assert.match(fullKey, /^codex\.modes\./, `${mode} fullKey`);
  }
});

test('short keys are distinct from each other and from the full keys', () => {
  const shorts = ALL_MODES.map((m) => getPermissionModeLabelKeys(m).shortKey);
  assert.equal(new Set(shorts).size, ALL_MODES.length, 'short keys must not collide');

  for (const mode of ALL_MODES) {
    const { shortKey, fullKey } = getPermissionModeLabelKeys(mode);
    assert.notEqual(shortKey, fullKey, `${mode} short/full must differ`);
  }
});

test('unknown values fall back to default instead of throwing or returning undefined', () => {
  assert.deepEqual(getPermissionModeLabelKeys('garbage'), LABEL_KEYS.default);
  assert.deepEqual(getPermissionModeLabelKeys(''), LABEL_KEYS.default);
  // 组件 prop 的类型是 PermissionMode | string，所以未知值不是异常路径而是常态。
});

test('LABEL_KEYS covers exactly the modes listed above', () => {
  assert.deepEqual(Object.keys(LABEL_KEYS).sort(), [...ALL_MODES].sort());
});
