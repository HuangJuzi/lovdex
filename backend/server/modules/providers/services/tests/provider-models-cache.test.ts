import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderModelsService } from '../provider-models.service.js';

test('dsh model lookups bypass the cache (config-derived, must reflect saves at once)', async (t) => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'lovdex-models-cache-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const cachePath = path.join(cacheDir, 'provider-models-cache.json');

  let callCount = 0;
  const service = createProviderModelsService({
    cachePath,
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => {
          callCount += 1;
          return { OPTIONS: [], DEFAULT: 'default' };
        },
      },
    }) as never,
  });

  await service.getProviderModels('dsh');
  await service.getProviderModels('dsh');
  assert.strictEqual(callCount, 2, 'dsh must hit the provider on every call');

  // 且不落盘：缓存文件不应被写出来
  assert.ok(!existsSync(cachePath), 'dsh lookups must not persist a cache entry');

  // 对照组：codex 仍走缓存（第二次调用复用第一次结果）
  let codexCalls = 0;
  const codexService = createProviderModelsService({
    cachePath,
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => {
          codexCalls += 1;
          return { OPTIONS: [], DEFAULT: 'default' };
        },
      },
    }) as never,
  });
  await codexService.getProviderModels('codex');
  await codexService.getProviderModels('codex');
  assert.strictEqual(codexCalls, 1, 'codex stays cached');
});
