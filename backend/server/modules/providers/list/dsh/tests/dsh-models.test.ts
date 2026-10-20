import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Hermetic config: point the app.config singleton at a temp dir BEFORE the
// provider module is imported. getSupportedModels reads app.config on every
// call, so without this the developer's real model list would leak in.
const dataDir = mkdtempSync(path.join(tmpdir(), 'lovdex-dsh-models-'));
process.env.LOVDEX_DATA_DIR = dataDir;

const { DSH_BUILTIN_MODELS, DshProviderModels } = await import(
  '@/modules/providers/list/dsh/dsh-models.provider.js'
);

test('getSupportedModels returns at least a DEFAULT and options', async () => {
  const def = await new DshProviderModels().getSupportedModels();
  assert.ok(def.OPTIONS.length >= 1);
  assert.ok(def.OPTIONS.some((o) => o.value === def.DEFAULT));
});

test('no built-in vendor models: an unconfigured catalog is only the default slot', async () => {
  // 2026-10-20: the DeepSeek entries were removed. Model ids belong to the
  // endpoint the active profile points at; serving one vendor's ids to a
  // deployment configured for another made the picker misleading.
  const def = await new DshProviderModels().getSupportedModels();
  assert.deepStrictEqual(def.OPTIONS.map((o) => o.value), [DSH_BUILTIN_MODELS.DEFAULT]);
});

test('getCurrentActiveModel returns the catalog default', async () => {
  const current = await new DshProviderModels().getCurrentActiveModel();
  assert.equal(current.model, DSH_BUILTIN_MODELS.DEFAULT);
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
