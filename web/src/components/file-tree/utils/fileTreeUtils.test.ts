import test from 'node:test';
import assert from 'node:assert/strict';

import { filterFileTree, formatFileSize } from './fileTreeUtils';
import type { FileTreeNode } from '../types/types';

const tree: FileTreeNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [
      {
        name: 'utils',
        path: 'src/utils',
        type: 'directory',
        children: [{ name: 'format.ts', path: 'src/utils/format.ts', type: 'file' }],
      },
      { name: 'index.ts', path: 'src/index.ts', type: 'file' },
    ],
  },
  { name: 'README.md', path: 'README.md', type: 'file' },
];

test('filterFileTree keeps ancestors of matches and drops unrelated branches', () => {
  const filtered = filterFileTree(tree, 'format');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, 'src');
  assert.equal(filtered[0].children?.length, 1);
  assert.equal(filtered[0].children?.[0].name, 'utils');
  assert.equal(filtered[0].children?.[0].children?.[0].name, 'format.ts');
});

test('formatFileSize formats bytes', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(undefined), '0 B');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
});
