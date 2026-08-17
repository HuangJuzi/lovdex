import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionToTaskPayload } from './convertToTaskPayload';
import type { ProjectSession } from '../../../../types/app';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return { id: 's1', ...overrides };
}

test('running session defaults to in_progress, idle session to todo', () => {
  assert.equal(buildSessionToTaskPayload({ session: makeSession(), isRunning: true }).status, 'in_progress');
  assert.equal(buildSessionToTaskPayload({ session: makeSession(), isRunning: false }).status, 'todo');
});

test('title falls back through custom_name → summary', () => {
  const p = buildSessionToTaskPayload({ session: makeSession({ custom_name: '自定义名', summary: '自动摘要' }), isRunning: false });
  assert.equal(p.title, '自定义名');
  const q = buildSessionToTaskPayload({ session: makeSession({ summary: '自动摘要' }), isRunning: false });
  assert.equal(q.title, '自动摘要');
});

test('description defaults to summary', () => {
  const p = buildSessionToTaskPayload({ session: makeSession({ summary: 's' }), isRunning: false });
  assert.equal(p.description, 's');
});

test('provider kept when a task engine, else falls back to claude', () => {
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'codex' }), isRunning: false }).executorProvider, 'codex');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'opencode' }), isRunning: false }).executorProvider, 'opencode');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'qoder' }), isRunning: false }).executorProvider, 'qoder');
  // NOTE: 'sophcode' is a deliberately-killed legacy engine (not a member of
  // TaskEngine). This negative case verifies unknown/old provider values fall
  // back to claude instead of shipping a bogus engine into the DB. Keep it.
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'sophcode' as unknown as ProjectSession['provider'] }), isRunning: false }).executorProvider, 'claude');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({}), isRunning: false }).executorProvider, 'claude');
});

test('meta fields default to P2 / other / empty / empty', () => {
  const p = buildSessionToTaskPayload({ session: makeSession(), isRunning: false });
  assert.equal(p.priority, 'P2');
  assert.equal(p.label, 'other');
  assert.equal(p.deadline, '');
  assert.equal(p.remark, '');
});

test('executorModel resolves provider fallback (localStorage absent in node:test)', () => {
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'claude' }), isRunning: false }).executorModel, 'default');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'codex' }), isRunning: false }).executorModel, 'gpt-5.4');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'opencode' }), isRunning: false }).executorModel, 'opencode/deepseek-v4-flash-free');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'qoder' }), isRunning: false }).executorModel, 'auto');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({}), isRunning: false }).executorModel, '');
});
