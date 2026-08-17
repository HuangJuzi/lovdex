import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppConfig } from '../config.js';
import { syncProviderEnv } from '../env-sync.js';

const TOUCHED_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CLI_PATH',
  'QODER_PERSONAL_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENCODE_BIN',
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