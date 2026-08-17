import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Hermetic config: point the app.config singleton at a temp dir BEFORE the
// provider module is imported (its module top level must not touch appConfig —
// enforced by this test). Each node --test file runs in its own process.
const dataDir = mkdtempSync(path.join(tmpdir(), 'lovdex-claude-cfg-'));
process.env.LOVDEX_DATA_DIR = dataDir;

const { appConfig } = await import('@/modules/config/config.js');
const { getClaudeFallbackModels, ClaudeProviderModels } = await import('../claude-models.provider.js');

test('model options rebuild from current app.config on each call', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      claude: {
        defaultModel: 'model-a',
        opusModel: 'opus-b',
        sonnetModel: 'sonnet-c',
        haikuModel: 'haiku-d',
      },
    },
  });

  const first = getClaudeFallbackModels();
  const values = new Set(first.OPTIONS.map((o) => o.value));
  assert.ok(values.has('default'));
  assert.ok(values.has('opus'));
  assert.ok(values.has('sonnet'));
  assert.ok(values.has('haiku'));
  assert.ok(values.has('model-a')); // trailing "Custom model" entry for defaultModel
  assert.strictEqual(first.OPTIONS.find((o) => o.value === 'opus')?.label, 'opus-b');
  assert.strictEqual(first.OPTIONS.find((o) => o.value === 'haiku')?.label, 'haiku-d');
  assert.strictEqual(first.DEFAULT, 'default');

  // same dynamic source drives getSupportedModels (what the UI dropdown hits)
  const provider = new ClaudeProviderModels();
  const supported = await provider.getSupportedModels();
  assert.strictEqual(supported.OPTIONS.find((o) => o.value === 'sonnet')?.label, 'sonnet-c');

  // a config save changes the list immediately — no restart/reload
  cfg.update({ providers: { claude: { sonnetModel: 'sonnet-9' } } });
  const after = getClaudeFallbackModels();
  assert.strictEqual(after.OPTIONS.find((o) => o.value === 'sonnet')?.label, 'sonnet-9');
});
