import assert from 'node:assert/strict';
import test from 'node:test';

import { isTaskLabel, isTaskStatus } from '@/shared/task-status.js';

test('reminder is a valid task label', () => {
  assert.equal(isTaskLabel('reminder'), true);
});

test('status guards unchanged', () => {
  assert.equal(isTaskStatus('todo'), true);
  assert.equal(isTaskStatus('backlog'), false);
});
