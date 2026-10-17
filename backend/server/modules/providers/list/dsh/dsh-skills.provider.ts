import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

// dsh skill discovery (dsh-skill-filesystem) scans four default roots:
// `<projectRoot>/.dsh/skills` and `<projectRoot>/.agents/skills` (project,
// projectRoot = nearest `.git` ancestor), then `~/.dsh/skills` and
// `~/.agents/skills` (user; agentsHome defaults to ~/.agents). The manifest is
// a `SKILL.md` directory bundle or a flat `<name>.md` at the top level.
const DSH_PROJECT_SKILL_DIRS = [['.dsh', 'skills'], ['.agents', 'skills']];
const DSH_USER_SKILL_DIRS = [['.dsh', 'skills'], ['.agents', 'skills']];

export class DshSkillsProvider extends SkillsProvider {
  constructor() {
    super('dsh');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    for (const projectRoot of this.getProjectSearchRoots(workspacePath, repoRoot)) {
      for (const skillDir of DSH_PROJECT_SKILL_DIRS) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(projectRoot, ...skillDir),
          commandPrefix: '/',
        });
      }
    }

    for (const skillDir of DSH_USER_SKILL_DIRS) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir: path.join(os.homedir(), ...skillDir),
        commandPrefix: '/',
      });
    }

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.dsh', 'skills'),
      commandPrefix: '/',
    };
  }

  private getProjectSearchRoots(workspacePath: string, repoRoot: string | null): string[] {
    const roots: string[] = [];
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const normalizedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
    let currentPath = normalizedWorkspacePath;

    while (true) {
      roots.push(currentPath);
      if (!normalizedRepoRoot || currentPath === normalizedRepoRoot) {
        break;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }

    return roots;
  }
}
