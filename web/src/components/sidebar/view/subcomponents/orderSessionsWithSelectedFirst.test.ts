import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import { orderSessionsWithSelectedFirst } from './SidebarProjectSessions';

const mkSession = (id: string): SessionWithProvider =>
  ({ id, summary: id, messageCount: 0, provider: 'claude' }) as SessionWithProvider;

const mkSelected = (id: string): ProjectSession =>
  ({ id, summary: id }) as ProjectSession;

test('orderSessionsWithSelectedFirst moves the selected session to the top', () => {
  const sessions = [mkSession('a'), mkSession('b'), mkSession('c'), mkSession('d')];
  const ordered = orderSessionsWithSelectedFirst(sessions, mkSelected('c'));
  assert.deepStrictEqual(ordered.map((s) => s.id), ['c', 'a', 'b', 'd']);
  // 原数组不被改动
  assert.deepStrictEqual(sessions.map((s) => s.id), ['a', 'b', 'c', 'd']);
});

test('orderSessionsWithSelectedFirst keeps order when the selection is absent or already first', () => {
  const sessions = [mkSession('a'), mkSession('b')];
  assert.deepStrictEqual(
    orderSessionsWithSelectedFirst(sessions, null).map((s) => s.id),
    ['a', 'b'],
    'no selection → unchanged'
  );
  assert.strictEqual(
    orderSessionsWithSelectedFirst(sessions, mkSelected('a')),
    sessions,
    'already first → same array reference (no re-render churn)'
  );
  // 选中的会话不在本列表（属于别的项目）→ 原样返回
  assert.strictEqual(
    orderSessionsWithSelectedFirst(sessions, mkSelected('zzz')),
    sessions,
    'selection from another project → unchanged'
  );
});
