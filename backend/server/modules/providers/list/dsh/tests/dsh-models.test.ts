import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DSH_PREDEFINED_MODELS,
  DshProviderModels,
} from '@/modules/providers/list/dsh/dsh-models.provider.js';

test('getSupportedModels returns at least a DEFAULT and options', async () => {
  const def = await new DshProviderModels().getSupportedModels();
  assert.ok(def.OPTIONS.length >= 1);
  assert.ok(def.OPTIONS.some((o) => o.value === def.DEFAULT));
});

test('getCurrentActiveModel returns the catalog default', async () => {
  const current = await new DshProviderModels().getCurrentActiveModel();
  assert.equal(current.model, DSH_PREDEFINED_MODELS.DEFAULT);
});
