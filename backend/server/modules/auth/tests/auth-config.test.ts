import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { authConfig, isAuthEnabled, updateAuthCode } from '../auth.config.js';

// Credentials are read from the JSON config file — this test asserts the
// module picks up exactly what the file contains (so editing the file is what
// changes who can log in, not an env var).
const CONFIG_PATH = fileURLToPath(new URL('../auth.config.json', import.meta.url));
const fileCredentials = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
  email: string;
  code: string;
  jwtSecret: string;
};

test('authConfig credentials come from auth.config.json', () => {
  assert.equal(authConfig.email, fileCredentials.email);
  assert.equal(authConfig.code, fileCredentials.code);
  assert.equal(authConfig.jwtSecret, fileCredentials.jwtSecret);
  assert.equal(authConfig.expiresInSeconds, 7 * 24 * 60 * 60);
  assert.equal(authConfig.refreshWindowSeconds, 24 * 60 * 60);
});

test('isAuthEnabled is true by default and false when AUTH_ENABLED=false', () => {
  const original = process.env.AUTH_ENABLED;
  try {
    delete process.env.AUTH_ENABLED;
    assert.equal(isAuthEnabled(), true);
    process.env.AUTH_ENABLED = 'false';
    assert.equal(isAuthEnabled(), false);
    process.env.AUTH_ENABLED = 'true';
    assert.equal(isAuthEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});

test('updateAuthCode persists a new code and hot-updates memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lovdex-auth-'));
  const configPath = join(dir, 'auth.config.json');
  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({ email: authConfig.email, code: authConfig.code, jwtSecret: authConfig.jwtSecret }, null, 2)}\n`,
      'utf8'
    );
    const original = authConfig.code;
    try {
      const ok = updateAuthCode('newcode123', configPath);
      assert.equal(ok, true);
      assert.equal(authConfig.code, 'newcode123');
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as {
        code: string;
        email: string;
        jwtSecret: string;
      };
      assert.equal(persisted.code, 'newcode123');
      assert.equal(persisted.email, authConfig.email);
      assert.equal(persisted.jwtSecret, authConfig.jwtSecret);
    } finally {
      authConfig.code = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateAuthCode returns false and leaves memory unchanged on write failure', () => {
  const original = authConfig.code;
  try {
    const ok = updateAuthCode('whatever123', '/nonexistent/lovdex-auth-test/auth.config.json');
    assert.equal(ok, false);
    assert.equal(authConfig.code, original);
  } finally {
    authConfig.code = original;
  }
});
