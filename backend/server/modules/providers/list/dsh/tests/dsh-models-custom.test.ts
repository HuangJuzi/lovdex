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
const { DshProviderModels, DSH_PREDEFINED_MODELS, buildDshCustomModelOptions } = await import('../dsh-models.provider.js');

test('non-empty customModels replaces the DeepSeek entries, keeping the default slot', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: { customModels: ['deepseek-official|glm-5.3', 'sophnet|kimi-k2|Kimi K2', ' deepseek-official | spaced-model '] },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();
  const values = def.OPTIONS.map((o) => o.value);

  // 替换语义：default 槽位 + 该档自己的条目，DeepSeek 预定义 3 项不再混入
  assert.deepStrictEqual(values, [
    'default',
    '["deepseek-official","glm-5.3"]',
    '["sophnet","kimi-k2"]',
    '["deepseek-official","spaced-model"]',
  ]);

  const glm = def.OPTIONS.find((o) => o.value === '["deepseek-official","glm-5.3"]');
  assert.ok(glm, 'expected the glm-5.3 option');
  assert.strictEqual(glm.label, 'glm-5.3'); // 无第三段 → label 缺省用 model 名
  assert.strictEqual(glm.description, 'deepseek-official');
  assert.deepStrictEqual(glm.effort?.values.map((v) => v.value), ['off', 'low', 'high', 'max']);

  const kimi = def.OPTIONS.find((o) => o.value === '["sophnet","kimi-k2"]');
  assert.ok(kimi, 'expected the kimi-k2 option');
  assert.strictEqual(kimi.label, 'Kimi K2'); // 第三段 → 自定义 label
  assert.strictEqual(kimi.description, 'sophnet');

  // label 段纯空格 → 回退用 model 名；同 [route, model] 两条（有无 label）只出一条
  assert.deepStrictEqual(
    buildDshCustomModelOptions(['route|m|   ', 'route|m', 'other|x']),
    [
      { value: '["route","m"]', label: 'm', description: 'route', effort: DSH_PREDEFINED_MODELS.OPTIONS[0].effort },
      { value: '["other","x"]', label: 'x', description: 'other', effort: DSH_PREDEFINED_MODELS.OPTIONS[0].effort },
    ],
  );

  // DEFAULT 不受 customModels 影响
  assert.strictEqual(def.DEFAULT, 'default');
});

test('malformed customModels entries are skipped, not fatal', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: {
        customModels: [
          '',                    // 空行
          'only-one-segment',    // 少于 2 段
          '|model-no-route',     // route 段为空
          'route-no-model|',     // model 段为空
          'deepseek-official|fine-model', // 合法
        ],
      },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();
  const values = def.OPTIONS.map((o) => o.value);

  // 垃圾条目不拖垮合法条目：替换模式下列表 = default + 合法条目
  assert.deepStrictEqual(values, ['default', '["deepseek-official","fine-model"]']);
});

test('config save changes the list immediately — no restart', async () => {
  const cfg = appConfig();
  cfg.update({ providers: { dsh: { customModels: ['deepseek-official|glm-5.3'] } } });
  const before = await new DshProviderModels().getSupportedModels();
  assert.ok(before.OPTIONS.some((o) => o.value === '["deepseek-official","glm-5.3"]'));

  cfg.update({ providers: { dsh: { customModels: ['sophnet|kimi-k2'] } } });
  const after = await new DshProviderModels().getSupportedModels();
  assert.ok(!after.OPTIONS.some((o) => o.value === '["deepseek-official","glm-5.3"]'));
  assert.ok(after.OPTIONS.some((o) => o.value === '["sophnet","kimi-k2"]'));
});

test('an empty or absent customModels leaves exactly the predefined list', async () => {
  const cfg = appConfig();
  cfg.update({ providers: { dsh: { customModels: [] } } });
  const def = await new DshProviderModels().getSupportedModels();
  assert.deepStrictEqual(
    def.OPTIONS.map((o) => o.value),
    DSH_PREDEFINED_MODELS.OPTIONS.map((o) => o.value),
  );
  // absent（undefined）分支直测
  assert.deepStrictEqual(buildDshCustomModelOptions(undefined), []);
});
