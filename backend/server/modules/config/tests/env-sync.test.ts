import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppConfig } from '../config.js';
import { syncProviderEnv, OWNED_ANTHROPIC_ENV } from '../env-sync.js';

const TOUCHED_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CLI_PATH',
  'QODER_PERSONAL_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENCODE_BIN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
];

test('syncProviderEnv puts non-empty credentials into process.env', () => {
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir });
    cfg.update({
      providers: {
        claude: { apiKey: 'sk-ant-123', authToken: 'tok-456' },
        qoder: { personalAccessToken: 'qoder-pat' },
        opencode: { apiKeys: { ANTHROPIC_API_KEY: 'oc-key' } },
      },
    });
    delete process.env.OPENAI_API_KEY;
    syncProviderEnv(cfg.get());

    assert.strictEqual(process.env.ANTHROPIC_API_KEY, 'sk-ant-123');
    assert.strictEqual(process.env.ANTHROPIC_AUTH_TOKEN, 'tok-456');
    assert.strictEqual(process.env.QODER_PERSONAL_ACCESS_TOKEN, 'qoder-pat');
    // Only the key present in config.apiKeys gets written; others stay clear.
    assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('claude baseUrl/model fields write env authoritatively (+_NAME mirrors)', () => {
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir });
    cfg.update({
      providers: {
        claude: {
          baseUrl: 'https://proxy.example/anthropic',
          authToken: 'tok-1',
          defaultModel: 'model-default',
          haikuModel: 'model-haiku',
          opusModel: 'model-opus',
          sonnetModel: 'model-sonnet',
        },
      },
    });
    syncProviderEnv(cfg.get());

    assert.strictEqual(process.env.ANTHROPIC_BASE_URL, 'https://proxy.example/anthropic');
    assert.strictEqual(process.env.ANTHROPIC_AUTH_TOKEN, 'tok-1');
    assert.strictEqual(process.env.ANTHROPIC_MODEL, 'model-default');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'model-haiku');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, 'model-haiku');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'model-opus');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'model-opus');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'model-sonnet');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'model-sonnet');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('cleared claude fields DELETE owned env (config is the only source)', () => {
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    process.env.ANTHROPIC_BASE_URL = 'stale';
    process.env.ANTHROPIC_AUTH_TOKEN = 'stale';
    process.env.ANTHROPIC_MODEL = 'stale';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'stale';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = 'stale';
    process.env.CLAUDE_CLI_PATH = 'stale';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir }); // all claude fields default ''
    syncProviderEnv(cfg.get());

    assert.strictEqual(process.env.ANTHROPIC_BASE_URL, undefined);
    assert.strictEqual(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.strictEqual(process.env.ANTHROPIC_MODEL, undefined);
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, undefined);
    assert.strictEqual(process.env.CLAUDE_CLI_PATH, undefined);

    // apiKey is legacy non-empty-only: host value survives an empty config
    process.env.ANTHROPIC_API_KEY = 'host-key';
    syncProviderEnv(cfg.get());
    assert.strictEqual(process.env.ANTHROPIC_API_KEY, 'host-key');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('claude cliPath: custom value writes CLAUDE_CLI_PATH, default deletes', () => {
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir });
    cfg.update({ providers: { claude: { cliPath: '/opt/claude/bin/claude' } } });
    syncProviderEnv(cfg.get());
    assert.strictEqual(process.env.CLAUDE_CLI_PATH, '/opt/claude/bin/claude');

    cfg.update({ providers: { claude: { cliPath: 'claude' } } });
    syncProviderEnv(cfg.get());
    assert.strictEqual(process.env.CLAUDE_CLI_PATH, undefined);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('OWNED_ANTHROPIC_ENV lists all claude-owned env keys incl _NAME mirrors', () => {
  const expected = [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL', 'CLAUDE_CLI_PATH',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  ];
  assert.deepStrictEqual([...OWNED_ANTHROPIC_ENV].sort(), [...expected].sort());
  assert.strictEqual(OWNED_ANTHROPIC_ENV.length, 11);
});
