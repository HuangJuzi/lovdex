import test from 'node:test';
import assert from 'node:assert/strict';

import { projectLabel } from './projectLabel';

const options = [{ value: '/proj', label: 'proj' }];

test('is_operator=1 归一成助手标签', () => {
  assert.equal(projectLabel({ is_operator: 1, project_path: '/proj' }, options), '🤖 Lovdex助手');
});

test('无项目路径归一成助手标签', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: null }, options), '🤖 Lovdex助手');
});

test('命中 projectOptions 时用 label', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: '/proj' }, options), 'proj');
});

test('未命中 projectOptions 时回退完整路径', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: '/other' }, options), '/other');
});

test('project_path 为空串时也归一成助手标签', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: '' }, options), '🤖 Lovdex助手');
});

// 空 label 的 option 今天构造不出来（toProjectOption 用 `displayName || path`），
// 但渲染成空白比渲染成路径更糟，所以用 `||` 而非 `??` 兜住，并在这里钉死。
test('命中但 label 为空串时回退完整路径', () => {
  assert.equal(projectLabel({ is_operator: 0, project_path: '/proj' }, [{ value: '/proj', label: '' }]), '/proj');
});
