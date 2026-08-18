import test from 'node:test';
import assert from 'node:assert/strict';

import type { Project, ProjectSession } from '../../../types/app';

import { excludeHiddenProjects, formatCompactSessionAge, getRecentSessions, getSessionDotState, isProjectActive, isSessionActive, isSessionRecentlyActive, sortProjects } from './utils';

const mkSession = (id: string, lastActivity?: string): ProjectSession => ({
  id,
  summary: `session ${id}`,
  lastActivity,
});

const mkProject = (
  projectId: string,
  displayName: string,
  opts: { isStarred?: boolean; sessions?: ProjectSession[] } = {},
): Project => ({
  projectId,
  displayName,
  fullPath: `/${projectId}`,
  isStarred: opts.isStarred ?? false,
  sessions: opts.sessions ?? [],
});

const NOW = new Date('2026-08-04T12:00:00Z');

test('isProjectActive returns true when any loaded session is processing', () => {
  const project = mkProject('p1', 'P1', { sessions: [mkSession('s1'), mkSession('s2')] });
  assert.equal(isProjectActive(project, new Set(['s2']), NOW), true);
});

test('isProjectActive handles numeric session ids', () => {
  const project = mkProject('p1', 'P1', { sessions: [{ id: 42 as unknown as string, summary: 'x' }] });
  assert.equal(isProjectActive(project, new Set(['42']), NOW), true);
});

test('isProjectActive returns false when no session is processing', () => {
  const project = mkProject('p1', 'P1', { sessions: [mkSession('s1')] });
  assert.equal(isProjectActive(project, new Set(['other']), NOW), false);
});

test('isProjectActive returns false for empty or missing session lists', () => {
  assert.equal(isProjectActive(mkProject('p1', 'P1'), new Set(['s1']), NOW), false);
  const noSessions: Project = { projectId: 'p2', displayName: 'P2', fullPath: '/p2' };
  assert.equal(isProjectActive(noSessions, new Set(['s1']), NOW), false);
});

test('isProjectActive returns false for an empty active set', () => {
  const project = mkProject('p1', 'P1', { sessions: [mkSession('s1')] });
  assert.equal(isProjectActive(project, new Set(), NOW), false);
});

test('getSessionDotState prioritizes attention over running', () => {
  assert.equal(getSessionDotState(true, true), 'attention');
  assert.equal(getSessionDotState(true, false), 'attention');
});

test('getSessionDotState distinguishes active from idle', () => {
  assert.equal(getSessionDotState(false, true), 'active');
  assert.equal(getSessionDotState(false, false), 'idle');
});

test('sortProjects floats active projects above inactive regardless of star', () => {
  const activeUnstarred = mkProject('pa', 'Active project', { sessions: [mkSession('a1')] });
  const inactiveStarred = mkProject('pb', 'Starred idle', { isStarred: true });
  const result = sortProjects([inactiveStarred, activeUnstarred], 'name', new Set(['a1']), NOW);
  assert.deepEqual(result.map((p) => p.projectId), ['pa', 'pb']);
});

test('sortProjects keeps starred first within the same activity bucket', () => {
  const activeStarred = mkProject('pa', 'B', { isStarred: true, sessions: [mkSession('a1')] });
  const activeUnstarred = mkProject('pb', 'A', { sessions: [mkSession('a1')] });
  const result = sortProjects([activeUnstarred, activeStarred], 'name', new Set(['a1']), NOW);
  assert.deepEqual(result.map((p) => p.projectId), ['pa', 'pb']);
});

test('sortProjects falls back to name order for idle projects', () => {
  const result = sortProjects(
    [mkProject('zc', 'Charlie'), mkProject('aa', 'Alpha'), mkProject('bb', 'Bravo')],
    'name',
    new Set(),
    NOW,
  );
  assert.deepEqual(result.map((p) => p.projectId), ['aa', 'bb', 'zc']);
});

test('sortProjects uses date order for idle projects', () => {
  const older = mkProject('older', 'Older', { sessions: [mkSession('s1', '2026-01-01T00:00:00Z')] });
  const newer = mkProject('newer', 'Newer', { sessions: [mkSession('s2', '2026-02-01T00:00:00Z')] });
  const result = sortProjects([older, newer], 'date', new Set(), NOW);
  assert.deepEqual(result.map((p) => p.projectId), ['newer', 'older']);
});

test('sortProjects falls back to name order within the active bucket', () => {
  const activeA = mkProject('pb', 'B', { sessions: [mkSession('a1')] });
  const activeAa = mkProject('pa', 'A', { sessions: [mkSession('a1')] });
  const result = sortProjects([activeA, activeAa], 'name', new Set(['a1']), NOW);
  assert.deepEqual(result.map((p) => p.projectId), ['pa', 'pb']);
});

test('isSessionRecentlyActive is true only within the 10-minute window', () => {
  assert.equal(isSessionRecentlyActive(mkSession('s1', '2026-08-04T11:55:00Z'), NOW), true);
  assert.equal(isSessionRecentlyActive(mkSession('s1', '2026-08-04T11:00:00Z'), NOW), false);
  assert.equal(isSessionRecentlyActive(mkSession('s1'), NOW), false);
});

test('isSessionRecentlyActive uses a strict 10-minute boundary', () => {
  // exactly 10 minutes ago → not recent (strict <)
  assert.equal(isSessionRecentlyActive(mkSession('s1', '2026-08-04T11:50:00Z'), NOW), false);
  // one second inside the window → recent
  assert.equal(isSessionRecentlyActive(mkSession('s1', '2026-08-04T11:50:01Z'), NOW), true);
});

test('isSessionActive is true when running or recently active', () => {
  assert.equal(isSessionActive(mkSession('s1', '2026-08-04T11:55:00Z'), new Set(), NOW), true);
  assert.equal(isSessionActive(mkSession('s1'), new Set(['s1']), NOW), true);
  assert.equal(isSessionActive(mkSession('s1', '2026-08-04T11:00:00Z'), new Set(), NOW), false);
});

test('isProjectActive returns true for a recently active session', () => {
  const recent = mkProject('p1', 'P1', { sessions: [mkSession('s1', '2026-08-04T11:55:00Z')] });
  assert.equal(isProjectActive(recent, new Set(), NOW), true);
});

test('sortProjects floats a recently active project above an idle one', () => {
  const recent = mkProject('pa', 'Recent', { sessions: [mkSession('s1', '2026-08-04T11:55:00Z')] });
  const idle = mkProject('pb', 'Idle', { sessions: [mkSession('s2', '2026-08-04T10:00:00Z')] });
  const result = sortProjects([idle, recent], 'name', new Set(), NOW);
  assert.deepEqual(result.map((p) => p.projectId), ['pa', 'pb']);
});

test('excludeHiddenProjects drops operator workspace projects', () => {
  const assistantWs = mkProject('op-ws', 'operator-workspace');
  (assistantWs as Project).isOperatorWorkspace = true;
  const regular = mkProject('reg', 'Regular');
  const out = excludeHiddenProjects([assistantWs, regular]);
  assert.deepEqual(out.map((p) => p.projectId), ['reg']);
});

test('getRecentSessions flattens across projects and sorts by recent activity desc', () => {
  const pA = mkProject('pA', 'A', {
    sessions: [mkSession('a1', '2026-08-04T10:00:00Z'), mkSession('a2', '2026-08-04T11:00:00Z')],
  });
  const pB = mkProject('pB', 'B', { sessions: [mkSession('b1', '2026-08-04T11:30:00Z')] });
  const out = getRecentSessions([pA, pB], 10);
  assert.deepEqual(out.map((e) => e.session.id), ['b1', 'a2', 'a1']);
  assert.deepEqual(out.map((e) => e.project.projectId), ['pB', 'pA', 'pA']);
});

test('getRecentSessions caps at limit', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => mkSession(`s${i}`, `2026-08-04T${String(10 + i).padStart(2, '0')}:00:00Z`));
  const out = getRecentSessions([mkProject('p1', 'P1', { sessions })], 10);
  assert.equal(out.length, 10);
  assert.equal(out[0].session.id, 's11');
  assert.equal(out[9].session.id, 's2');
});

test('getRecentSessions keeps operator workspace sessions', () => {
  const assistantWs = mkProject('op-ws', 'operator-workspace', { sessions: [mkSession('op1', '2026-08-04T11:30:00Z')] });
  (assistantWs as Project).isOperatorWorkspace = true;
  const regular = mkProject('reg', 'Regular', { sessions: [mkSession('r1', '2026-08-04T10:00:00Z')] });
  const out = getRecentSessions([regular, assistantWs], 10);
  assert.deepEqual(out.map((e) => e.session.id), ['op1', 'r1']);
});

test('getRecentSessions returns empty for projects without sessions', () => {
  assert.deepEqual(getRecentSessions([mkProject('p1', 'P1')], 10), []);
  assert.deepEqual(getRecentSessions([], 10), []);
});

test('getRecentSessions sorts sessions without timestamps last', () => {
  const pA = mkProject('pA', 'A', { sessions: [mkSession('a1'), mkSession('a2', '2026-08-04T11:00:00Z')] });
  const out = getRecentSessions([pA], 10);
  assert.equal(out[0].session.id, 'a2');
  assert.equal(out[1].session.id, 'a1');
});

test('formatCompactSessionAge renders compact relative time', () => {
  assert.equal(formatCompactSessionAge('2026-08-04T11:59:30Z', new Date('2026-08-04T12:00:00Z')), '<1m');
  assert.equal(formatCompactSessionAge('2026-08-04T11:55:00Z', new Date('2026-08-04T12:00:00Z')), '5m');
  assert.equal(formatCompactSessionAge('2026-08-04T10:00:00Z', new Date('2026-08-04T12:00:00Z')), '2hr');
  assert.equal(formatCompactSessionAge('2026-08-01T12:00:00Z', new Date('2026-08-04T12:00:00Z')), '3d');
});

test('formatCompactSessionAge returns empty for invalid input', () => {
  assert.equal(formatCompactSessionAge('', new Date('2026-08-04T12:00:00Z')), '');
});
