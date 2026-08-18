import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveClawCredentials,
  getCredentialStatus,
  writeCredFile,
} from '@/modules/operators/credential-resolver.js';

function tmpCredFile(contents: string, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-cred-'));
  const file = path.join(dir, 'cred.json');
  fs.writeFileSync(file, contents, { mode });
  return file;
}

test('resolves the required trio from the cred file (alias keys)', () => {
  const credFile = tmpCredFile(
    JSON.stringify({ claw_jwt: 'file-jwt', AGENT_ID: 'file-agent', creator_user_id: 'file-user' }),
  );
  const creds = resolveClawCredentials({ credFile });
  assert.deepEqual(creds, { CLAW_JWT: 'file-jwt', APP_AGENT_ID: 'file-agent', CLAW_USER_ID: 'file-user' });
});

test('env vars are IGNORED — the cred file is the only source', () => {
  const credFile = tmpCredFile(JSON.stringify({ jwt: 'file-jwt', agent_id: 'a', user_id: 'u' }));
  const prev = { ...process.env };
  process.env.CLAW_JWT = 'env-jwt-should-be-ignored';
  try {
    const creds = resolveClawCredentials({ credFile });
    assert.equal(creds.CLAW_JWT, 'file-jwt');
  } finally {
    process.env = prev;
  }
});

test('env vars alone do NOT satisfy credentials (file-only policy)', () => {
  const prev = { ...process.env };
  process.env.CLAW_JWT = 'env-jwt';
  process.env.APP_AGENT_ID = 'env-agent';
  process.env.CLAW_USER_ID = 'env-user';
  try {
    assert.throws(
      () => resolveClawCredentials({ credFile: '/nonexistent/cred.json' }),
      /credentials unavailable/,
    );
  } finally {
    process.env = prev;
  }
});

test('optional target fields are injected when present, absent otherwise', () => {
  const withTarget = tmpCredFile(
    JSON.stringify({ jwt: 'j', agent_id: 'a', user_id: 'u', target_rid: 'r123', target_group_name: 'RDT' }),
  );
  const creds = resolveClawCredentials({ credFile: withTarget });
  assert.equal(creds.TARGET_RID, 'r123');
  assert.equal(creds.TARGET_GROUP_NAME, 'RDT');

  const without = tmpCredFile(JSON.stringify({ jwt: 'j', agent_id: 'a', user_id: 'u' }));
  const creds2 = resolveClawCredentials({ credFile: without });
  assert.equal(creds2.TARGET_RID, undefined);
  assert.equal(creds2.TARGET_GROUP_NAME, undefined);
});

test('throws a readable error (no values) when fields are missing', () => {
  assert.throws(
    () => resolveClawCredentials({ credFile: '/nonexistent/cred.json' }),
    (e: Error) => {
      assert.match(e.message, /credentials unavailable/);
      assert.match(e.message, /jwt/);
      assert.match(e.message, /不走环境变量/);
      return true;
    },
  );
});

test('malformed cred file is treated as absent', () => {
  const credFile = tmpCredFile('not json{');
  assert.throws(() => resolveClawCredentials({ credFile }), /credentials unavailable/);
});

test('permissive cred file mode still resolves (warn-only, non-fatal)', () => {
  const credFile = tmpCredFile(JSON.stringify({ jwt: 'j', agent_id: 'a', user_id: 'u' }), 0o644);
  const creds = resolveClawCredentials({ credFile });
  assert.equal(creds.CLAW_JWT, 'j');
});

test('getCredentialStatus reports presence booleans only, source file|none', () => {
  const credFile = tmpCredFile(
    JSON.stringify({ jwt: 'secret-jwt', agent_id: 'a', user_id: 'u', target_rid: 'r1' }),
  );
  const status = getCredentialStatus({ credFile });
  assert.equal(status.source, 'file');
  assert.deepEqual(status.fields, {
    jwt: true,
    agentId: true,
    userId: true,
    targetRid: true,
    targetGroupName: false,
  });
  assert.ok(!JSON.stringify(status).includes('secret-jwt'));

  const none = getCredentialStatus({ credFile: '/nonexistent/cred.json' });
  assert.equal(none.source, 'none');
  assert.equal(none.fields.jwt, false);
});

test('writeCredFile writes 0600 and merges optional target fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-cred-write-'));
  const credFile = path.join(dir, '.claw', 'cred.json');
  writeCredFile({ jwt: 'j1', agentId: 'a1', userId: 'u1', targetRid: 'r1', targetGroupName: 'RDT' }, credFile);
  assert.equal((fs.statSync(credFile).mode & 0o777).toString(8), '600');
  let parsed = JSON.parse(fs.readFileSync(credFile, 'utf8')) as Record<string, string>;
  assert.equal(parsed.jwt, 'j1');
  assert.equal(parsed.target_rid, 'r1');
  assert.equal(parsed.target_group_name, 'RDT');

  // Re-save without target fields: previous target config is preserved.
  writeCredFile({ jwt: 'j2', agentId: 'a2', userId: 'u2' }, credFile);
  parsed = JSON.parse(fs.readFileSync(credFile, 'utf8')) as Record<string, string>;
  assert.equal(parsed.jwt, 'j2');
  assert.equal(parsed.target_rid, 'r1');
});

test('writeCredFile rejects incomplete payloads', () => {
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-cred-x-')), 'cred.json');
  assert.throws(() => writeCredFile({ jwt: 'only', agentId: '', userId: '' }, credFile), /必填/);
  assert.equal(fs.existsSync(credFile), false);
});
