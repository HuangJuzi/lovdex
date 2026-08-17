/** 单个上传文件大小上限（字节）：50MB。 */
export const MAX_FILE_UPLOAD_SIZE = 50 * 1024 * 1024;
/** 单次上传文件个数上限。 */
export const MAX_FILE_UPLOAD_COUNT = 5;

type UploadCandidate = {
  name: string;
  size?: number;
  type?: string;
};

/**
 * 校验一个待上传文件：任意类型，大小 ≤ 50MB。
 * 返回 `{ ok: true }` 或 `{ ok: false, error }`（错误文案复用图片上传的硬编码风格）。
 */
export function validateFileUpload(candidate: UploadCandidate): { ok: true } | { ok: false; error: string } {
  if (candidate.size === undefined || candidate.size > MAX_FILE_UPLOAD_SIZE) {
    return { ok: false, error: 'File too large (max 50 MB)' };
  }
  return { ok: true };
}

/** 把上传记录拼成首条消息前缀：`[附件: <path>]` 每文件一行。无文件返回空串。 */
export function buildAttachmentPrefix(files: Array<{ path: string }>): string {
  if (files.length === 0) return '';
  return files.map((f) => `[附件: ${f.path}]`).join('\n');
}
