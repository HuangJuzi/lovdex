import type { TFunction } from 'i18next';

import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import { resolveSessionTitle } from '../../../utils/sessionTitle';
import type { ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider } from '../types/types';

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const getCreatedTimestamp = (session: ProjectSession): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: ProjectSession): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

export const getSessionDate = (session: ProjectSession): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return resolveSessionTitle(session) || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

/**
 * Compact relative time for sidebar rows:
 * <1m, Xm, Xhr, Xd. 返回空串表示无法解析。
 */
export const formatCompactSessionAge = (dateString: string, currentTime: Date): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }

  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d`;
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  return (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
};

/** 一条「最近任务」记录：会话 + 其所属项目。 */
export type RecentSessionEntry = {
  session: ProjectSession;
  project: Project;
};

/**
 * 跨项目打平会话，按最近活跃（lastActivity ?? createdAt）倒序，取前 limit 条。
 * 含助手（is_operator）会话——不排除 operator 工作区项目。
 * 每项目已加载 top-20 活跃会话，足以覆盖全局 top-10。
 */
export const getRecentSessions = (projects: Project[], limit = 10): RecentSessionEntry[] =>
  projects
    .flatMap((project) =>
      (project.sessions ?? []).map((session) => ({ session, project })),
    )
    .sort(
      (a, b) => getSessionDate(b.session).getTime() - getSessionDate(a.session).getTime(),
    )
    .slice(0, limit);

export const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

/** Sessions with activity within this window count as active. */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** True when the session's last activity is within the 10-minute active window. */
export const isSessionRecentlyActive = (
  session: ProjectSession,
  currentTime: Date,
): boolean => {
  return currentTime.getTime() - getSessionDate(session).getTime() < ACTIVE_WINDOW_MS;
};

/** True when the session is running OR was recently active. */
export const isSessionActive = (
  session: ProjectSession,
  activeSessionIds: ReadonlySet<string>,
  currentTime: Date,
): boolean => {
  return activeSessionIds.has(String(session.id)) || isSessionRecentlyActive(session, currentTime);
};

/** True when any of the project's loaded sessions is active (running or recent). */
export const isProjectActive = (
  project: Project,
  activeSessionIds: ReadonlySet<string>,
  currentTime: Date,
): boolean => {
  return (project.sessions ?? []).some((session) => isSessionActive(session, activeSessionIds, currentTime));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
  activeSessionIds: ReadonlySet<string>,
  currentTime: Date,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Projects with an active session (running or recent) float to the top,
    // ahead of starred projects and the name/date order.
    const aActive = isProjectActive(projectA, activeSessionIds, currentTime);
    const bActive = isProjectActive(projectB, activeSessionIds, currentTime);

    if (aActive && !bActive) {
      return -1;
    }

    if (!aActive && bActive) {
      return 1;
    }

    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export type SessionDotState = 'attention' | 'active' | 'idle';

/** Status column for a session row: needs-attention > active > idle. */
export const getSessionDotState = (
  needsAttention: boolean,
  isActive: boolean,
): SessionDotState => {
  if (needsAttention) {
    return 'attention';
  }
  if (isActive) {
    return 'active';
  }
  return 'idle';
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

/**
 * 侧边栏项目列表过滤：隐藏 operator 工作区（Lovdex助手）项目。会话数据保留在
 * 全局 projects state 里供 /session/:id 路由解析，这里只做渲染层过滤。
 */
export const excludeHiddenProjects = (projects: Project[]): Project[] =>
  projects.filter((project) => !project.isOperatorWorkspace);

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
