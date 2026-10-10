import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { PROJECT_TMP_DIR } from '@/modules/assets/services/file-assets.service.js';

/** Injected rename, so tests can force the cross-device fallback. */
export type RenameFn = (from: string, to: string) => Promise<void>;

/**
 * Uploads are staged inside the project (not `os.tmpdir()`) so the final move
 * is a same-filesystem `rename` instead of a copy. A 10GB upload therefore
 * peaks at 1× disk instead of 2×.
 *
 * The staging dir is a unique child of the project's shared `.lovdex-tmp`
 * (which already carries a `*` .gitignore, so staged bytes never appear in
 * `git status`). Only the child is ever removed — never `.lovdex-tmp` itself,
 * which also holds chat attachments.
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
