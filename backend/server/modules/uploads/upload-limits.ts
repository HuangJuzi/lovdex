/**
 * The single source of truth for how large a file the project file-tree upload
 * accepts. Mirrored on the frontend by
 * `web/src/components/file-tree/constants/constants.ts` — keep the two in sync;
 * the frontend value only pre-checks, this one is authoritative.
 */
export const MAX_FILE_UPLOAD_SIZE_MB = 10240;

export const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;

export const MAX_FILE_UPLOAD_COUNT = 20;
