import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { queryDsh } from '../../../../../dsh-acp-runner.js';

/**
 * Regression guard for the launch path.
 *
 * The gateway passes the USER'S MESSAGE as this runner's first argument
 * (`spawnFn(command, options, writer)` in handleChatSend), while the executable
 * must always come from config. An earlier version spawned
 * `command || cfg.binPath`, so every non-empty message became argv[0] and the
 * run died with ENOENT before any ACP traffic ever flowed.
 *
 * This drives the REAL `queryDsh` against a fake `dsh` planted on PATH, so the
 * assertions cover the actual spawn decision rather than a stub's.
 */
const FAKE_DSH_SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.DSH_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;

test('queryDsh spawns the dsh binary, never the user message', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-spawn-'));
  const argvFile = path.join(tempRoot, 'argv.json');
  const fakeBin = path.join(tempRoot, 'dsh');

  await fs.writeFile(fakeBin, FAKE_DSH_SOURCE, { mode: 0o755 });

  const previousPath = process.env.PATH;
  const previousCapture = process.env.DSH_ARGV_CAPTURE;
  process.env.PATH = `${tempRoot}${path.delimiter}${previousPath ?? ''}`;
  process.env.DSH_ARGV_CAPTURE = argvFile;

  const ws = { send: () => {}, userId: null };

  try {
    await queryDsh('please summarize the README', { cwd: tempRoot }, ws);

    let argv = null;
    for (let attempt = 0; attempt < 50 && argv === null; attempt += 1) {
      try {
        argv = JSON.parse(await fs.readFile(argvFile, 'utf8'));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    assert.ok(argv, 'the fake dsh binary must have been executed from PATH');
    // The bundled retry overlay is always layered first; no deployment patchPath
    // is configured here, so argv is exactly profile + that one overlay.
    const bundledPatch = fileURLToPath(new URL('../../../../../dsh-retry.patch.yml', import.meta.url));
    assert.deepEqual(argv, ['--profile', 'acp', '--patch', bundledPatch]);
    assert.ok(
      !argv.includes('please summarize the README'),
      'the user message must never reach argv',
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousCapture === undefined) {
      delete process.env.DSH_ARGV_CAPTURE;
    } else {
      process.env.DSH_ARGV_CAPTURE = previousCapture;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
