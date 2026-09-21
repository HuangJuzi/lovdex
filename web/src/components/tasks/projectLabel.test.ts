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
