import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeOutput } from '@/modules/operators/output-sanitizer.js';

test('sanitizer redacts JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = sanitizeOutput(`echoed header: ${jwt}`);
  assert.ok(!out.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'));
  assert.ok(!out.includes('eyJ1c2VySWQiOiJ1MTIzIn0'));
  assert.ok(out.includes('eyJ***REDACTED***'));
  // A JWT sitting under a sensitive key is still fully redacted.
  const keyed = sanitizeOutput(`token: ${jwt}`);
  assert.ok(!keyed.includes('eyJ1c2VySWQiOiJ1MTIzIn0'));
  assert.ok(keyed.includes('***REDACTED***'));
});

test('sanitizer redacts Bearer tokens', () => {
  const out = sanitizeOutput('Authorization: Bearer abcdef123456.token-value');
  assert.ok(!out.includes('abcdef123456'));
  assert.ok(out.includes('***REDACTED***'));
});

test('sanitizer redacts sensitive JSON/kv values', () => {
  const out = sanitizeOutput(
    '{"agentId": "a-secret-1", "user_id": "u-secret-2", "password": "p-secret-3", ok: true}',
  );
  assert.ok(!out.includes('a-secret-1'));
  assert.ok(!out.includes('u-secret-2'));
  assert.ok(!out.includes('p-secret-3'));
  assert.ok(out.includes('ok: true'));
});

test('sanitizer redacts token= / authorization: kv forms', () => {
  const out = sanitizeOutput('token=my-secret-token authorization: my-secret-auth');
  assert.ok(!out.includes('my-secret-token'));
  assert.ok(!out.includes('my-secret-auth'));
});

test('sanitizer truncates long output with a marker', () => {
  const out = sanitizeOutput('x'.repeat(9000), 100);
  assert.ok(out.length < 300);
  assert.match(out, /\[truncated \d+ chars\]/);
});

test('sanitizer leaves benign text untouched', () => {
  const text = '群列表：rid=r123 name=研发群, exit 0';
  assert.equal(sanitizeOutput(text), text);
});
