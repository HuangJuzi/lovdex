import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FILE_UPLOAD_COUNT,
  MAX_FILE_UPLOAD_SIZE,
  buildAttachmentPrefix,
  validateFileUpload,
} from './fileAttachments';

test('validateFileUpload accepts any type within size limit', () => {
  assert.equal(validateFileUpload({ name: 'app.log', size: 1024, type: 'text/plain' }).ok, true);
  assert.equal(validateFileUpload({ name: 'cfg.yaml', size: 0, type: 'application/x-yaml' }).ok, true);
  assert.equal(validateFileUpload({ name: 'blob.bin', size: MAX_FILE_UPLOAD_SIZE, type: 'application/octet-stream' }).ok, true);
});

test('validateFileUpload rejects oversized files', () => {
  const result = validateFileUpload({ name: 'huge.log', size: MAX_FILE_UPLOAD_SIZE + 1, type: 'text/plain' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /50 MB/);
  }
});

test('buildAttachmentPrefix joins absolute paths as [附件: ...] lines', () => {
  const prefix = buildAttachmentPrefix([
    { path: '/a/1.log' },
    { path: '/b/2.yaml' },
  ]);
  assert.equal(prefix, '[附件: /a/1.log]\n[附件: /b/2.yaml]');
});

test('buildAttachmentPrefix returns empty for no files', () => {
  assert.equal(buildAttachmentPrefix([]), '');
});
