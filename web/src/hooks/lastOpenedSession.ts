import type { Project, ProjectSession } from '../types/app';

export const LAST_OPENED_SESSION_KEY = 'lovdex:last-opened-session';

export function readLastOpenedSessionId(): string | null {
  try {
    return localStorage.getItem(LAST_OPENED_SESSION_KEY);
  } catch {
    return null;
  }
}

export function writeLastOpenedSessionId(sessionId: string): void {
  try {
    localStorage.setItem(LAST_OPENED_SESSION_KEY, sessionId);
  } catch {
    // localStorage unavailable — ignore
  }
}

export function clearLastOpenedSessionId(): void {
  try {
    localStorage.removeItem(LAST_OPENED_SESSION_KEY);
  } catch {
    // localStorage unavailable — ignore
  }
}

/** 在 projects 里按 session id 找归属项目与 session；找不到返回 null。 */
export function findProjectSessionById(
  projects: Project[],
  sessionId: string,
): { project: Project; session: ProjectSession } | null {
  for (const project of projects) {
    const match = project.sessions?.find((s) => s.id === sessionId);
    if (match) {
      return { project, session: match };
    }
  }
  return null;
}
