import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FILE_UPLOAD_SIZE_BYTES,
  MAX_FILE_UPLOAD_SIZE_LABEL,
  MAX_FILE_UPLOAD_SIZE_MB,
} from './constants';

test('the single-file upload cap is 10GB', () => {
  assert.equal(MAX_FILE_UPLOAD_SIZE_MB, 10240);
  assert.equal(MAX_FILE_UPLOAD_SIZE_BYTES, 10240 * 1024 * 1024);
  assert.equal(MAX_FILE_UPLOAD_SIZE_LABEL, '10240MB');
});
