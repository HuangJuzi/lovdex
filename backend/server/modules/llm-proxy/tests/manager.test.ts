import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_APP_CONFIG } from '@/modules/config/config.js';
import { generateToml } from '../manager.js';
import type { AppConfig } from '@/modules/config/config.js';

function cfg(routing: AppConfig['llmProxy']['routing']): AppConfig {
  const c = structuredClone(DEFAULT_APP_CONFIG);
  c.llmProxy.enabled = true;
  c.llmProxy.port = 8088;
  c.llmProxy.anthropicUrl = 'https://upstream.example/anthropic';
  c.llmProxy.openaiUrl = 'https://upstream.example/openai';
  c.llmProxy.vlmModel = 'VLM-X';
  c.llmProxy.vlmMaxTokens = 1234;
  c.llmProxy.routing = routing;
  return c as AppConfig;
}

test('generateToml emits proxy/upstream/vlm sections', () => {
  const toml = generateToml(cfg({}));
  assert.match(toml, /port = 8088/);
  assert.match(toml, /anthropic_url = "https:\/\/upstream\.example\/anthropic"/);
  assert.match(toml, /vlm_model = "VLM-X"/);
  assert.match(toml, /vlm_max_tokens = 1234/);
});

test('generateToml emits string routing entries', () => {
  const toml = generateToml(cfg({ sonnet: 'DeepSeek-V4-Pro', opus: 'GLM-5.2' }));
  assert.match(toml, /\[routing\]/);
  assert.match(toml, /sonnet = "DeepSeek-V4-Pro"/);
  assert.match(toml, /opus = "GLM-5.2"/);
});

test('generateToml emits table routing entries for openai upstream', () => {
  const toml = generateToml(cfg({ flash: { model: 'glm-5.3-flash', upstream: 'openai' } }));
  assert.match(toml, /\[routing\.flash\]/);
  assert.match(toml, /model = "glm-5.3-flash"/);
  assert.match(toml, /upstream = "openai"/);
});
