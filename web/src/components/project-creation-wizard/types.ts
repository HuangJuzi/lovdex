export type WizardStep = 1 | 2;

export type TokenMode = 'stored' | 'new' | 'none';

export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

export type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

export type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

export type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

export type ProjectSource = 'local' | 'remote';

export type CreateProjectPayload = {
  path: string;
  customName?: string;
};

/** Payload for POST /api/projects/create-remote-project (remote wizard mode). */
export type CreateRemoteProjectPayload = {
  path: string;
  remoteHostId: string;
  customName?: string;
};

/** Online remote host option surfaced in the wizard host `<select>`. */
export type RemoteHostOption = {
  hostId: string;
  name: string;
  host: string;
  port: number;
  online: boolean;
};

/** One entry from GET /api/remote-agents/:hostId/dirs. */
export type RemoteDirEntry = {
  name: string;
  type: string;
  size?: number;
};

export type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

export type CloneProgressEvent = {
  type?: string;
  message?: string;
  project?: Record<string, unknown>;
};

export type WizardFormState = {
  projectSource: ProjectSource;
  remoteHostId?: string;
  /** Display name of the selected remote host, resolved for the step-2 review. */
  remoteHostName?: string;
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};
