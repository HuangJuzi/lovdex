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

test('oneMillionModels appends non-slot models and tags slot matches', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      claude: {
        defaultModel: 'model-a',
        opusModel: 'opus-b',
        sonnetModel: 'sonnet-c',
        haikuModel: 'haiku-d',
        oneMillionModels: 'gpt-5.5, opus-b',
      },
    },
  });

  const { OPTIONS } = getClaudeFallbackModels();

  // gpt-5.5 matches no slot → appended as a standalone option.
  const gpt = OPTIONS.find((o) => o.value === 'gpt-5.5');
  assert.ok(gpt, 'expected a standalone gpt-5.5 option');
  assert.strictEqual(gpt?.label, 'gpt-5.5 [1m]');
  assert.strictEqual(gpt?.description, '1M context model');

  // opus-b matches the opus slot → tagged inline, not duplicated.
  assert.strictEqual(OPTIONS.find((o) => o.value === 'opus')?.label, 'opus-b [1m]');
  assert.strictEqual(
    OPTIONS.filter((o) => o.value === 'opus-b').length,
    0,
    'slot-matched model must not be appended as a duplicate',
  );
});
