import { api } from '../../../utils/api';
import { API_BASE_URL } from '../../../constants/config';
import type {
  BrowseFilesystemResponse,
  CloneProgressEvent,
  CreateFolderResponse,
  CreateProjectPayload,
  CreateProjectResponse,
  CreateRemoteProjectPayload,
  CredentialsResponse,
  FolderSuggestion,
  RemoteDirEntry,
  RemoteHostOption,
  TokenMode,
} from '../types';

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const fetchGithubTokenCredentials = async () => {
  const response = await api.get('/settings/credentials?type=github_token');
  const data = await parseJson<CredentialsResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load GitHub tokens');
  }

  return (data.credentials || []).filter((credential) => credential.is_active);
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const endpoint = `/browse-filesystem?path=${encodeURIComponent(pathToBrowse)}`;
  const response = await api.get(endpoint);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const createProjectRequest = async (payload: CreateProjectPayload) => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    throw new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create project');
  }

  return data.project;
};

type RemoteHostsListResponse = {
  data?: {
    hosts?: Array<{
      host_id: string;
      name: string;
      host: string;
      port: number;
      online: boolean;
    }>;
  };
};

type RemoteDirsResponse = {
  data?: { dirs?: RemoteDirEntry[]; path?: string };
  error?: string | { message?: string };
};

const resolveErrorText = (
  error: string | { message?: string } | undefined,
  fallback: string,
): string => {
  if (typeof error === 'string' && error.trim().length > 0) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return fallback;
};

/** Fetches remote hosts and returns only the ones currently online. */
export const fetchOnlineRemoteHosts = async (): Promise<RemoteHostOption[]> => {
  const response = await api.get('/remote-agents');
  const data = await parseJson<RemoteHostsListResponse>(response);
  if (!response.ok) {
    throw new Error('Failed to load remote hosts');
  }
  return (data.data?.hosts ?? [])
    .filter((host) => host.online)
    .map((host) => ({
      hostId: host.host_id,
      name: host.name,
      host: host.host,
      port: host.port,
      online: host.online,
    }));
};

/** Result of browsing one remote directory level: the RESOLVED absolute path
 * (the lite expands '~' and the response reflects the real path) + entries. */
export type RemoteDirBrowse = { path: string; dirs: RemoteDirEntry[] };

/** Browses one remote directory level for the remote path picker. */
export const browseRemoteDirs = async (
  hostId: string,
  parentPath: string,
): Promise<RemoteDirBrowse> => {
  const response = await api.get(
    `/remote-agents/${encodeURIComponent(hostId)}/dirs?path=${encodeURIComponent(parentPath)}`,
  );
  const data = await parseJson<RemoteDirsResponse>(response);
  if (!response.ok) {
    throw new Error(resolveErrorText(data.error, 'Failed to browse remote directory'));
  }
  return { path: data.data?.path ?? '', dirs: data.data?.dirs ?? [] };
};

/** Creates a remote-bound project; returns the created project like the local flow. */
export const createRemoteProjectRequest = async (payload: CreateRemoteProjectPayload) => {
  const response = await api.post('/projects/create-remote-project', {
    path: payload.path,
    remoteHostId: payload.remoteHostId,
    ...(payload.customName ? { customName: payload.customName } : {}),
  });
  const data = await parseJson<CreateProjectResponse>(response);
  if (!response.ok) {
    throw new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create remote project');
  }
  return data.project;
};

const buildCloneProgressQuery = ({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
}: CloneWorkspaceParams) => {
  const query = new URLSearchParams({
    path: workspacePath.trim(),
    githubUrl: githubUrl.trim(),
  });

  if (tokenMode === 'stored' && selectedGithubToken) {
    query.set('githubTokenId', selectedGithubToken);
  }

  if (tokenMode === 'new' && newGithubToken.trim()) {
    query.set('newGithubToken', newGithubToken.trim());
  }

  // EventSource cannot send custom headers, so the auth token is passed as query.
  const authToken = localStorage.getItem('auth-token');
  if (authToken) {
    query.set('token', authToken);
  }

  return query.toString();
};

export const cloneWorkspaceWithProgress = (
  params: CloneWorkspaceParams,
  handlers: CloneProgressHandlers,
) =>
  new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const query = buildCloneProgressQuery(params);
    const eventSource = new EventSource(`${API_BASE_URL}/api/projects/clone-progress?${query}`);
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as CloneProgressEvent;

        if (payload.type === 'progress' && payload.message) {
          handlers.onProgress(payload.message);
          return;
        }

        if (payload.type === 'complete') {
          settle(() => resolve(payload.project));
          return;
        }

        if (payload.type === 'error') {
          settle(() => reject(new Error(payload.message || 'Failed to clone repository')));
        }
      } catch (error) {
        console.error('Error parsing clone progress event:', error);
      }
    };

    eventSource.onerror = () => {
      settle(() => reject(new Error('Connection lost during clone')));
    };
  });
