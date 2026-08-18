import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build + package the remote-lite agent for one deploy.
 *
 * C1 review fix: the deploy path previously pushed config/env + install.sh but
 * NO runnable agent — bootstrap reported `online` while the remote had nothing
 * to run (the systemd unit's ExecStart pointed at a missing dist/lite.mjs), so
 * no lite ever dialed back. This helper closes that gap:
 *
 *  1. bundles `src/index.ts` with esbuild into `dist/lite.mjs` as a
 *     SELF-CONTAINED ESM artifact (deps inlined, no `--packages=external`).
 *     The `--banner:js` shim (`createRequire`) is required because ws issues a
 *     dynamic `require('events')` that plain ESM output cannot satisfy.
 *  2. tars `dist/lite.mjs` + `package.json` (+ `package-lock.json` when
 *     present) into a temp `lite.tgz`. The bootstrap pushes that tarball to
 *     `~/.lovdex-remote/lite.tgz` and install.sh expands it in place, so the
 *     tarball entries use paths relative to the remote agent dir.
 *
 * `execFile` and the bin paths are injectable for unit tests.
 */

export type LitePackageBuild = {
  /** Absolute path to the built+tarred lite bundle. */
  tarballPath: string;
};

export type BuildLitePackageOptions = {
  /** Directory containing `src/index.ts`, `package.json`, `package-lock.json` (backends). */
  sourceDir: string;
  esbuildBin?: string;
  tarBin?: string;
  /** Temp output dir for the tarball (default: a fresh OS temp dir). */
  outDir?: string;
  exec?: typeof execFile;
};

function runTool(
  exec: typeof execFile,
  bin: string,
  argv: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(bin, argv, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`${bin} ${argv.join(' ')} failed: ${String(stderr || error.message)}`));
        return;
      }
      resolve();
    });
  });
}

export async function buildLitePackage(
  opts: BuildLitePackageOptions,
): Promise<LitePackageBuild> {
  const exec = opts.exec ?? execFile;
  const sourceDir = opts.sourceDir;
  const esbuildBin = opts.esbuildBin ?? 'esbuild';
  const tarBin = opts.tarBin ?? 'tar';
  const outDir = opts.outDir ?? mkdtempSync(path.join(os.tmpdir(), 'lovdex-lite-'));
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(sourceDir, 'dist', 'lite.mjs');
  // `--packages=external` is deliberately absent: the tarball has no node_modules
  // and the remote has no package-lock, so every import (ws/zod/claude-agent-sdk)
  // must be inlined. ws's dynamic `require('events')` needs the createRequire
  // shim in ESM output.
  const banner = "import{createRequire}from'module';const require=createRequire(import.meta.url);";
  try {
    await runTool(exec, esbuildBin, [
      'src/index.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--banner:js=${banner}`,
      `--outfile=${outfile}`,
    ], sourceDir);

    const tarballPath = path.join(outDir, 'lite.tgz');
    const tarArgs = ['-czf', tarballPath, 'dist/lite.mjs', 'package.json'];
    if (existsSync(path.join(sourceDir, 'package-lock.json'))) {
      tarArgs.push('package-lock.json');
    }
    await runTool(exec, tarBin, tarArgs, sourceDir);
    return { tarballPath };
  } finally {
    // Keep the source tree clean either way: a failed esbuild can leave a
    // partial dist/lite.mjs behind, and only the tarball is consumed.
    rmSync(outfile, { force: true });
  }
}