import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import type { Project } from '../../../types/app';
import {
  expireAuthSession,
  getStoredAuthToken,
  storeAuthToken,
} from '../../../utils/api';
import {
  MAX_FILE_UPLOAD_COUNT,
  MAX_FILE_UPLOAD_SIZE_BYTES,
  MAX_FILE_UPLOAD_SIZE_LABEL,
} from '../constants/constants';

type UseFileTreeUploadOptions = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
};

export type FileTreeUploadProgressState = {
  status: 'uploading' | 'complete' | 'error';
  progress: number;
  fileCount: number;
  uploadedCount?: number;
  fileName?: string;
  targetPath?: string;
  error?: string;
};

type UploadResponse = {
  error?: string;
  message?: string;
  files?: unknown[];
  uploadedCount?: number;
  requestedFileCount?: number;
};

const COMPLETE_PROGRESS_CLEAR_DELAY_MS = 1400;
const ERROR_PROGRESS_CLEAR_DELAY_MS = 3200;

const pluralizeFiles = (count: number) => (count === 1 ? 'file' : 'files');

const getRelativePath = (file: File) => {
  const fileWithRelativePath = file as File & { webkitRelativePath?: string };
  return fileWithRelativePath.webkitRelativePath || file.name;
};

const getFileDisplayName = (file: File) => {
  const relativePath = getRelativePath(file);
  return relativePath.split(/[\\/]/).pop() || file.name;
};

const parseUploadResponse = (xhr: XMLHttpRequest): UploadResponse => {
  if (!xhr.responseText) {
    return {};
  }

  try {
    return JSON.parse(xhr.responseText) as UploadResponse;
  } catch {
    return {};
  }
};

const formatUploadSuccessMessage = (uploadedCount: number, requestedFileCount: number) => {
  if (uploadedCount !== requestedFileCount) {
    return `Uploaded ${uploadedCount} of ${requestedFileCount} ${pluralizeFiles(requestedFileCount)}`;
  }

  return `Uploaded ${uploadedCount} ${pluralizeFiles(uploadedCount)} successfully`;
};

const buildUploadFormData = (files: File[], targetPath: string) => {
  const formData = new FormData();
  const relativePaths: string[] = [];

  formData.append('targetPath', targetPath);
  formData.append('requestedFileCount', String(files.length));

  files.forEach((file) => {
    const relativePath = getRelativePath(file);
    const cleanFile = new File([file], relativePath.split(/[\\/]/).pop() || file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });

    formData.append('files', cleanFile);
    relativePaths.push(relativePath);
  });

  formData.append('relativePaths', JSON.stringify(relativePaths));

  return formData;
};

/** Build the upload URL. `targetPath` rides the query string so the backend can
 *  resolve the destination (and its staging dir) before multer parses the body. */
export const buildUploadUrl = (projectId: string, targetPath: string) => {
  const base = `/api/projects/${encodeURIComponent(projectId)}/files/upload`;
  return targetPath ? `${base}?targetPath=${encodeURIComponent(targetPath)}` : base;
};

/** Slice files into multer-legal batches (folder picks can exceed
 *  MAX_FILE_UPLOAD_COUNT; batches upload strictly in sequence). */
export const chunkFilesForUpload = (files: File[], limit: number): File[][] => {
  if (files.length === 0 || limit < 1) return [];
  const batches: File[][] = [];
  for (let i = 0; i < files.length; i += limit) {
    batches.push(files.slice(i, i + limit));
  }
  return batches;
};

const uploadFormDataWithProgress = (
  projectId: string,
  targetPath: string,
  formData: FormData,
  onProgress: (progress: number) => void,
) =>
  new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open('POST', buildUploadUrl(projectId, targetPath));

    const token = getStoredAuthToken();
    if (!IS_PLATFORM() && token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      // Keep 100% for the server response so the UI can distinguish transfer
      // completion from the final write/refresh step.
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      const refreshedToken = xhr.getResponseHeader('X-Refreshed-Token');
      if (refreshedToken) {
        storeAuthToken(refreshedToken);
      }
      if (xhr.getResponseHeader('X-Auth-Error') || xhr.status === 401) {
        expireAuthSession();
      }

      const payload = parseUploadResponse(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }

      reject(new Error(payload.error || payload.message || `Upload failed with status ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload canceled.'));

    xhr.send(formData);
  });

// Helper function to read all files from a directory entry recursively
const readAllDirectoryEntries = async (directoryEntry: FileSystemDirectoryEntry, basePath = ''): Promise<File[]> => {
  const files: File[] = [];

  const reader = directoryEntry.createReader();
  let entries: FileSystemEntry[] = [];

  // Read all entries from the directory (may need multiple reads)
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    entries = entries.concat(batch);
  } while (batch.length > 0);

  // Files to ignore (system files)
  const ignoredFiles = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

  for (const entry of entries) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject);
      });

      // Skip ignored files
      if (ignoredFiles.includes(file.name)) {
        continue;
      }

      // Create a new file with the relative path as the name
      const fileWithPath = new File([file], entryPath, {
        type: file.type,
        lastModified: file.lastModified,
      });
      files.push(fileWithPath);
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const subFiles = await readAllDirectoryEntries(dirEntry, entryPath);
      files.push(...subFiles);
    }
  }

  return files;
};

const collectDroppedFiles = async (dataTransfer: DataTransfer) => {
  const files: File[] = [];

  // Use DataTransferItemList for folder support
  const { items } = dataTransfer;
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') {
        continue;
      }

      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (!entry) {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
        continue;
      }

      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => {
          (entry as FileSystemFileEntry).file(resolve, reject);
        });
        files.push(file);
      } else if (entry.isDirectory) {
        // Pass the directory name as basePath so files include the folder path
        const dirFiles = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry, entry.name);
        files.push(...dirFiles);
      }
    }
    return files;
  }

  // Fallback for browsers that don't support webkitGetAsEntry
  for (const file of Array.from(dataTransfer.files)) {
    files.push(file);
  }

  return files;
};

export const useFileTreeUpload = ({
  selectedProject,
  onRefresh,
  showToast,
}: UseFileTreeUploadOptions) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<FileTreeUploadProgressState | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const clearProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearProgressTimer = useCallback(() => {
    if (clearProgressTimerRef.current) {
      clearTimeout(clearProgressTimerRef.current);
      clearProgressTimerRef.current = null;
    }
  }, []);

  const scheduleProgressClear = useCallback(
    (delay: number) => {
      clearProgressTimer();
      clearProgressTimerRef.current = setTimeout(() => {
        setUploadProgress(null);
        clearProgressTimerRef.current = null;
      }, delay);
    },
    [clearProgressTimer],
  );

  useEffect(() => clearProgressTimer, [clearProgressTimer]);

  const setUploadError = useCallback(
    (message: string, fileCount: number, targetPath = '', fileName?: string, progress = 0) => {
      setUploadProgress({
        status: 'error',
        progress,
        fileCount,
        fileName,
        targetPath,
        error: message,
      });
      scheduleProgressClear(ERROR_PROGRESS_CLEAR_DELAY_MS);
    },
    [scheduleProgressClear],
  );

  const uploadFiles = useCallback(
    async (files: File[], targetPath = '') => {
      if (files.length === 0) {
        setDropTarget(null);
        return;
      }

      const fileName = files.length === 1 ? getFileDisplayName(files[0]) : undefined;

      if (!selectedProject) {
        const message = 'Select a project before uploading files.';
        showToast(message, 'error');
        setUploadError(message, files.length, targetPath, fileName);
        return;
      }

      // The size check stays per-file across all batches.
      const oversizedFile = files.find((file) => file.size > MAX_FILE_UPLOAD_SIZE_BYTES);
      if (oversizedFile) {
        const message = `${getFileDisplayName(oversizedFile)} is larger than ${MAX_FILE_UPLOAD_SIZE_LABEL}.`;
        showToast(message, 'error');
        setUploadError(message, files.length, targetPath, fileName);
        return;
      }

      const batches = chunkFilesForUpload(files, MAX_FILE_UPLOAD_COUNT);
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

      clearProgressTimer();
      setOperationLoading(true);
      setUploadProgress({
        status: 'uploading',
        progress: 0,
        fileCount: files.length,
        fileName,
        targetPath,
      });

      let uploadedTotal = 0;
      let serverAccepted = 0;
      let sentBytes = 0;

      try {
        for (const batch of batches) {
          const batchBase = sentBytes;
          const batchBytes = batch.reduce((sum, f) => sum + f.size, 0);
          const response = await uploadFormDataWithProgress(
            selectedProject.projectId,
            targetPath,
            buildUploadFormData(batch, targetPath),
            (progress) => {
              // Aggregate: scale this batch's progress into its byte share of
              // the whole upload so the bar advances monotonically.
              const overall =
                totalBytes > 0
                  ? Math.min(99, Math.round(((batchBase + (progress / 100) * batchBytes) / totalBytes) * 100))
                  : Math.round(((batches.indexOf(batch) + progress / 100) / batches.length) * 100);
              // Never let an aggregate dip below what is already shown: with
              // zero-byte files the byte weighting degenerates, and a later
              // batch must still not rewind the bar.
              setUploadProgress((current) =>
                current && current.status === 'uploading'
                  ? { ...current, progress: Math.max(current.progress, Math.min(99, overall)) }
                  : current,
              );
            },
          );
          sentBytes += batchBytes;
          uploadedTotal += batch.length;
          // The server silently skips files whose destination fails validation,
          // so its own count is the authority on what actually landed.
          serverAccepted +=
            typeof response.uploadedCount === 'number' ? response.uploadedCount : batch.length;
        }

        setUploadProgress({
          status: 'complete',
          progress: 100,
          fileCount: files.length,
          uploadedCount: serverAccepted,
          fileName,
          targetPath,
        });

        showToast(formatUploadSuccessMessage(serverAccepted, files.length), 'success');
        scheduleProgressClear(COMPLETE_PROGRESS_CLEAR_DELAY_MS);
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        console.error('Upload error:', err);
        // Earlier batches may already be on disk; say so and refresh the tree
        // rather than implying nothing was written.
        showToast(
          uploadedTotal > 0
            ? `${message} (${uploadedTotal} of ${files.length} uploaded before the failure)`
            : message,
          'error',
        );
        setUploadError(message, files.length, targetPath, fileName, 0);
        if (uploadedTotal > 0) onRefresh();
      } finally {
        setOperationLoading(false);
        setDropTarget(null);
      }
    },
    [
      clearProgressTimer,
      onRefresh,
      scheduleProgressClear,
      selectedProject,
      setUploadError,
      showToast,
    ],
  );

  // Remembers where an "upload here" context-menu action wants the next
  // picker selection to land. Cleared as soon as the selection is consumed —
  // or when the picker is dismissed without a selection, so a cancelled
  // "upload here" cannot silently redirect a later toolbar upload.
  const pendingUploadTargetRef = useRef<string>('');

  const resetPendingUploadTarget = useCallback(() => {
    pendingUploadTargetRef.current = '';
  }, []);

  // A dismissed file dialog fires no `change`; the window regaining focus is
  // the only signal that the pick is over. Deferred a tick so the `change`
  // event (which follows focus) still sees the pending target.
  const armPickerDismissReset = useCallback(() => {
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(resetPendingUploadTarget, 0);
    };
    window.addEventListener('focus', onFocus, { once: true });
  }, [resetPendingUploadTarget]);

  const openFilePicker = useCallback((targetPath = '') => {
    pendingUploadTargetRef.current = targetPath;
    armPickerDismissReset();
    fileInputRef.current?.click();
  }, [armPickerDismissReset]);

  const openFolderPicker = useCallback((targetPath = '') => {
    pendingUploadTargetRef.current = targetPath;
    armPickerDismissReset();
    folderInputRef.current?.click();
  }, [armPickerDismissReset]);

  const handleFileSelect = useCallback(
    async (fileList: FileList | File[]) => {
      const target = pendingUploadTargetRef.current;
      resetPendingUploadTarget();
      await uploadFiles(Array.from(fileList), target);
    },
    [resetPendingUploadTarget, uploadFiles],
  );

  // A webkitdirectory pick gives one root folder; every file carries
  // webkitRelativePath ('<root>/…'), which buildUploadFormData already
  // forwards as relativePaths — the backend recreates the tree.
  const handleFolderSelect = useCallback(
    async (fileList: FileList | File[]) => {
      const target = pendingUploadTargetRef.current;
      resetPendingUploadTarget();
      // Drop OS junk at ANY depth — match the drop path, which filters every
      // file by basename (a root-only check would let 'sub/.DS_Store' through).
      const files = Array.from(fileList).filter(
        (f) => !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(f.name),
      );
      await uploadFiles(files, target);
    },
    [resetPendingUploadTarget, uploadFiles],
  );

  // The tree also hosts internal row drags (moving files, see
  // useFileTreeMove). Those carry a custom MIME type instead of 'Files', so
  // every upload drag handler bails out of them — otherwise an internal drag
  // would raise the "drop files to upload" overlay and could hijack the drop.
  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files');

  const handleDragEnter = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // Only set isDragOver to false if we're leaving the entire tree
    if (treeRef.current && !treeRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
      setDropTarget(null);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const targetPath = dropTarget || '';

      try {
        const files = await collectDroppedFiles(e.dataTransfer);
        await uploadFiles(files, targetPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not read dropped files';
        console.error('Upload error:', err);
        showToast(message, 'error');
        setUploadError(message, 0, targetPath);
        setDropTarget(null);
      }
    },
    [dropTarget, setUploadError, showToast, uploadFiles],
  );

  // Per-row upload drop. Gated on a files drag for the same reason as the
  // tree-level handlers: an internal move drag must not set the upload target.
  const handleItemDragOver = useCallback((e: DragEvent, itemPath: string) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(itemPath);
  }, []);

  /** Leaving a directory row resets its upload target, so a drag that wanders
   *  off the row does not still upload into it on a later drop elsewhere. */
  const handleItemDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  // A row drop uploads into THAT row's directory. It stops propagation, so it
  // must perform the upload itself — the tree-level handler would never see
  // the event (and its `dropTarget` state is set asynchronously anyway).
  const handleItemDrop = useCallback(
    async (e: DragEvent, itemPath: string) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(itemPath);

      try {
        const files = await collectDroppedFiles(e.dataTransfer);
        await uploadFiles(files, itemPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not read dropped files';
        console.error('Upload error:', err);
        showToast(message, 'error');
        setUploadError(message, 0, itemPath);
        setDropTarget(null);
      }
    },
    [setUploadError, showToast, uploadFiles],
  );

  return {
    isDragOver,
    dropTarget,
    operationLoading,
    uploadProgress,
    treeRef,
    fileInputRef,
    folderInputRef,
    handleFileSelect,
    openFilePicker,
    openFolderPicker,
    handleFolderSelect,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleItemDragOver,
    handleItemDragLeave,
    handleItemDrop,
    setDropTarget,
  };
};
