import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, loadConfigFile } from '../config.js';

test('loadConfig parses a valid object and applies defaults', () => {
  const cfg = loadConfig({
    serverUrl: 'ws://localhost:3000/agent',
    token: 'a-long-enough-token',
    hostId: 'host-1',
  });
  assert.equal(cfg.serverUrl, 'ws://localhost:3000/agent');
  assert.equal(cfg.token, 'a-long-enough-token');
  assert.equal(cfg.hostId, 'host-1');
  assert.deepEqual(cfg.roots, ['/']);
  assert.equal(cfg.agentVersion, '0.1.0');
});

test('loadConfig honors explicit roots and optional fields', () => {
  const cfg = loadConfig({
    serverUrl: 'ws://localhost:3000/agent',
    token: 'a-long-enough-token',
    hostId: 'host-1',
    roots: ['/home/user', '/tmp'],
    agentVersion: '9.9.9',
    apiKeyEnvPath: '/etc/keys',
    claudeCliPath: '/usr/bin/claude',
  });
  assert.deepEqual(cfg.roots, ['/home/user', '/tmp']);
  assert.equal(cfg.agentVersion, '9.9.9');
  assert.equal(cfg.apiKeyEnvPath, '/etc/keys');
  assert.equal(cfg.claudeCliPath, '/usr/bin/claude');
});

test('loadConfig rejects a missing token', () => {
  assert.throws(() =>
    loadConfig({ serverUrl: 'ws://localhost:3000/agent', hostId: 'host-1' }),
  );
});

test('loadConfig rejects a too-short token', () => {
  assert.throws(() =>
    loadConfig({ serverUrl: 'ws://localhost:3000/agent', token: 'short', hostId: 'host-1' }),
  );
});

test('loadConfig rejects a missing serverUrl', () => {
  assert.throws(() => loadConfig({ token: 'a-long-enough-token', hostId: 'host-1' }));
});

test('loadConfig rejects an empty roots array', () => {
  assert.throws(() =>
    loadConfig({
      serverUrl: 'ws://localhost:3000/agent',
      token: 'a-long-enough-token',
      hostId: 'host-1',
      roots: [],
    }),
  );
});

test('loadConfigFile reads and parses a temp JSON file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lovdex-remote-'));
  const filePath = join(dir, 'config.json');
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        serverUrl: 'ws://localhost:3000/agent',
        token: 'a-long-enough-token',
        hostId: 'host-file',
      }),
      'utf8',
    );
    const cfg = loadConfigFile(filePath);
    assert.equal(cfg.hostId, 'host-file');
    assert.deepEqual(cfg.roots, ['/']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
