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
  profileNameTaken,
  snapshotProviderFields,
  validateProfileName,
} from '../provider-profiles.js';

function tmpCfg() {
  return createAppConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-pp-')) });
}

test('PROFILE_FIELDS has an entry for every provider we ship profiles for', () => {
  assert.deepStrictEqual(Object.keys(PROFILE_FIELDS).sort(), ['claude', 'codex', 'dsh', 'opencode', 'qoder']);
  // oneMillionModels 必须在内：它是按平台而异的能力位，漏了会静默丢字段
  assert.deepStrictEqual(PROFILE_FIELDS.claude, [
    'baseUrl', 'apiKey', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel', 'oneMillionModels',
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

test('dsh PROFILE_FIELDS includes customModels (dropping it would silently lose the list per-profile)', () => {
  assert.deepStrictEqual(PROFILE_FIELDS.dsh, ['baseUrl', 'apiKey', 'customModels']);
});

test('snapshotProviderFields carries dsh customModels by value', () => {
  const cfg = tmpCfg();
  cfg.update({
    providers: { dsh: { baseUrl: 'https://x', customModels: ['deepseek-official|glm-5.3'] } },
  });

  const snap = snapshotProviderFields(cfg.get(), 'dsh');
  assert.deepStrictEqual(snap.customModels, ['deepseek-official|glm-5.3']);

  (snap.customModels as string[]).push('mutated');
  assert.deepStrictEqual(
    cfg.get().providers.dsh.customModels,
    ['deepseek-official|glm-5.3'],
    'snapshot must be a copy, not a reference',
  );
});

test('validateProfileName rejects empty/whitespace/too-long names', () => {
  assert.strictEqual(validateProfileName('  主账号  '), null);
  assert.strictEqual(validateProfileName(''), 'name is required');
  assert.strictEqual(validateProfileName('   '), 'name is required');
  assert.strictEqual(validateProfileName(undefined), 'name is required');
  assert.strictEqual(validateProfileName('x'.repeat(41)), 'name must be at most 40 characters');
  assert.strictEqual(validateProfileName('x'.repeat(40)), null);
});

test('profileNameTaken is trim-insensitive, case-sensitive, per-provider, and can exclude self', () => {
  const cfg = tmpCfg();
  cfg.update({
    providerProfiles: {
      claude: { p_a: { name: 'Main', values: {} }, p_b: { name: '其它', values: {} } },
      qoder: { p_q: { name: 'Main', values: {} } },
    },
  });
  const c = cfg.get();

  assert.strictEqual(profileNameTaken(c, 'claude', 'Main'), true);
  assert.strictEqual(profileNameTaken(c, 'claude', '  Main  '), true); // trim 后同名
  assert.strictEqual(profileNameTaken(c, 'claude', 'main'), false); // 大小写敏感
  assert.strictEqual(profileNameTaken(c, 'claude', '没这个'), false);
  // 重名只在同一个 provider 内算重
  assert.strictEqual(profileNameTaken(c, 'qoder', 'Main'), true);
  assert.strictEqual(profileNameTaken(c, 'codex', 'Main'), false); // 该 provider 下没桶
  // excludeId 只排除自己，不放过别人
  assert.strictEqual(profileNameTaken(c, 'claude', 'Main', 'p_a'), false);
  assert.strictEqual(profileNameTaken(c, 'claude', '其它', 'p_a'), true);
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

test('applyProfileSelections handles several providers in one body', () => {
  const cfg = tmpCfg();
  cfg.update({
    providerProfiles: {
      claude: { p_c: { name: 'C', values: { apiKey: 'sk-claude' } } },
      qoder: { p_q: { name: 'Q', values: { personalAccessToken: 'pat-qoder' } } },
    },
  });

  const resolved = applyProfileSelections(cfg, {
    providers: { qoder: { personalAccessToken: 'typed-pat' } },
    activeProviderProfiles: { claude: 'p_c', qoder: 'p_q' },
  }) as { providers: Record<string, Record<string, unknown>> };

  assert.strictEqual(resolved.providers.claude.apiKey, 'sk-claude'); // body 里没有 claude → 档值
  assert.strictEqual(resolved.providers.qoder.personalAccessToken, 'typed-pat'); // body 显式覆盖
});

test('applyProfileSelections ignores non-string / empty ids', () => {
  const cfg = tmpCfg();
  const body = { providers: { claude: { baseUrl: 'https://x.example' } } };
  for (const bad of ['', null, 7, { id: 'p_a' }] as unknown[]) {
    const withBad = { ...body, activeProviderProfiles: { claude: bad } };
    assert.deepStrictEqual(applyProfileSelections(cfg, withBad), withBad);
  }
});

test('applyProfileSelections rejects reserved provider names instead of polluting providers', () => {
  const cfg = tmpCfg();
  // 字面量 `__proto__:` 会改原型，所以保留名用例必须用**计算键**构造自己的属性。
  const reserved: Array<Record<string, unknown>> = [
    { ['__proto__']: 'p_x' },
    { constructor: 'p_x' },
    { prototype: 'p_x' },
  ];
  for (const selection of reserved) {
    assert.throws(
      () => applyProfileSelections(cfg, { activeProviderProfiles: selection }),
      UnknownProfileError,
    );
  }

  // providers 对象本身没被污染
  const resolved = applyProfileSelections(cfg, {
    providers: { claude: { baseUrl: 'https://x.example' } },
    activeProviderProfiles: { claude: '' },
  }) as { providers: Record<string, unknown> };
  assert.strictEqual(Object.getPrototypeOf(resolved.providers), Object.prototype);
});

test('applyProfileSelections rejects a provider that has a store bucket but is not in the whitelist', () => {
  const cfg = tmpCfg();
  // 手改 app.config.json 塞了一个白名单外的桶：没有 isKnownProvider 守卫时，
  // profile 查得到 → providers['evil'] 会被真的写进去，这个用例就会失败。
  cfg.update({
    providerProfiles: { evil: { p_x: { name: 'E', values: { apiKey: 'sk-evil' } } } },
  });

  assert.throws(
    () => applyProfileSelections(cfg, { activeProviderProfiles: { evil: 'p_x' } }),
    UnknownProfileError,
  );
  // 而且没有被应用出去
  const resolved = applyProfileSelections(cfg, {
    providers: {},
    activeProviderProfiles: { evil: '' },
  }) as { providers: Record<string, unknown> };
  assert.strictEqual(resolved.providers.evil, undefined);
});
