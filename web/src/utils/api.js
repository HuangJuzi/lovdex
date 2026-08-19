import { IS_PLATFORM, API_BASE_URL } from "../constants/config";

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
/**
 * @param {unknown} token
 * @returns {token is string}
 */
export const isValidRefreshedToken = (token) =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

// Token helpers used by XHR-based flows (e.g. file uploads that need
// upload.onprogress and therefore can't go through authenticatedFetch).
// They mirror the inline auth handling in authenticatedFetch below.
export const getStoredAuthToken = () => localStorage.getItem('auth-token');

export const storeAuthToken = (token) => {
  if (!isValidRefreshedToken(token)) {
    return false;
  }
  localStorage.setItem('auth-token', token);
  return true;
};

export const expireAuthSession = () => {
  localStorage.removeItem('auth-token');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('auth:unauthorized'));
  }
};

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM() && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (isValidRefreshedToken(refreshedToken)) {
      localStorage.setItem('auth-token', refreshedToken);
    }
    if (response.status === 401) {
      // Token expired or invalid mid-session: drop it and bounce to the login
      // page (AuthGate listens for this event). Login itself uses raw fetch and
      // never reaches this interceptor.
      localStorage.removeItem('auth-token');
      window.dispatchEvent(new Event('auth:unauthorized'));
    }
    return response;
  });
};

// API endpoints
export const api = {
  // Auth endpoints. login is public (no token needed); me validates a stored
  // token so the app can boot straight into an authenticated session.
  auth: {
    login: (email, code) =>
      fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      }),
    me: () => authenticatedFetch('/api/auth/me'),
    // changePassword uses a raw fetch (not authenticatedFetch) so a wrong
    // current password (401) doesn't trigger the global "token expired" logout.
    changePassword: (currentCode, newCode) => {
      const token = localStorage.getItem('auth-token');
      return fetch(`${API_BASE_URL}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(!IS_PLATFORM() && token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ currentCode, newCode }),
      });
    },
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => authenticatedFetch('/api/projects'),
  archivedProjects: () => authenticatedFetch('/api/projects/archived'),
  projectSessions: (projectId, { limit = 20, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params.toString()}`);
  },
  projectTaskmaster: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectId, displayName) =>
    authenticatedFetch(`/api/projects/${projectId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  restoreProject: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
  // Session deletion now mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) {
      params.set('force', 'true');
    }
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${sessionId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  getArchivedSessions: () =>
    authenticatedFetch('/api/providers/sessions/archived'),
  runningSessions: () =>
    authenticatedFetch('/api/providers/sessions/running'),
  restoreSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}/restore`, {
      method: 'POST',
    }),
  forkSession: (appId, body) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(appId)}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  rewindSession: (appId, body) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(appId)}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  renameSession: (sessionId, summary) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    }),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) params.set('force', 'true');
    const qs = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem('auth-token');
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `${API_BASE_URL}/api/providers/search/sessions?${params.toString()}`;
  },
  createProject: (projectData) =>
    authenticatedFetch('/api/projects/create-project', {
      method: 'POST',
      body: JSON.stringify(projectData),
    }),
  migrateLegacyProjectStars: (projectIds) =>
    authenticatedFetch('/api/projects/migrate-legacy-stars', {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    }),
  toggleProjectStar: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`, {
      method: 'POST',
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectId, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectId, options = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, options),

  // Provider install availability used to filter the provider picker.
  // Local (this machine): backend-side probe with a 60s TTL cache.
  getInstalledProviders() {
    return authenticatedFetch('/api/providers/installed')
      .then(async (res) => (await res.json())?.data?.providers ?? []);
  },
  // Remote host: registry cache over the lite's `hello` providers payload /
  // a prior `providers/probe` rpc; `refresh` re-runs the probe.
  getRemoteHostProviders(hostId, { refresh = false } = {}) {
    const q = refresh ? '?refresh=1' : '';
    return authenticatedFetch(`/api/remote-agents/${hostId}/providers${q}`)
      .then(async (res) => (await res.json())?.data?.providers ?? []);
  },

  // File operations
  createFile: (projectId, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectId, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectId, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectId, formData) =>
    authenticatedFetch(`/api/projects/${projectId}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectId) =>
      authenticatedFetch(`/api/taskmaster/init/${projectId}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectId, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectId, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectId, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectId, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectId}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Task endpoints — the task board (columns: todo/in_progress/in_review/done).
  tasks: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.projectPath) qs.set('projectPath', params.projectPath);
      if (params.status) qs.set('status', params.status);
      const s = qs.toString();
      return authenticatedFetch(`/api/tasks${s ? `?${s}` : ''}`);
    },
    create: (body) => authenticatedFetch('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
    get: (taskId) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}`),
    update: (taskId, body) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    startExecution: (taskId) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}/start-execution`, { method: 'POST' }),
    move: (taskId, body) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}/move`, { method: 'POST', body: JSON.stringify(body) }),
    remove: (taskId) => authenticatedFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
    removeMany: (taskIds) =>
      authenticatedFetch('/api/tasks/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ taskIds }),
      }),
    bySession: (sessionId) => authenticatedFetch(`/api/tasks/by-session/${encodeURIComponent(sessionId)}`),
  },

  scheduledTasks: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.projectPath) qs.set('projectPath', params.projectPath);
      if (params.enabled !== undefined) qs.set('enabled', params.enabled ? 'true' : 'false');
      const s = qs.toString();
      return authenticatedFetch(`/api/scheduled-tasks${s ? `?${s}` : ''}`);
    },
    create: (body) => authenticatedFetch('/api/scheduled-tasks', { method: 'POST', body: JSON.stringify(body) }),
    get: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}`),
    update: (scheduleId, body) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' }),
    runNow: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}/run-now`, { method: 'POST' }),
    enable: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}/enable`, { method: 'POST' }),
    disable: (scheduleId) => authenticatedFetch(`/api/scheduled-tasks/${encodeURIComponent(scheduleId)}/disable`, { method: 'POST' }),
  },

  // Operator Agent configuration (auto-verdict, auto-move, model, concurrency).
  operator: {
    settings: () => authenticatedFetch('/api/operator/settings'),
    updateSettings: (body) =>
      authenticatedFetch('/api/operator/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    // List operator assistant sessions (is_operator = 1, not archived).
    listSessions: () => authenticatedFetch('/api/providers/sessions/operator'),
    // Create an operator assistant session. The workspace is bound to the
    // backend (operator config) — the client does not pass a projectPath.
    // Provider is chosen in the new-session dialog (defaults to claude).
    createSession: (provider = 'claude') =>
      authenticatedFetch('/api/providers/sessions', {
        method: 'POST',
        body: JSON.stringify({ provider, isOperator: true }),
      }),
    // Skill-execution settings (phase 2): allowlist, credentials, audit.
    // Credential endpoints never return plaintext — presence booleans only.
    getAllowlist: () => authenticatedFetch('/api/operator/skill-exec/allowlist'),
    updateAllowlist: (body) =>
      authenticatedFetch('/api/operator/skill-exec/allowlist', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    resetAllowlist: () =>
      authenticatedFetch('/api/operator/skill-exec/allowlist', { method: 'DELETE' }),
    credentialStatus: () => authenticatedFetch('/api/operator/skill-exec/credentials/status'),
    saveCredentials: (body) =>
      authenticatedFetch('/api/operator/skill-exec/credentials', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    testCredentials: () =>
      authenticatedFetch('/api/operator/skill-exec/credentials/test', { method: 'POST' }),
    execAudit: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.tool) qs.set('tool', params.tool);
      if (params.decision) qs.set('decision', params.decision);
      if (params.limit) qs.set('limit', String(params.limit));
      const s = qs.toString();
      return authenticatedFetch(`/api/operator/skill-exec/audit${s ? `?${s}` : ''}`);
    },
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
