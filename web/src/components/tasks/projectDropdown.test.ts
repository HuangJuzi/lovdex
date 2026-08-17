import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDropdownPosition } from './projectDropdown';

// 定位辅助：锚定触发器下方，右边缘不超出视口。
test('positions the panel below the trigger', () => {
  const pos = computeDropdownPosition({ left: 40, bottom: 100 }, 1200, 800);
  assert.equal(pos.left, 40);
  assert.equal(pos.top, 108); // bottom + 8
  assert.ok(pos.maxHeight > 0);
});

test('clamps the left edge so the panel stays inside the viewport', () => {
  const nearRight = computeDropdownPosition({ left: 1000, bottom: 80 }, 1200, 800);
  assert.ok(nearRight.left + 256 <= 1200);
  assert.ok(nearRight.left >= 8);
  assert.ok(nearRight.left < 1000); // moved left away from the right edge

  const farLeft = computeDropdownPosition({ left: -50, bottom: 80 }, 1200, 800);
  assert.equal(farLeft.left, 8);
});