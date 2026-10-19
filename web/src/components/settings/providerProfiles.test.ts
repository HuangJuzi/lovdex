import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORM_FIELDS,
  NO_PROFILE,
  buildConfigPutBody,
  findNewProfileId,
  isProfileModified,
  profileFormEntries,
  readSelections,
  selectionFor,
  withProfileBuckets,
} from './providerProfiles';

const CLIENT_PROFILE = {
  name: '主账号',
  values: {
    apiKey: 'sk-ant****abcdef',
    baseUrl: 'https://a.example',
    defaultModel: 'm1',
    opusModel: 'm2',
    sonnetModel: 'm3',
    haikuModel: 'm4',
  },
};

test('NO_PROFILE is an empty string, never null (backend deepMerge treats null as absent)', () => {
  assert.strictEqual(NO_PROFILE, '');
});

test('selectionFor falls back to NO_PROFILE for missing/empty markers', () => {
  assert.strictEqual(selectionFor({ claude: 'p_a' }, 'claude'), 'p_a');
  assert.strictEqual(selectionFor({ claude: '' }, 'claude'), NO_PROFILE);
  assert.strictEqual(selectionFor(undefined, 'claude'), NO_PROFILE);
  assert.strictEqual(selectionFor({}, 'codex'), NO_PROFILE);
});

test('readSelections fills every provider key', () => {
  assert.deepStrictEqual(readSelections({ activeProviderProfiles: { claude: 'p_a' } }), {
    claude: 'p_a',
    codex: '',
    opencode: '',
    qoder: '',
    dsh: '',
  });
  assert.deepStrictEqual(readSelections({}), { claude: '', codex: '', opencode: '', qoder: '', dsh: '' });
});

test('profileFormEntries returns only the form fields the profile carries as strings', () => {
  assert.deepStrictEqual(profileFormEntries(CLIENT_PROFILE, FORM_FIELDS.claude), [
    ['apiKey', 'sk-ant****abcdef'],
    ['baseUrl', 'https://a.example'],
    ['defaultModel', 'm1'],
    ['opusModel', 'm2'],
    ['sonnetModel', 'm3'],
    ['haikuModel', 'm4'],
  ]);
  // opencode 表单只渲染 binPath：apiKeys（对象）不该被塞进表单
  const opencode = { name: 'o', values: { binPath: '/usr/bin/opencode', apiKeys: { OPENAI_API_KEY: 'sk-o' } } };
  assert.deepStrictEqual(profileFormEntries(opencode, FORM_FIELDS.opencode), [['binPath', '/usr/bin/opencode']]);
});

test('isProfileModified compares only the form fields (masked values compare fine)', () => {
  const form = { apiKey: 'sk-ant****abcdef', baseUrl: 'https://a.example', defaultModel: 'm1' };
  assert.strictEqual(isProfileModified(form, CLIENT_PROFILE, FORM_FIELDS.claude), false);
  assert.strictEqual(
    isProfileModified({ ...form, defaultModel: 'typed' }, CLIENT_PROFILE, FORM_FIELDS.claude),
    true,
  );
  // 表单没渲染的字段不参与比对
  assert.strictEqual(isProfileModified(form, CLIENT_PROFILE, ['apiKey']), false);
});

test('regression: 表单渲染的每个字段都必须在 FORM_FIELDS 里，否则改了它「保存到该档」不会亮', () => {
  // 真实踩到的坑：oneMillionModels 在表单里可编辑，但一度不在 FORM_FIELDS 里，
  // 于是改完「百万上下文模型」后 isProfileModified 恒为 false，按钮一直是灰的
  // （更糟的是它也不会被存进档里）。
  assert.ok(
    FORM_FIELDS.claude.includes('oneMillionModels'),
    'oneMillionModels 是表单字段，必须在 FORM_FIELDS.claude 里',
  );
  assert.strictEqual(
    isProfileModified({ oneMillionModels: 'DeepSeek-V4-Pro-0813' }, CLIENT_PROFILE, FORM_FIELDS.claude),
    true,
  );
  assert.strictEqual(isProfileModified({ oneMillionModels: '' }, CLIENT_PROFILE, FORM_FIELDS.claude), false);
  // 选档时它也要被填回表单
  assert.deepStrictEqual(
    profileFormEntries({ name: 'x', values: { oneMillionModels: 'm1,m2' } }, FORM_FIELDS.claude),
    [['oneMillionModels', 'm1,m2']],
  );
});

test('buildConfigPutBody echoes the draft and normalises selections to never-null', () => {
  const draft = { providers: { claude: { baseUrl: 'https://x.example' } }, server: { port: 3188 } };
  const body = buildConfigPutBody(draft, { claude: 'p_a', codex: '', opencode: '', qoder: '', dsh: '' });
  assert.deepStrictEqual(body.activeProviderProfiles, { claude: 'p_a', codex: '', opencode: '', qoder: '', dsh: '' });
  assert.deepStrictEqual(body.providers, draft.providers);
  assert.deepStrictEqual(body.server, draft.server);
});

test('withProfileBuckets swaps only the two profile keys (unsaved form edits survive)', () => {
  const draft = { providers: { claude: { baseUrl: 'typed-but-unsaved' } }, server: { port: 1 } };
  const cfg = {
    providerProfiles: { claude: { p_a: { name: 'A', values: {} } } },
    activeProviderProfiles: { claude: 'p_a' },
  };
  const next = withProfileBuckets(draft, cfg) as Record<string, unknown>;
  assert.deepStrictEqual(next.providerProfiles, cfg.providerProfiles);
  assert.deepStrictEqual(next.activeProviderProfiles, cfg.activeProviderProfiles);
  assert.deepStrictEqual(next.providers, draft.providers); // 未保存的编辑还在
  assert.deepStrictEqual(next.server, draft.server);
});

test('findNewProfileId picks the id that was not there before', () => {
  assert.strictEqual(findNewProfileId(['p_a'], ['p_a', 'p_new']), 'p_new');
  assert.strictEqual(findNewProfileId([], ['p_only']), 'p_only');
  assert.strictEqual(findNewProfileId(['p_a'], ['p_a']), '');
});

test('FORM_FIELDS.dsh matches the backend PROFILE_FIELDS whitelist', () => {
  // 后端 provider-profiles.ts: PROFILE_FIELDS.dsh = ['baseUrl', 'apiKey', 'customModels']。
  // 前端必须 ⊆ 后端（多一个 = 存档时后端丢弃该字段，静默失能）。
  // 注意：这里断言的是「与后端清单的内联拷贝一致」，不是跨模块 import 后端
  // 导出 —— web 测试不引 backend 代码，跨模块不变式靠两处白名单一起改的纪律。
  assert.deepStrictEqual(FORM_FIELDS.dsh, ['baseUrl', 'apiKey', 'customModels']);
});
