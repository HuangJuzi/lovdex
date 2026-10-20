import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Hermetic config: point the app.config singleton at a temp dir BEFORE the
// provider module is imported (mirrors claude-models-config.test.ts; each
// node --test file runs in its own process).
const dataDir = mkdtempSync(path.join(tmpdir(), 'lovdex-dsh-cfg-'));
process.env.LOVDEX_DATA_DIR = dataDir;

const { appConfig } = await import('@/modules/config/config.js');
const { DshProviderModels, DSH_BUILTIN_MODELS, buildDshCustomModelOptions } = await import('../dsh-models.provider.js');

test('one bare model per line becomes a deepseek-official picker option', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: { customModels: ['glm-5.3', '  DeepSeek-V4-Pro-0813  ', ''] },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();

  // default 槽位 + 每行一个模型；空白行跳过
  assert.deepStrictEqual(def.OPTIONS.map((o) => o.value), [
    'default',
    '["deepseek-official","glm-5.3"]',
    '["deepseek-official","DeepSeek-V4-Pro-0813"]',
  ]);

  const glm = def.OPTIONS.find((o) => o.value === '["deepseek-official","glm-5.3"]');
  assert.ok(glm, 'expected the glm-5.3 option');
  assert.strictEqual(glm.label, 'glm-5.3'); // 显示名就是模型名
  assert.strictEqual(glm.description, 'deepseek-official');
  assert.deepStrictEqual(glm.effort?.values.map((v) => v.value), ['off', 'low', 'high', 'max']);

  // DEFAULT 不受 customModels 影响
  assert.strictEqual(def.DEFAULT, 'default');
});

test('legacy route|model[|label] lines are still accepted', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: { customModels: ['sophnet|kimi-k2|Kimi K2', 'deepseek-official|glm-5.3'] },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();
  const kimi = def.OPTIONS.find((o) => o.value === '["sophnet","kimi-k2"]');
  assert.ok(kimi, 'expected the kimi-k2 option');
  assert.strictEqual(kimi.label, 'Kimi K2');
  assert.strictEqual(kimi.description, 'sophnet');
  assert.ok(def.OPTIONS.some((o) => o.value === '["deepseek-official","glm-5.3"]'));
});

test('blank and malformed legacy lines are skipped, not fatal', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: {
        customModels: [
          '',                // 空行
          '   ',             // 纯空格
          '|model-no-route', // legacy 格式 route 段为空
          'route-no-model|', // legacy 格式 model 段为空
          'fine-model',      // 合法
        ],
      },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();
  assert.deepStrictEqual(def.OPTIONS.map((o) => o.value), [
    'default',
    '["deepseek-official","fine-model"]',
  ]);
});

test('duplicate model ids yield one option', () => {
  // 同一 [route, model] 写两遍（或 bare 与 legacy 各写一遍）：pickers 按 value
  // 做 React key，重复项会炸渲染
  assert.deepStrictEqual(
    buildDshCustomModelOptions(['glm-5.3', 'deepseek-official|glm-5.3', 'other-model']),
    [
      { value: '["deepseek-official","glm-5.3"]', label: 'glm-5.3', description: 'deepseek-official', effort: DSH_BUILTIN_MODELS.OPTIONS[0].effort },
      { value: '["deepseek-official","other-model"]', label: 'other-model', description: 'deepseek-official', effort: DSH_BUILTIN_MODELS.OPTIONS[0].effort },
    ],
  );
});

test('config save changes the list immediately — no restart', async () => {
  const cfg = appConfig();
  cfg.update({ providers: { dsh: { customModels: ['glm-5.3'] } } });
  const before = await new DshProviderModels().getSupportedModels();
  assert.ok(before.OPTIONS.some((o) => o.value === '["deepseek-official","glm-5.3"]'));

  cfg.update({ providers: { dsh: { customModels: ['kimi-k2'] } } });
  const after = await new DshProviderModels().getSupportedModels();
  assert.ok(!after.OPTIONS.some((o) => o.value === '["deepseek-official","glm-5.3"]'));
  assert.ok(after.OPTIONS.some((o) => o.value === '["deepseek-official","kimi-k2"]'));
});

test('an empty or absent customModels leaves only the default slot', async () => {
  const cfg = appConfig();
  cfg.update({ providers: { dsh: { customModels: [] } } });
  const def = await new DshProviderModels().getSupportedModels();
  assert.deepStrictEqual(
    def.OPTIONS.map((o) => o.value),
    [DSH_BUILTIN_MODELS.DEFAULT],
  );
  // absent（undefined）分支直测
  assert.deepStrictEqual(buildDshCustomModelOptions(undefined), []);
});
