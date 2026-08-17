import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenCodeProviderModels } from '@/modules/providers/list/opencode/opencode-models.provider.js';

test('opencode models provider builds catalog from `opencode models`', async () => {
  const provider = new OpenCodeProviderModels();
  const def = await provider.getSupportedModels();
  assert.ok(def.OPTIONS.length > 0);
  assert.ok(def.OPTIONS.every((o) => o.value.includes('/')));
  assert.ok(def.DEFAULT.includes('/'));
});

test('opencode models provider falls back to static catalog on spawn failure', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const provider = new OpenCodeProviderModels();
    const def = await provider.getSupportedModels();
    assert.ok(def.OPTIONS.length > 0);
  } finally {
    process.env.PATH = originalPath;
  }
});
