import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';

const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];

/**
 * Whether an `opencode` binary is actually available to this host. The auth
 * provider must report exactly this value regardless of how the credential
 * lookup resolves, so tests stay green with and without the CLI installed.
 */
const opencodeBinaryOnHost = (): boolean => {
  const result = spawnSync('opencode', ['--version'], { stdio: 'ignore', timeout: 5000 });
  return !result.error && result.status === 0;
};

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

const patchEnvCredentials = (value: string | undefined): (() => void) => {
  const previous: Record<string, string | undefined> = {};
  for (const key of OPENCODE_ENV_CREDENTIAL_KEYS) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const key of OPENCODE_ENV_CREDENTIAL_KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  };
};

/**
 * Points LOVDEX_DATA_DIR at an ephemeral temp dir so the process-wide
 * appConfig() singleton (created on first call from a provider under test)
 * never reads the operator's real ~/.lovdex/data/app.config.json. Returns a
 * restore fn for the finally block.
 */
const isolateDataDir = (): (() => void) => {
  const saved = process.env.LOVDEX_DATA_DIR;
  process.env.LOVDEX_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'lovdex-auth-'));
  return () => {
    if (saved === undefined) delete process.env.LOVDEX_DATA_DIR;
    else process.env.LOVDEX_DATA_DIR = saved;
  };
};

test('opencode auth reports installed+authenticated when auth.json has providers', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-auth-'));
  const authDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(path.join(authDir, 'auth.json'), JSON.stringify({ sophnet: { type: 'api', key: 'sk-x' } }), 'utf8');
  const restoreDataDir = isolateDataDir();
  const restore = patchHomeDir(tempRoot);
  const restoreEnv = patchEnvCredentials(undefined);
  try {
    const status = await new OpenCodeProviderAuth().getStatus();
    assert.equal(status.provider, 'opencode');
    assert.equal(status.installed, opencodeBinaryOnHost());
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_file');
    assert.equal(status.email, 'sophnet credentials');
  } finally {
    restoreEnv();
    restore();
    restoreDataDir();
  }
});

test('opencode auth reports not authenticated when auth.json is missing and no env credentials', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-auth-'));
  const restoreDataDir = isolateDataDir();
  const restore = patchHomeDir(tempRoot);
  const restoreEnv = patchEnvCredentials(undefined);
  try {
    const status = await new OpenCodeProviderAuth().getStatus();
    assert.equal(status.provider, 'opencode');
    assert.equal(status.authenticated, false);
    assert.equal(status.method, null);
    assert.equal(status.error, 'OpenCode not configured');
  } finally {
    restoreEnv();
    restore();
    restoreDataDir();
  }
});

test('opencode auth authenticates via a provider API-key env var when auth.json is missing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-auth-'));
  const restoreDataDir = isolateDataDir();
  const restore = patchHomeDir(tempRoot);
  const restoreEnv = patchEnvCredentials('sk-test-env');
  try {
    const status = await new OpenCodeProviderAuth().getStatus();
    // OPENCODE_ENV_CREDENTIAL_KEYS is scanned in order, so the first key
    // (ANTHROPIC_API_KEY) reports as the environment credential source.
    assert.equal(status.provider, 'opencode');
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'environment');
    assert.equal(status.email, OPENCODE_ENV_CREDENTIAL_KEYS[0]);
  } finally {
    restoreEnv();
    restore();
    restoreDataDir();
  }
});
