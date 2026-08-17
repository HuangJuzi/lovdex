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