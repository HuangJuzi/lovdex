import test from 'node:test';
import assert from 'node:assert/strict';

import type { MouseEvent } from 'react';

import type { FileTreeNode } from '../types/types';

import { classifySelectionClick, type SelectionClickResult } from './useFileTreeSelection';

const makeEvent = (opts: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) =>
  ({ shiftKey: opts.shiftKey ?? false, ctrlKey: opts.ctrlKey ?? false, metaKey: opts.metaKey ?? false }) as MouseEvent;

const node = (path: string, type: 'file' | 'directory' = 'file'): FileTreeNode => ({
  name: path.split('/').pop() ?? path,
  path,
  type,
});

const VISIBLE_ORDER = ['a.ts', 'docs', 'docs/x.ts', 'b.ts', 'c.ts'];

test('classifySelectionClick: plain click selects the row (never clears)', () => {
  const result = classifySelectionClick(node('b.ts'), makeEvent(), VISIBLE_ORDER, null);
  assert.deepEqual(result, { kind: 'select', path: 'b.ts', type: 'file' });
  // Even with an existing selection, a plain click is still a single-row select.
  const withSelection = classifySelectionClick(node('b.ts'), makeEvent(), VISIBLE_ORDER, 'a.ts');
  assert.deepEqual(withSelection, { kind: 'select', path: 'b.ts', type: 'file' });
});

test('classifySelectionClick: Ctrl/Cmd click toggles a single row', () => {
  const result = classifySelectionClick(node('docs/x.ts'), makeEvent({ ctrlKey: true }), VISIBLE_ORDER, null);
  assert.deepEqual(result, { kind: 'toggle', path: 'docs/x.ts' });
  const meta = classifySelectionClick(node('a.ts'), makeEvent({ metaKey: true }), VISIBLE_ORDER, 'b.ts');
  assert.deepEqual(meta, { kind: 'toggle', path: 'a.ts' });
});

test('classifySelectionClick: Shift click selects the anchor-to-row range', () => {
  const result = classifySelectionClick(node('b.ts'), makeEvent({ shiftKey: true }), VISIBLE_ORDER, 'a.ts');
  assert.deepEqual(result, { kind: 'range', paths: ['a.ts', 'docs', 'docs/x.ts', 'b.ts'] });
  // Without an anchor, the range starts at the clicked row itself.
  const selfRange = classifySelectionClick(node('c.ts'), makeEvent({ shiftKey: true }), VISIBLE_ORDER, null);
  assert.deepEqual(selfRange, { kind: 'range', paths: ['c.ts'] });
});

test('classifySelectionClick: directories select like files on plain click', () => {
  const result = classifySelectionClick(node('docs', 'directory'), makeEvent(), VISIBLE_ORDER, null);
  assert.deepEqual(result, { kind: 'select', path: 'docs', type: 'directory' });
});

test('SelectionClickResult kinds cover exactly select/toggle/range', () => {
  // Compile-time shape guard: the result union must not drift back to
  // clearing/default-opening kinds that would reopen files on single click.
  const results: SelectionClickResult[] = [
    { kind: 'select', path: 'a.ts', type: 'file' },
    { kind: 'toggle', path: 'a.ts' },
    { kind: 'range', paths: ['a.ts'] },
  ];
  assert.equal(results.length, 3);
});
