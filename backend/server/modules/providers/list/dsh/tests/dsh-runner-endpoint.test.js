import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Pins how a Lovdex deployment routes a spawned dsh at its own LLM.
 *
 * The knobs are the names dsh itself reads, so neither the endpoint nor the key
 * has to be written into a profile under $DSH_HOME:
 *   - DEEPSEEK_API_KEY  — the api-key adapter's default `apiKeyEnv`
 *   - DEEPSEEK_BASE_URL — the Messages transport's endpoint override
 *
 * The probe runs in a CHILD PROCESS with LOVDEX_DATA_DIR pointed at a temp dir.
 * That matters: `appConfig()` resolves its file from that env var, and the
 * runner reads launch settings from `appConfig()`. Without the redirect this
 * test would write the developer's real ~/.lovdex/data/app.config.json.
 */
const RUNNER_PATH = fileURLToPath(new URL('../../../../../dsh-acp-runner.js', import.meta.url));
const CONFIG_MODULE = fileURLToPath(new URL('../../../../config/config.js', import.meta.url));
// The probe imports `tsx`, so it must run with the backend as cwd for module
// resolution; the temp workspace is passed through as an explicit argument.
const BACKEND_DIR = fileURLToPath(new URL('../../../../../../', import.meta.url));

const PROBE_SOURCE = `
import fs from 'node:fs/promises';
import { appConfig } from ${JSON.stringify(CONFIG_MODULE)};
import { queryDsh } from ${JSON.stringify(RUNNER_PATH)};

appConfig().update(JSON.parse(process.env.DSH_PROBE_CONFIG));

await queryDsh('hello', { cwd: process.env.DSH_PROBE_WORKDIR }, { send: () => {}, userId: null });
await fs.writeFile(process.env.DSH_PROBE_DONE, 'done');
`;

const FAKE_DSH_SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.DSH_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  apiKey: process.env.DEEPSEEK_API_KEY ?? null,
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? null,
}));
process.exit(0);
`;

/** Runs the probe in an isolated data dir and returns what the fake dsh saw. */
async function captureChildEnv(configPatch) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-endpoint-'));
  const dataDir = path.join(tempRoot, 'data');
  const captureFile = path.join(tempRoot, 'capture.json');
  const doneFile = path.join(tempRoot, 'done');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'app.config.json'), JSON.stringify({ auth: { jwtSecret: 'test' } }));
  await fs.writeFile(path.join(tempRoot, 'dsh'), FAKE_DSH_SOURCE, { mode: 0o755 });

  const runnerConfig = {
    ...configPatch,
    binPath: path.join(tempRoot, 'dsh'),
    dshHome: path.join(tempRoot, 'home'),
  };

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', PROBE_SOURCE],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        LOVDEX_DATA_DIR: dataDir,
        DSH_CAPTURE: captureFile,
        DSH_PROBE_DONE: doneFile,
        DSH_PROBE_WORKDIR: tempRoot,
        DSH_PROBE_CONFIG: JSON.stringify({ providers: { dsh: runnerConfig } }),
        TSX_TSCONFIG_PATH: path.join(BACKEND_DIR, 'server', 'tsconfig.json'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  try {
    assert.equal(result.status, 0, `probe failed:\n${result.stderr || result.stdout}`);
    assert.ok(await fs.access(doneFile).then(() => true, () => false), 'the probe never reached queryDsh');
    return JSON.parse(await fs.readFile(captureFile, 'utf8'));
  } finally {
    // Always clean up, even when an assertion above threw — a leaked temp dir
    // per failing run is exactly the kind of noise that hides a real failure.
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('a baseUrl is forwarded to the child as DEEPSEEK_BASE_URL', async () => {
  const observed = await captureChildEnv({
    baseUrl: 'https://my-llm.example/anthropic',
    apiKey: 'sk-test',
  });
  assert.equal(observed.baseUrl, 'https://my-llm.example/anthropic');
  assert.equal(observed.apiKey, 'sk-test');
});

test('an empty baseUrl leaves DEEPSEEK_BASE_URL unset so dsh keeps its own route', async () => {
  const observed = await captureChildEnv({ baseUrl: '', apiKey: 'sk-test' });
  assert.equal(observed.baseUrl, null, 'an unset baseUrl must not be exported as blank');
  assert.equal(observed.apiKey, 'sk-test', 'the key still flows on its own');
});

test('a patchPath becomes a --patch launcher flag', async () => {
  const observed = await captureChildEnv({
    baseUrl: '',
    apiKey: '',
    patchPath: '/tmp/my-route.patch.yml',
  });
  assert.deepEqual(observed.argv, ['--profile', 'acp', '--patch', '/tmp/my-route.patch.yml']);
  assert.equal(observed.baseUrl, null);
});
