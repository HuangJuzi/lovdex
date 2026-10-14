import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import JSZip from 'jszip';
import { api } from '../../../utils/api';
import { copyTextToClipboard } from '../../../utils/clipboard';
import type { FileTreeNode } from '../types/types';
import type { Project } from '../../../types/app';

// Invalid filename characters
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export type ToastMessage = {
  message: string;
  type: 'success' | 'error';
};

export type DeleteConfirmation = {
  isOpen: boolean;
  item: FileTreeNode | null;
  // 多选批量删除：非空时 item 为 null
  items: FileTreeNode[] | null;
};

export type UseFileTreeOperationsOptions = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
};

export type UseFileTreeOperationsResult = {
  // Rename operations
  renamingItem: FileTreeNode | null;
  renameValue: string;
  handleStartRename: (item: FileTreeNode) => void;
  handleCancelRename: () => void;
  handleConfirmRename: () => Promise<void>;
  setRenameValue: (value: string) => void;

  // Delete operations
  deleteConfirmation: DeleteConfirmation;
  handleStartDelete: (item: FileTreeNode) => void;
  handleStartDeleteMany: (items: FileTreeNode[]) => void;
  handleCancelDelete: () => void;
  handleConfirmDelete: () => Promise<void>;

  // Create operations
  isCreating: boolean;
  newItemParent: string;
  newItemType: 'file' | 'directory';
  newItemName: string;
  handleStartCreate: (parentPath: string, type: 'file' | 'directory') => void;
  handleCancelCreate: () => void;
  handleConfirmCreate: () => Promise<void>;
  setNewItemName: (name: string) => void;

  // Other operations
  handleCopyPath: (item: FileTreeNode) => void;
  handleDownload: (item: FileTreeNode) => Promise<void>;
  downloadItemsAsZip: (items: FileTreeNode[], zipName: string) => Promise<void>;

  // Loading state
  operationLoading: boolean;

  // Validation
  validateFilename: (name: string) => string | null;
};

export function useFileTreeOperations({
  selectedProject,
  onRefresh,
  showToast,
}: UseFileTreeOperationsOptions): UseFileTreeOperationsResult {
  const { t } = useTranslation();

  // State
  const [renamingItem, setRenamingItem] = useState<FileTreeNode | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation>({
    isOpen: false,
    item: null,
    items: null,
  });
  const [isCreating, setIsCreating] = useState(false);
  const [newItemParent, setNewItemParent] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file');
  const [newItemName, setNewItemName] = useState('');
  const [operationLoading, setOperationLoading] = useState(false);

  // Validation
  const validateFilename = useCallback((name: string): string | null => {
    if (!name || !name.trim()) {
      return t('fileTree.validation.emptyName', 'Filename cannot be empty');
    }
    if (INVALID_FILENAME_CHARS.test(name)) {
      return t('fileTree.validation.invalidChars', 'Filename contains invalid characters');
    }
    if (RESERVED_NAMES.test(name)) {
      return t('fileTree.validation.reserved', 'Filename is a reserved name');
    }
    if (/^\.+$/.test(name)) {
      return t('fileTree.validation.dotsOnly', 'Filename cannot be only dots');
    }
    return null;
  }, [t]);

  // Rename operations
  const handleStartRename = useCallback((item: FileTreeNode) => {
    setRenamingItem(item);
    setRenameValue(item.name);
    setIsCreating(false);
  }, []);

  const handleCancelRename = useCallback(() => {
    setRenamingItem(null);
    setRenameValue('');
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renamingItem || !selectedProject) return;

    const error = validateFilename(renameValue);
    if (error) {
      showToast(error, 'error');
      return;
    }

    if (renameValue === renamingItem.name) {
      handleCancelRename();
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.renameFile(selectedProject.projectId, {
        oldPath: renamingItem.path,
        newName: renameValue,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to rename');
      }

      showToast(t('fileTree.toast.renamed', 'Renamed successfully'), 'success');
      onRefresh();
      handleCancelRename();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [renamingItem, renameValue, selectedProject, validateFilename, showToast, t, onRefresh, handleCancelRename]);

  // Delete operations
  const handleStartDelete = useCallback((item: FileTreeNode) => {
    setDeleteConfirmation({ isOpen: true, item, items: null });
  }, []);

  // Multi-select delete: the confirmation dialog lists the batch instead of a
  // single item. Each entry is deleted with its own request so one failure
  // cannot mask the rest — the spec keeps this deliberately un-batched.
  const handleStartDeleteMany = useCallback((items: FileTreeNode[]) => {
    if (items.length === 0) return;
    setDeleteConfirmation({ isOpen: true, item: null, items });
  }, []);

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirmation({ isOpen: false, item: null, items: null });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    const { item, items } = deleteConfirmation;
    if (!selectedProject) return;
    if (!item && (!items || items.length === 0)) return;

    setOperationLoading(true);
    try {
      const targets = item ? [item] : items ?? [];
      const failed: string[] = [];
      let failureReason = '';
      for (const target of targets) {
        try {
          const response = await api.deleteFile(selectedProject.projectId, {
            path: target.path,
            type: target.type,
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to delete');
          }
        } catch (err) {
          console.error('Delete failed for', target.path, err);
          if (!failureReason) failureReason = (err as Error).message;
          // Report the PATH, not the name: two same-named files in different
          // folders would otherwise be indistinguishable in the toast.
          failed.push(target.path);
        }
      }

      if (failed.length === 0) {
        showToast(
          targets.length === 1
            ? t('fileTree.toast.deleted', 'Deleted successfully')
            : t('fileTree.toast.deletedMany', 'Deleted {{count}} items', { count: targets.length }),
          'success',
        );
      } else if (failed.length === targets.length) {
        showToast(
          targets.length === 1
            ? t('fileTree.toast.deleteFailedReason', 'Failed to delete: {{reason}}', { reason: failureReason })
            : t('fileTree.toast.deleteFailed', 'Failed to delete'),
          'error',
        );
      } else {
        showToast(
          t('fileTree.toast.deletePartial', 'Deleted {{ok}} of {{count}}; failed: {{failed}}', {
            ok: targets.length - failed.length,
            count: targets.length,
            failed: failed.join(', '),
          }),
          'error',
        );
      }

      onRefresh();
      handleCancelDelete();
    } finally {
      setOperationLoading(false);
    }
  }, [deleteConfirmation, selectedProject, showToast, t, onRefresh, handleCancelDelete]);

  // Create operations
  const handleStartCreate = useCallback((parentPath: string, type: 'file' | 'directory') => {
    setNewItemParent(parentPath || '');
    setNewItemType(type);
    setNewItemName(type === 'file' ? 'untitled.txt' : 'new-folder');
    setIsCreating(true);
    setRenamingItem(null);
  }, []);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
    setNewItemParent('');
    setNewItemName('');
  }, []);

  const handleConfirmCreate = useCallback(async () => {
    if (!selectedProject) return;

    const error = validateFilename(newItemName);
    if (error) {
      showToast(error, 'error');
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.createFile(selectedProject.projectId, {
        path: newItemParent,
        type: newItemType,
        name: newItemName,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create');
      }

      showToast(
        newItemType === 'file'
          ? t('fileTree.toast.fileCreated', 'File created successfully')
          : t('fileTree.toast.folderCreated', 'Folder created successfully'),
        'success'
      );
      onRefresh();
      handleCancelCreate();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [selectedProject, newItemParent, newItemType, newItemName, validateFilename, showToast, t, onRefresh, handleCancelCreate]);

  // Copy path to clipboard. The Clipboard API only exists in a secure context,
  // and the app is routinely reached over http://<lan-ip>, where
  // navigator.clipboard is undefined — calling it directly throws and copies
  // nothing. copyTextToClipboard falls back to execCommand there, and its
  // boolean is the only reliable signal of whether anything was copied.
  const handleCopyPath = useCallback(async (item: FileTreeNode) => {
    const copied = await copyTextToClipboard(item.path);
    showToast(
      copied
        ? t('fileTree.toast.pathCopied', 'Path copied to clipboard')
        : t('fileTree.toast.copyFailed', 'Failed to copy path'),
      copied ? 'success' : 'error',
    );
  }, [showToast, t]);

  const triggerBrowserDownload = useCallback((blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = fileName;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, []);

  // Download file or folder
  const handleDownload = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    setOperationLoading(true);
    try {
      if (item.type === 'directory') {
        // Download folder as ZIP
        await downloadFolderAsZip(item);
      } else {
        // Download single file
        await downloadSingleFile(item);
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [selectedProject, showToast]);

  // Download a single file
  const downloadSingleFile = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    // Use the binary streaming endpoint so downloads preserve raw bytes.
    const response = await api.readFileBlob(selectedProject.projectId, item.path);

    if (!response.ok) {
      throw new Error('Failed to download file');
    }

    const blob = await response.blob();
    triggerBrowserDownload(blob, item.name);
  }, [selectedProject, triggerBrowserDownload]);

  // Download items as a single ZIP. Zip-internal paths keep the top-level
  // entry's name as the root (choice (b) in the task): flattening folders
  // straight into the archive root would collide when several selected
  // folders contain a file of the same name, and the root segment makes it
  // obvious which selection each entry came from.
  const collectNodeIntoZip = useCallback(
    async (zip: JSZip, node: FileTreeNode, zipPath: string, skipped: string[]) => {
      if (node.type === 'file') {
        const response = await api.readFileBlob(selectedProject!.projectId, node.path);
        if (!response.ok) {
          // Remote 413 (>32MB) and missing files skip with a report rather
          // than failing the whole archive.
          skipped.push(node.path);
          return;
        }
        // Store raw bytes so binary files stay intact.
        const fileBytes = await response.arrayBuffer();
        zip.file(zipPath, fileBytes);
        return;
      }
      for (const child of node.children ?? []) {
        await collectNodeIntoZip(
          zip,
          child,
          zipPath ? `${zipPath}/${child.name}` : child.name,
          skipped,
        );
      }
    },
    [selectedProject],
  );

  const downloadItemsAsZip = useCallback(
    async (items: FileTreeNode[], zipName: string) => {
      if (!selectedProject || items.length === 0) return;

      setOperationLoading(true);
      try {
        const zip = new JSZip();
        const skipped: string[] = [];
        for (const item of items) {
          await collectNodeIntoZip(zip, item, item.name, skipped);
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        triggerBrowserDownload(zipBlob, zipName);

        if (skipped.length > 0) {
          showToast(
            t('fileTree.toast.zipSkipped', 'Downloaded, but skipped (too large or unreadable): {{names}}', {
              names: skipped.join(', '),
            }),
            'error',
          );
        } else {
          showToast(t('fileTree.toast.folderDownloaded', 'Folder downloaded as ZIP'), 'success');
        }
      } catch (err) {
        showToast((err as Error).message, 'error');
      } finally {
        setOperationLoading(false);
      }
    },
    [selectedProject, showToast, t, triggerBrowserDownload, collectNodeIntoZip],
  );

  // Download a single folder as ZIP (context-menu entry point).
  const downloadFolderAsZip = useCallback(
    async (folder: FileTreeNode) => {
      await downloadItemsAsZip([folder], `${folder.name}.zip`);
    },
    [downloadItemsAsZip],
  );

  return {
    // Rename operations
    renamingItem,
    renameValue,
    handleStartRename,
    handleCancelRename,
    handleConfirmRename,
    setRenameValue,

    // Delete operations
    deleteConfirmation,
    handleStartDelete,
    handleStartDeleteMany,
    handleCancelDelete,
    handleConfirmDelete,

    // Create operations
    isCreating,
    newItemParent,
    newItemType,
    newItemName,
    handleStartCreate,
    handleCancelCreate,
    handleConfirmCreate,
    setNewItemName,

    // Other operations
    handleCopyPath,
    handleDownload,
    downloadItemsAsZip,

    // Loading state
    operationLoading,

    // Validation
    validateFilename,
  };
}
