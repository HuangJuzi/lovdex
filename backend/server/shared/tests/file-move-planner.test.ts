import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planMoves, collectMoveConflicts } from '@/shared/file-move-planner.js';

test('planMoves: plain moves join targetDir + basename', () => {
  const plan = planMoves(
    [
      { path: '/proj/src/a.ts', type: 'file' },
      { path: '/proj/docs', type: 'directory' },
    ],
    '/proj/lib',
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.moves.map((m) => ({ from: m.from, to: m.to })),
    [
      { from: '/proj/src/a.ts', to: '/proj/lib/a.ts' },
      { from: '/proj/docs', to: '/proj/lib/docs' },
    ],
  );
  assert.deepEqual(plan.skippedNoOp, []);
});

test('planMoves: no-op when destination equals source', () => {
  const plan = planMoves([{ path: '/proj/lib/a.ts', type: 'file' }], '/proj/lib');
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.skippedNoOp, ['/proj/lib/a.ts']);
});

test('planMoves: rejects target inside a moved directory (or the item itself)', () => {
  // 目标就是被移动项
  const selfMove = planMoves([{ path: '/proj/docs', type: 'directory' }], '/proj/docs');
  assert.equal(selfMove.ok, false);
  if (selfMove.ok) return;
  assert.equal(selfMove.code, 'INTO_ITSELF');
  assert.equal(selfMove.path, '/proj/docs');

  // 目标是被移动项的子孙
  const intoChild = planMoves([{ path: '/proj/docs', type: 'directory' }], '/proj/docs/sub');
  assert.equal(intoChild.ok, false);
  if (intoChild.ok) return;
  assert.equal(intoChild.code, 'INTO_ITSELF');
});

test('planMoves: prefix compare is segment-aware (not raw string)', () => {
  // '/proj/docs-old' 不包含 '/proj/docs' —— 不应误判
  const plan = planMoves([{ path: '/proj/docs', type: 'directory' }], '/proj/docs-old');
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].to, '/proj/docs-old/docs');
});

test('planMoves: drops descendants of other selected items and exact duplicates', () => {
  const plan = planMoves(
    [
      { path: '/proj/docs', type: 'directory' },
      { path: '/proj/docs/sub/b.ts', type: 'file' }, // 被选中目录包含 -> 跳过
      { path: '/proj/docs', type: 'directory' },     // 重复路径 -> 跳过
      { path: '/proj/c.ts', type: 'file' },
    ],
    '/proj/lib',
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.moves.map((m) => m.from).sort(),
    ['/proj/c.ts', '/proj/docs'],
  );
});

test('planMoves: same basename from different sources into one dir is rejected', () => {
  const plan = planMoves(
    [
      { path: '/proj/a/README.md', type: 'file' },
      { path: '/proj/b/README.md', type: 'file' },
    ],
    '/proj/dst',
  );
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.code, 'DUPLICATE_TARGET');
  assert.equal(plan.path, '/proj/b/README.md');
  assert.equal(plan.conflictWith, '/proj/a/README.md');
});

test('collectMoveConflicts: lists names of existing destinations', async () => {
  const moves = [
    { from: '/proj/a.ts', to: '/proj/lib/a.ts', name: 'a.ts' },
    { from: '/proj/b.ts', to: '/proj/lib/b.ts', name: 'b.ts' },
  ];
  const existing = new Set(['/proj/lib/b.ts']);
  const conflicts = await collectMoveConflicts(moves, (p) => Promise.resolve(existing.has(p)));
  assert.deepEqual(conflicts, ['b.ts']);
});
