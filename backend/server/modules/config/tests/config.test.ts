import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppConfig } from '../config.js';

const DEFAULT_CFG = {
  server: {
    host: '0.0.0.0', port: 3188, corsOrigin: '*', contextWindow: null,
    isPlatform: false, workflowsEnabled: true, ultracodeKeywordTrigger: '',
  },
  database: { path: path.join(os.homedir(), '.sophcode', 'auth.db') },
  workspaces: { root: '~', mainWorkspace: '' },
  auth: { enabled: true, email: null, code: null, jwtSecret: '' },
  providers: {
    claude: { cliPath: 'claude', apiKey: '', authToken: '', oneMillionModels: '',
              streamCloseTimeoutMs: 10000, toolApprovalTimeoutMs: 60000 },
    codex: { binPath: 'codex' },
    opencode: { binPath: 'opencode', apiKeys: {} },
    qoder: { personalAccessToken: '', toolApprovalTimeoutMs: 60000 },
  },
  operator: { enabled: true, autoVerdictEnabled: true, model: '', workspace: '',
              maxConcurrent: 2 },
  runtime: { fsConcurrency: 64 },
};

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-cfg-')); }

test('loads defaults when file missing, generated on first access', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  const got = cfg.get();
  assert.strictEqual(got.server.port, 3188);
  assert.strictEqual(got.server.isPlatform, false);
  assert.strictEqual(got.database.path, DEFAULT_CFG.database.path);
  assert.ok(got.auth.jwtSecret.length >= 32);
});

test('persists to app.config.json with atomic write', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({ providers: { qoder: { personalAccessToken: 'pat-123' } } });
  const file = path.join(dir, 'app.config.json');
  assert.ok(fs.existsSync(file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.providers.qoder.personalAccessToken, 'pat-123');
  assert.strictEqual(onDisk.server.port, 3188);
});

test('deep merge: partial update does not clobber siblings', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({ server: { port: 4000 } });
  const got = cfg.get();
  assert.strictEqual(got.server.port, 4000);
  assert.strictEqual(got.server.host, '0.0.0.0');
  assert.strictEqual(got.server.isPlatform, false);
});

test('getMasked masks every value inside providers.opencode.apiKeys', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({
    providers: {
      opencode: { apiKeys: { ANTHROPIC_API_KEY: 'sk-super-secret', OPENAI_API_KEY: 'sk-other' } },
    },
  });
  const masked = cfg.getMasked();
  const apiKeys = masked.providers.opencode.apiKeys as Record<string, string>;
  assert.deepStrictEqual(Object.keys(apiKeys).sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  assert.strictEqual(apiKeys.ANTHROPIC_API_KEY, '••••cret');
  assert.strictEqual(apiKeys.OPENAI_API_KEY, '••••ther');
  const serialized = JSON.stringify(masked);
  assert.ok(!serialized.includes('sk-super-secret'));
  assert.ok(!serialized.includes('sk-other'));
});

test('empty auth.jwtSecret on disk is injected AND persisted', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'app.config.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ auth: { jwtSecret: '' } }, null, 2));
  const cfg = createAppConfig({ dataDir: dir });
  assert.ok(cfg.get().auth.jwtSecret.length >= 32);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.auth.jwtSecret.length >= 32, 'injected secret must be persisted to disk');
});

test('auth code and jwtSecret use zero-hint mask', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({ auth: { code: '123456', jwtSecret: 'abcdef1234567890' } });
  const masked = cfg.getMasked();
  assert.strictEqual(masked.auth.code, '••••');
  assert.strictEqual(masked.auth.jwtSecret, '••••');
});

test('claude provider defaults prefill baseUrl and model alias fields', () => {
  const cfg = createAppConfig({ dataDir: tmpDir() });
  const claude = cfg.get().providers.claude;
  assert.strictEqual(claude.baseUrl, 'https://www.sophnet.com/api/open-apis/anthropic');
  assert.strictEqual(claude.defaultModel, 'DeepSeek-V4-Flash-0731');
  assert.strictEqual(claude.haikuModel, 'DeepSeek-V4-Flash-0731');
  assert.strictEqual(claude.opusModel, 'DeepSeek-V4-Pro-0813');
  assert.strictEqual(claude.sonnetModel, 'claude-opus-4-8');
});

test('claude model alias fields survive deep merge and persist', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({
    providers: { claude: { baseUrl: 'https://proxy.example/anthropic', defaultModel: 'm-default', sonnetModel: 'm-sonnet' } },
  });
  assert.strictEqual(cfg.get().providers.claude.baseUrl, 'https://proxy.example/anthropic');
  assert.strictEqual(cfg.get().providers.claude.sonnetModel, 'm-sonnet');
  // sibling untouched by partial update
  assert.strictEqual(cfg.get().providers.claude.haikuModel, 'DeepSeek-V4-Flash-0731');
  // persisted to disk
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'app.config.json'), 'utf8'));
  assert.strictEqual(onDisk.providers.claude.defaultModel, 'm-default');
});

test('apiKey masks as first6****last6 while other secrets keep tail mask', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({
    providers: { claude: { apiKey: 'sk-ant-abcdef-1234567890', authToken: 'tok-secret-value-9876' } },
  });
  const masked = cfg.getMasked();
  assert.strictEqual(masked.providers.claude.apiKey, 'sk-ant****567890');
  assert.strictEqual(masked.providers.claude.authToken, '••••9876');
});
