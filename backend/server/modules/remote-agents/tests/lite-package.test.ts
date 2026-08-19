import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLitePackage } from '../lite-package.js';

type Call = { bin: string; argv: string[]; cwd: string };

/** Fake execFile: records every invocation and succeeds. */
function fakeExecFile() {
  const calls: Call[] = [];
  const fn = ((
    bin: string,
    argv: string[],
    options: { cwd?: string },
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ bin, argv, cwd: options.cwd ?? '' });
    cb(null, '', '');
    return {} as never;
  }) as never;
  return { fn, calls };
}

test('buildLitePackage bundles a self-contained ESM artifact and tars it', async () => {
  const src = '/repo/remote-agent';
  const out = mkdtempSync(path.join(os.tmpdir(), 'lite-pkg-test-'));
  const { fn, calls } = fakeExecFile();
  try {
    const res = await buildLitePackage({
      sourceDir: src,
      esbuildBin: '/repo/node_modules/esbuild/bin/esbuild',
      outDir: out,
      exec: fn,
    });

    assert.equal(res.tarballPath, path.join(out, 'lite.tgz'));

    const esbuildCall = calls.find((c) => c.bin.includes('esbuild'));
    assert.ok(esbuildCall, 'esbuild was invoked');
    assert.deepEqual(esbuildCall!.argv, [
      'src/index.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      // Self-contained: --packages=external is deliberately absent, and ws's
      // dynamic require('events') is covered by the createRequire shim. The
      // shim aliases createRequire AS __createRequire so the inlined codex SDK's
      // own `import { createRequire }` does not collide (T12 E2E finding).
      '--banner:js=import{createRequire as __createRequire}from\'module\';const require=__createRequire(import.meta.url);',
      '--outfile=/repo/remote-agent/dist/lite.mjs',
    ]);
    assert.equal(esbuildCall!.cwd, src);

    const tarCall = calls.find((c) => c.bin === 'tar');
    assert.ok(tarCall, 'tar was invoked');
    assert.deepEqual(tarCall!.argv, ['-czf', path.join(out, 'lite.tgz'), 'dist/lite.mjs', 'package.json']);
    assert.equal(tarCall!.cwd, src);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});