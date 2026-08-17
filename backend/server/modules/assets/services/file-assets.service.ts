import { promises as fs } from 'node:fs';
import path from 'node:path';

import { toPosixPath } from '@/shared/image-attachments.js';

/** 项目内临时上传目录名（位于 <projectPath>/ 下）。 */
export const PROJECT_TMP_DIR = '.lovdex-tmp';

/** 该目录里的 .gitignore 内容：屏蔽所有上传文件，但不屏蔽 .gitignore 自身。 */
const TMP_GITIGNORE = '*\n!.gitignore\n';

type UploadedFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type StoredFileRecord = {
  name: string;
  path: string;
  size: number;
  mimeType: string;
};

/**
 * 创建 <projectPath>/.lovdex-tmp 目录（含内部 .gitignore），返回该目录绝对路径。
 * 幂等：目录已存在时直接复用。
 */
export async function ensureProjectTempDir(projectPath: string): Promise<string> {
  const dir = path.join(projectPath, PROJECT_TMP_DIR);
  await fs.mkdir(dir, { recursive: true });

  const gitignorePath = path.join(dir, '.gitignore');
  try {
    await fs.writeFile(gitignorePath, TMP_GITIGNORE, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  return dir;
}

/** 把 multer 落盘的文件映射为上传记录（path 为绝对 posix 路径）。 */
export function buildStoredFileRecords(projectPath: string, files: UploadedFile[]): StoredFileRecord[] {
  const tmpDir = path.join(projectPath, PROJECT_TMP_DIR);
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(tmpDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/** 项目删除时清理临时目录（尽力而为）。 */
export async function removeProjectTempDir(projectPath: string): Promise<void> {
  const dir = path.join(projectPath, PROJECT_TMP_DIR);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[file-assets] Failed to remove ${dir}:`, (error as Error).message);
  }
}
