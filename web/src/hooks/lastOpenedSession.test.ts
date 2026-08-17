import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAST_OPENED_SESSION_KEY,
  readLastOpenedSessionId,
  writeLastOpenedSessionId,
  clearLastOpenedSessionId,
  findProjectSessionById,
} from './lastOpenedSession';
import type { Project } from '../types/app';

test('storage helpers round-trip through localStorage', () => {
  const store = new Map<string, string>();
  // node:test 环境没有浏览器 localStorage，注入一个假实现。
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };

  assert.equal(readLastOpenedSessionId(), null);
  writeLastOpenedSessionId('sess-1');
  assert.equal(store.get(LAST_OPENED_SESSION_KEY), 'sess-1');
  assert.equal(readLastOpenedSessionId(), 'sess-1');
  clearLastOpenedSessionId();
  assert.equal(readLastOpenedSessionId(), null);
});

test('findProjectSessionById returns the owning project and session', () => {
  const session = { id: 's1' };
  const project = {
    projectId: 'p1',
    sessions: [{ id: 's1' }, { id: 's2' }],
  } as unknown as Project;
  const match = findProjectSessionById([project], 's1');
  assert.equal(match?.project, project);
  assert.equal(match?.session.id, 's1');
});

test('findProjectSessionById returns null when missing', () => {
  const project = { projectId: 'p1', sessions: [{ id: 's1' }] } as unknown as Project;
  assert.equal(findProjectSessionById([project], 'nope'), null);
  assert.equal(findProjectSessionById([], 's1'), null);
});
