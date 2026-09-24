import type { Project } from '../../types/app';

import type { ChipSelectOption } from './ChipSelect';
import type { TaskProjectOption } from './TaskCard';

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

/**
 * 该「项目路径」是否指向 Lovdex 助手（而非某个真实项目目录）。
 *
 * 判据与 `CreateTaskDialog.tsx:64` 逐字一致：哨兵值或空串。空串这一支是必要的
 * ——后端把助手目标的 `project_path` 存成 NULL，`toDraft` 会回填哨兵值，但任何
 * 漏了回填的路径传进来都是空串，两种写法都得当助手处理。
 *
 * 抽成纯函数是为了能在无 DOM 环境下直接断言：组件里两处消费（chip 置灰、提示行）
 * 依赖它，而静态渲染下两个 chip 本来就因「加载中」而 disabled，断言不出这个改动。
 */
export function isAssistantTarget(projectPath: string): boolean {
  return projectPath === ASSISTANT_OPTION_VALUE || !projectPath;
}

/**
 * 定时任务表单「项目」chip 的选项：助手选项**恒排第一**，其后是项目列表。
 *
 * 助手那一项不在 `projectOptions` 里 —— 调用方传进来的已经过 `taskFormProjects()`
 * 过滤（助手工作区被排除）。少了这一项，`EMPTY_DRAFT.projectPath` 的助手哨兵值
 * 就找不到匹配项，ChipSelect 会回退显示裸的「项目」二字：用户既看不出新建的表单
 * 其实指向助手，一旦选了别的项目也切不回来。
 *
 * 文案与排序对齐 `CreateTaskDialog.tsx:199` 的同名选项（🤖 前缀 + 置顶）。
 */
export function taskFormProjectChipOptions(projectOptions: TaskProjectOption[]): ChipSelectOption[] {
  return [
    { value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' },
    ...projectOptions.map((o) => ({
      value: o.value,
      label: o.label,
      hint: o.remoteHostName ?? undefined,
    })),
  ];
}
