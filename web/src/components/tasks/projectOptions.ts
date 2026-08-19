import type { Project } from '../../types/app';

/** 「Lovdex 助手」选项的哨兵 value。 */
export const ASSISTANT_OPTION_VALUE = '__lovdex_assistant__';

export const projectPathOf = (project: Project): string => project.fullPath || project.path || '';

/**
 * 任务表单的项目候选：排除操作员（Lovdex助手）工作目录——它由列表顶部的
 * 「🤖 Lovdex 助手」选项代表。主 Agent 工作目录（用户自己的主项目）保留可选。
 * 收藏优先，再按 displayName 升序。
 */
export function taskFormProjects(projects: Project[]): Project[] {
  return projects
    .filter((p) => !p.isOperatorWorkspace)
    .sort((a, b) => {
      const aStarred = Boolean(a.isStarred);
      const bStarred = Boolean(b.isStarred);
      if (aStarred !== bStarred) return aStarred ? -1 : 1;
      return (a.displayName || projectPathOf(a)).localeCompare(b.displayName || projectPathOf(b));
    });
}

/**
 * Display label for a project in a task form `<option>`. Native `<option>`
 * elements can only carry text (no styled badge), so the remote marker is a
 * `🌐 <hostName> ·` text prefix; the path shows in the option title.
 */
export function taskProjectLabel(project: Project, duplicateNames: Set<string>): string {
  const path = projectPathOf(project);
  const name = project.displayName || path;
  const base = duplicateNames.has(name) && name !== path ? `${name} — ${path}` : name;
  return project.remoteHostName ? `🌐 ${project.remoteHostName} · ${base}` : base;
}

/** TaskProjectOption ({ value, label } + remote fields) for the scheduled form. */
export function toProjectOption(
  project: Project,
  duplicateNames: Set<string>,
): { value: string; label: string; remoteHostId: string | null; remoteHostName: string | null } {
  const path = projectPathOf(project);
  const name = project.displayName || path;
  const label = duplicateNames.has(name) && name !== path ? `${name} — ${path}` : name;
  return {
    value: path,
    label,
    remoteHostId: project.remoteHostId ?? null,
    remoteHostName: project.remoteHostName ?? null,
  };
}
