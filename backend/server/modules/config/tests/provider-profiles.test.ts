import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppConfig } from '../config.js';
import {
  PROFILE_FIELDS,
  UnknownProfileError,
  applyProfileSelections,
  snapshotProviderFields,
  validateProfileName,
} from '../provider-profiles.js';

function tmpCfg() {
  return createAppConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-pp-')) });
}

test('PROFILE_FIELDS has an entry for every provider we ship profiles for', () => {
  assert.deepStrictEqual(Object.keys(PROFILE_FIELDS).sort(), ['claude', 'codex', 'dsh', 'opencode', 'qoder']);
  assert.deepStrictEqual(PROFILE_FIELDS.claude, [
    'baseUrl', 'apiKey', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel',
  ]);
});

test('snapshotProviderFields copies only whitelisted fields, by value', () => {
  const cfg = tmpCfg();
  cfg.update({
    providers: {
      claude: { baseUrl: 'https://a.example', apiKey: 'sk-real', defaultModel: 'm1' },
    },
  });

  const snap = snapshotProviderFields(cfg.get(), 'claude');

  assert.strictEqual(snap.baseUrl, 'https://a.example');
  assert.strictEqual(snap.apiKey, 'sk-real');
  assert.strictEqual(snap.defaultModel, 'm1');
  // 白名单外的字段一个都不带
  assert.ok(!('cliPath' in snap));
  assert.ok(!('disableThinkingModels' in snap));
});

test('snapshotProviderFields deep-copies (mutating the snapshot does not touch config)', () => {
  const cfg = tmpCfg();
  cfg.update({ providers: { opencode: { apiKeys: { OPENAI_API_KEY: 'sk-o' } } } });

  const snap = snapshotProviderFields(cfg.get(), 'opencode');
  (snap.apiKeys as Record<string, string>).OPENAI_API_KEY = 'mutated';

  assert.strictEqual(cfg.get().providers.opencode.apiKeys.OPENAI_API_KEY, 'sk-o');
});

test('validateProfileName rejects empty/whitespace/too-long names', () => {
  assert.strictEqual(validateProfileName('  主账号  '), null);
  assert.strictEqual(validateProfileName(''), 'name is required');
  assert.strictEqual(validateProfileName('   '), 'name is required');
  assert.strictEqual(validateProfileName(undefined), 'name is required');
  assert.strictEqual(validateProfileName('x'.repeat(41)), 'name must be at most 40 characters');
  assert.strictEqual(validateProfileName('x'.repeat(40)), null);
});

test('applyProfileSelections leaves a body without selections untouched', () => {
  const cfg = tmpCfg();
  const body = { providers: { claude: { baseUrl: 'https://new.example' } } };
  assert.deepStrictEqual(applyProfileSelections(cfg, body), body);
});

test('applyProfileSelections skips empty-string selections (custom)', () => {
  const cfg = tmpCfg();
  const body = {
    providers: { claude: { baseUrl: 'https://new.example' } },
    activeProviderProfiles: { claude: '' },
  };
  assert.deepStrictEqual(applyProfileSelections(cfg, body), body);
});

test("applyProfileSelections uses the profile's REAL key when the body carries the masked one", () => {
  const cfg = tmpCfg();
  cfg.update({
    providers: { claude: { apiKey: 'sk-active-key-zzzzzz', baseUrl: 'https://active.example', defaultModel: 'active-model' } },
    providerProfiles: {
      claude: {
        p_a: {
          name: 'A',
          values: { apiKey: 'sk-profile-key-aaaaaa', baseUrl: 'https://profile.example', defaultModel: 'profile-model' },
        },
      },
    },
  });

  // 客户端重发 GET 的打码串（含 **** 的已被 stripMaskedPlaceholders 变成 undefined，
  // 这里直接模拟 strip 之后的结果：键在、值是 undefined）。
  const resolved = applyProfileSelections(cfg, {
    providers: { claude: { apiKey: undefined, defaultModel: 'model-i-typed' } },
    activeProviderProfiles: { claude: 'p_a' },
  }) as { providers: { claude: Record<string, unknown> } };

  const claude = resolved.providers.claude;
  assert.strictEqual(claude.apiKey, 'sk-profile-key-aaaaaa'); // 档里的真值勝出（undefined 不覆盖）
  assert.strictEqual(claude.baseUrl, 'https://profile.example'); // body 没提这个字段 → 档值
  assert.strictEqual(claude.defaultModel, 'model-i-typed'); // body 显式给了 → body 勝出
});

test('applyProfileSelections keeps a real key the user typed over the profile one', () => {
  const cfg = tmpCfg();
  cfg.update({
    providers: { claude: { apiKey: 'sk-active-key-zzzzzz' } },
    providerProfiles: { claude: { p_a: { name: 'A', values: { apiKey: 'sk-profile-key-aaaaaa' } } } },
  });

  const resolved = applyProfileSelections(cfg, {
    providers: { claude: { apiKey: 'sk-brand-new-key-bbbbbb' } },
    activeProviderProfiles: { claude: 'p_a' },
  }) as { providers: { claude: { apiKey: string } } };

  assert.strictEqual(resolved.providers.claude.apiKey, 'sk-brand-new-key-bbbbbb');
});

test('applyProfileSelections throws on an unknown profile id (never silently ignores)', () => {
  const cfg = tmpCfg();
  assert.throws(
    () => applyProfileSelections(cfg, { activeProviderProfiles: { claude: 'p_nope' } }),
    (err: unknown) => err instanceof UnknownProfileError && (err as UnknownProfileError).id === 'p_nope',
  );
});
