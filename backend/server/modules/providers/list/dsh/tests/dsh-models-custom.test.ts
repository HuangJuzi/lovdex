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
const { DshProviderModels, DSH_PREDEFINED_MODELS } = await import('../dsh-models.provider.js');

test('customModels entries are appended after the predefined list', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: { customModels: ['deepseek-official|glm-5.3', 'sophnet|kimi-k2|Kimi K2'] },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();
  const values = def.OPTIONS.map((o) => o.value);

  // 预定义 4 项在前、顺序不变
  assert.deepStrictEqual(
    values.slice(0, DSH_PREDEFINED_MODELS.OPTIONS.length),
    DSH_PREDEFINED_MODELS.OPTIONS.map((o) => o.value),
  );
  // 自定义条目用同款线格式，runner 原样下发
  assert.ok(values.includes('["deepseek-official","glm-5.3"]'));
  assert.ok(values.includes('["sophnet","kimi-k2"]'));

  const glm = def.OPTIONS.find((o) => o.value === '["deepseek-official","glm-5.3"]');
  assert.ok(glm, 'expected the glm-5.3 option');
  assert.strictEqual(glm.label, 'glm-5.3'); // 无第三段 → label 缺省用 model 名
  assert.strictEqual(glm.description, 'deepseek-official');
  assert.deepStrictEqual(glm.effort?.values.map((v) => v.value), ['off', 'low', 'high', 'max']);

  const kimi = def.OPTIONS.find((o) => o.value === '["sophnet","kimi-k2"]');
  assert.ok(kimi, 'expected the kimi-k2 option');
  assert.strictEqual(kimi.label, 'Kimi K2'); // 第三段 → 自定义 label
  assert.strictEqual(kimi.description, 'sophnet');

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

  assert.ok(values.includes('["deepseek-official","fine-model"]'));
  assert.ok(!values.some((v) => v.includes('only-one-segment')));
  assert.ok(!values.some((v) => v.includes('model-no-route')));
  assert.ok(!values.some((v) => v.includes('route-no-model')));
  // 垃圾条目不改变预定义列表
  assert.ok(values.includes('["deepseek-official","deepseek-v4-pro"]'));
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
});
