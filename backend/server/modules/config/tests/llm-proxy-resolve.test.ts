import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_APP_CONFIG, resolveLlmProxy } from '../config.js';
import type { AppConfig } from '../config.js';

function cfgWith(overrides: Partial<AppConfig['llmProxy']>): AppConfig {
  return {
    ...structuredClone(DEFAULT_APP_CONFIG),
    llmProxy: { ...structuredClone(DEFAULT_APP_CONFIG.llmProxy), ...overrides },
  } as AppConfig;
}

test('resolveLlmProxy disabled by default', () => {
  const r = resolveLlmProxy(structuredClone(DEFAULT_APP_CONFIG));
  assert.equal(r.enabled, false);
});

test('resolveLlmProxy falls back anthropicUrl to providers.claude.baseUrl', () => {
  const cfg = cfgWith({ enabled: true });
  cfg.providers.claude.baseUrl = 'https://upstream.example/anthropic';
  const r = resolveLlmProxy(cfg);
  assert.equal(r.anthropicUrl, 'https://upstream.example/anthropic');
});

test('resolveLlmProxy prefers explicit anthropicUrl + carries apiKey from claude', () => {
  const cfg = cfgWith({ enabled: true, anthropicUrl: 'https://explicit.example/x', port: 9999 });
  cfg.providers.claude.apiKey = 'sk-test';
  const r = resolveLlmProxy(cfg);
  assert.equal(r.anthropicUrl, 'https://explicit.example/x');
  assert.equal(r.port, 9999);
  assert.equal(r.apiKey, 'sk-test');
});

test('resolveLlmProxy applies defaults for empty port/vlmMaxTokens', () => {
  const r = resolveLlmProxy(cfgWith({ enabled: true, port: 0, vlmMaxTokens: 0 }));
  assert.equal(r.port, 8088);
  assert.equal(r.vlmMaxTokens, 8000);
});
