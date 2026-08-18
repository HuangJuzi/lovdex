import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveClawCredentials } from '@/modules/operators/credential-resolver.js';

function tmpCredFile(contents: string, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-cred-'));
  const file = path.join(dir, 'cred.json');
  fs.writeFileSync(file, contents, { mode });
  return file;
}

test('env credentials win over the cred file', () => {
  const credFile = tmpCredFile(JSON.stringify({ jwt: 'file-jwt', agent_id: 'file-agent', user_id: 'file-user' }));
  const creds = resolveClawCredentials({
    env: { CLAW_JWT: 'env-jwt', APP_AGENT_ID: 'env-agent', CLAW_USER_ID: 'env-user' },
    credFile,
  });
  assert.deepEqual(creds, { CLAW_JWT: 'env-jwt', APP_AGENT_ID: 'env-agent', CLAW_USER_ID: 'env-user' });
});

test('missing env fields fall back to the cred file (alias keys)', () => {
  const credFile = tmpCredFile(
    JSON.stringify({ claw_jwt: 'file-jwt', AGENT_ID: 'file-agent', creator_user_id: 'file-user' }),
  );
  const creds = resolveClawCredentials({ env: {}, credFile });
  assert.deepEqual(creds, { CLAW_JWT: 'file-jwt', APP_AGENT_ID: 'file-agent', CLAW_USER_ID: 'file-user' });
});

test('mixed sources: env jwt + file agent/user', () => {
  const credFile = tmpCredFile(JSON.stringify({ agent_id: 'file-agent', user_id: 'file-user' }));
  const creds = resolveClawCredentials({ env: { CLAW_JWT: 'env-jwt' }, credFile });
  assert.deepEqual(creds, { CLAW_JWT: 'env-jwt', APP_AGENT_ID: 'file-agent', CLAW_USER_ID: 'file-user' });
});

test('throws a readable error (no values) when fields are missing', () => {
  assert.throws(
    () => resolveClawCredentials({ env: {}, credFile: '/nonexistent/cred.json' }),
    (e: Error) => {
      assert.match(e.message, /credentials unavailable/);
      assert.match(e.message, /CLAW_JWT/);
      return true;
    },
  );
});

test('malformed cred file is treated as absent', () => {
  const credFile = tmpCredFile('not json{');
  assert.throws(() => resolveClawCredentials({ env: {}, credFile }), /credentials unavailable/);
});

test('permissive cred file mode still resolves (warn-only, non-fatal)', () => {
  const credFile = tmpCredFile(JSON.stringify({ jwt: 'j', agent_id: 'a', user_id: 'u' }), 0o644);
  const creds = resolveClawCredentials({ env: {}, credFile });
  assert.equal(creds.CLAW_JWT, 'j');
});
