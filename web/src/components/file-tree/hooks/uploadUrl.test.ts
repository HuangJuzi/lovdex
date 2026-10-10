import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUploadUrl } from './useFileTreeUpload';

test('buildUploadUrl omits targetPath when empty (project root)', () => {
  assert.equal(buildUploadUrl('p 1', ''), '/api/projects/p%201/files/upload');
});

test('buildUploadUrl encodes targetPath into the query string', () => {
  assert.equal(
    buildUploadUrl('p1', 'deep/nested dir'),
    '/api/projects/p1/files/upload?targetPath=deep%2Fnested%20dir',
  );
});
