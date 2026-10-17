import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('the catalog carries the live-verified deepseek-official routes', async () => {
  // 2026-10-16 probe of a real `dsh --profile acp` session/new configOptions:
  // the deepseek-official group serves deepseek-v4-flash, deepseek-flash
  // (DeepSeek V41 Flash), and deepseek-v4-pro. The cold-path picker must be
  // able to select all three.
  const def = await new DshProviderModels().getSupportedModels();
  const values = def.OPTIONS.map((o) => o.value);
  for (const route of [
    '["deepseek-official","deepseek-v4-flash"]',
    '["deepseek-official","deepseek-flash"]',
    '["deepseek-official","deepseek-v4-pro"]',
  ]) {
    assert.ok(values.includes(route), `catalog must include ${route}`);
  }
});

test('getCurrentActiveModel returns the catalog default', async () => {
  const current = await new DshProviderModels().getCurrentActiveModel();
  assert.equal(current.model, DSH_PREDEFINED_MODELS.DEFAULT);
});

test('changeActiveModel delegates to the shared session-override writer', async () => {
  // changeActiveModel has no filePath/injection seam, so it writes the shared
  // session-override cache under ~/.cloudcli. Point HOME at a throwaway dir for
  // the duration of this test so it can never touch the real user's file.
  const fakeHome = await mkdtemp(path.join(tmpdir(), 'dsh-models-home-'));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const result = await new DshProviderModels().changeActiveModel({
      sessionId: 'sess-1',
      model: 'deepseek-v4-pro',
    });
    assert.equal(result.provider, 'dsh');
  } finally {
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    await rm(fakeHome, { recursive: true, force: true });
  }
});
