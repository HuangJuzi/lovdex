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

/** The bundled retry patch this repo ships (see `dsh-acp-runner.js`). */
function bundledRetryPatchPath() {
  return fileURLToPath(new URL('../../../../../dsh-retry.patch.yml', import.meta.url));
}

/** Shallow-merge at two levels so a test can add `llmProxy` / `providers.claude`
 *  without dropping the `providers.dsh` the harness just built. */
function mergeConfig(base, extra) {
  const merged = { ...base, ...extra };
  if (base.providers || extra.providers) {
    merged.providers = { ...base.providers, ...extra.providers };
  }
  return merged;
}

/** Runs the probe in an isolated data dir and returns what the fake dsh saw.
 *  `extraConfig` is merged last, so a test can turn the llm-proxy on. */
async function captureChildEnv(configPatch, extraConfig = {}) {
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
        DSH_PROBE_CONFIG: JSON.stringify(mergeConfig(
          { providers: { dsh: runnerConfig } },
          extraConfig,
        )),
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

test('an explicit baseUrl and apiKey win and are forwarded to the child', async () => {
  const observed = await captureChildEnv({
    baseUrl: 'https://my-llm.example/anthropic',
    apiKey: 'sk-test',
  });
  assert.equal(observed.baseUrl, 'https://my-llm.example/anthropic');
  assert.equal(observed.apiKey, 'sk-test');
});

test('with both fields empty and no proxy, nothing is exported so dsh keeps its own route', async () => {
  const observed = await captureChildEnv({ baseUrl: '', apiKey: '' });
  assert.equal(observed.baseUrl, null, 'an unset baseUrl must not be exported as blank');
  assert.equal(observed.apiKey, null, 'an unset apiKey must not be exported as blank');
});

test('an enabled llm-proxy becomes the endpoint, mirroring the claude provider', async () => {
  // Same rule env-sync.ts applies to claude: proxy on → the runtime targets
  // http://127.0.0.1:<port> and the proxy supplies the credential.
  const observed = await captureChildEnv(
    { baseUrl: '', apiKey: '' },
    { llmProxy: { enabled: true, port: 8123 }, providers: { claude: { apiKey: 'proxy-owned-key' } } },
  );
  assert.equal(observed.baseUrl, 'http://127.0.0.1:8123');
  assert.equal(observed.apiKey, 'proxy-owned-key', 'the proxy-resolved credential is inherited');
});

test('an explicit baseUrl overrides the proxy for dsh only', async () => {
  const observed = await captureChildEnv(
    { baseUrl: 'https://direct.example/anthropic', apiKey: '' },
    { llmProxy: { enabled: true, port: 8123 }, providers: { claude: { apiKey: 'proxy-owned-key' } } },
  );
  assert.equal(observed.baseUrl, 'https://direct.example/anthropic');
  assert.equal(observed.apiKey, 'proxy-owned-key', 'the credential still falls back to the proxy');
});

test('a patchPath becomes a --patch launcher flag layered after the bundled retry tuning', async () => {
  const observed = await captureChildEnv({
    baseUrl: '',
    apiKey: '',
    patchPath: '/tmp/my-route.patch.yml',
  });
  // Later --patch overlays replace earlier ones per config key, so the bundled
  // retry tuning goes FIRST and an explicit deployment patch still wins.
  assert.deepEqual(observed.argv, [
    '--profile', 'acp',
    '--patch', bundledRetryPatchPath(),
    '--patch', '/tmp/my-route.patch.yml',
  ]);
});

test('the bundled retry tuning patch exists and widens the llm-deepseek retry budget', async () => {
  const patchPath = bundledRetryPatchPath();
  const content = await fs.readFile(patchPath, 'utf8');
  assert.match(content, /id:\s*llm-deepseek/, 'targets the api-key adapter entry');
  assert.match(content, /maxRetries:\s*8/, 'raises the retry budget above the default 5');
  assert.match(content, /maxDelayMs:\s*60000/, 'lets backoff and Retry-After reach 60s (default 10s)');
});
