import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_TMP_DIR } from '@/modules/assets/services/file-assets.service.js';

/**
 * Where one upload request stages its bytes.
 *
 * A LOCAL project stages inside itself so the final move is a same-filesystem
 * `rename` instead of a copy (a 10GB upload peaks at 1× disk, not 2×).
 *
 * A REMOTE project must never be staged under its `projectRoot`: that path
 * names a directory on the OTHER host, so touching it here would either fail
 * with EACCES or silently litter an unrelated local directory. Its bytes still
 * need a local scratch — multer writes them here and the chunked push streams
 * them out — so they go to the OS temp dir, which is what the pre-chunking code
 * used for every upload.
 */
export async function resolveUploadStagingDir(opts: {
  projectRoot: string;
  isRemote: boolean;
}): Promise<string> {
  if (opts.isRemote) {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'lovdex-upload-'));
  }
  return createUploadStagingDir(opts.projectRoot);
}

/** Injected rename, so tests can force the cross-device fallback. */
export type RenameFn = (from: string, to: string) => Promise<void>;

/**
 * Stage inside a LOCAL project: a unique child of its shared `.lovdex-tmp`
 * (which already carries a `*` .gitignore, so staged bytes never appear in
 * `git status`). Only the child is ever removed — never `.lovdex-tmp` itself,
 * which also holds chat attachments.
 *
 * Do not call this for a remote project; use {@link resolveUploadStagingDir}.
 */
export async function createUploadStagingDir(projectRoot: string): Promise<string> {
  const base = path.join(projectRoot, PROJECT_TMP_DIR);
  await fsp.mkdir(base, { recursive: true });

  const gitignorePath = path.join(base, '.gitignore');
  try {
    await fsp.writeFile(gitignorePath, '*\n!.gitignore\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  return fsp.mkdtemp(path.join(base, 'upload-'));
}

/** Best-effort removal of ONE staging dir; never touches its `.lovdex-tmp` parent. */
export async function removeUploadStagingDir(stagingDir: string): Promise<void> {
  try {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[upload] failed to remove staging dir ${stagingDir}:`, (error as Error).message);
  }
}

/**
 * Move one staged file to its final path. `rename` is atomic and same-device
 * when staging sits inside the project; EXDEV (staging on a different mount,
 * e.g. a project reached through a bind mount) falls back to copy+unlink.
 */
export async function moveStagedFileIntoPlace(
  stagedPath: string,
  targetPath: string,
  rename: RenameFn = fsp.rename,
): Promise<void> {
  try {
    await rename(stagedPath, targetPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  await fsp.copyFile(stagedPath, targetPath);
  await fsp.unlink(stagedPath);
}
