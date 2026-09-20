import type { ConfirmActionType, FileStatusCode, GitStatusGroupEntry } from '../types/types';

export const DEFAULT_BRANCH = 'main';
// High enough for the commit graph to show meaningful branch structure.
export const RECENT_COMMITS_LIMIT = 50;

export const FILE_STATUS_GROUPS: GitStatusGroupEntry[] = [
  { key: 'modified', status: 'M' },
  { key: 'added', status: 'A' },
  { key: 'deleted', status: 'D' },
  { key: 'untracked', status: 'U' },
];

export const FILE_STATUS_LABELS: Record<FileStatusCode, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  U: 'Untracked',
};

export const FILE_STATUS_BADGE_CLASSES: Record<FileStatusCode, string> = {
  M: 'bg-warning/10 text-warning border-warning/30',
  A: 'bg-success/10 text-success border-success/30',
  D: 'bg-destructive/10 text-destructive border-destructive/30',
  U: 'bg-muted text-muted-foreground border-border',
};

export const CONFIRMATION_TITLES: Record<ConfirmActionType, string> = {
  discard: 'Discard Changes',
  delete: 'Delete File',
  commit: 'Confirm Action',
  pull: 'Confirm Pull',
  push: 'Confirm Push',
  publish: 'Publish Branch',
  revertLocalCommit: 'Revert Local Commit',
  deleteBranch: 'Delete Branch',
};

export const CONFIRMATION_ACTION_LABELS: Record<ConfirmActionType, string> = {
  discard: 'Discard',
  delete: 'Delete',
  commit: 'Confirm',
  pull: 'Pull',
  push: 'Push',
  publish: 'Publish',
  revertLocalCommit: 'Revert Commit',
  deleteBranch: 'Delete',
};

export const CONFIRMATION_BUTTON_CLASSES: Record<ConfirmActionType, string> = {
  discard: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  delete: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  commit: 'bg-primary text-primary-foreground hover:bg-primary/90',
  pull: 'bg-success text-success-foreground hover:bg-success/90',
  push: 'bg-warning text-warning-foreground hover:bg-warning/90',
  publish: 'bg-primary text-primary-foreground hover:bg-primary/90',
  revertLocalCommit: 'bg-warning text-warning-foreground hover:bg-warning/90',
  deleteBranch: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
};

export const CONFIRMATION_ICON_CONTAINER_CLASSES: Record<ConfirmActionType, string> = {
  discard: 'bg-destructive/10',
  delete: 'bg-destructive/10',
  commit: 'bg-warning/10',
  pull: 'bg-warning/10',
  push: 'bg-warning/10',
  publish: 'bg-warning/10',
  revertLocalCommit: 'bg-warning/10',
  deleteBranch: 'bg-destructive/10',
};

export const CONFIRMATION_ICON_CLASSES: Record<ConfirmActionType, string> = {
  discard: 'text-destructive',
  delete: 'text-destructive',
  commit: 'text-warning',
  pull: 'text-warning',
  push: 'text-warning',
  publish: 'text-warning',
  revertLocalCommit: 'text-warning',
  deleteBranch: 'text-destructive',
};
