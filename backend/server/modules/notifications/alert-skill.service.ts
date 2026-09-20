import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import {
  ALERT_SKILL_DIR,
  ALERT_SKILL_VERSION,
  buildAlertSkillMarkdown,
} from './alert-skill.js';

export type AlertSkillStatus = {
  installed: boolean;
  installedVersion: string | null;
  bundledVersion: string;
  hasUpdate: boolean;
  skillPath: string;
};

export type AlertSkillServiceDeps = {
  /** 覆盖 skill 根目录（测试注入临时目录）。默认 `~/.claude/skills`。 */
  skillsRoot?: string;
  /** 测试 seam；默认走 provider skills 服务（claude 的 global 源）。 */
  addSkill?: (provider: string, input: { entries: Array<{ content: string; directoryName?: string }> }) => Promise<unknown>;
  removeSkill?: (provider: string, input: { directoryName: string }) => Promise<unknown>;
};

/**
 * 收件箱 skill 的状态与安装。状态**每次从磁盘推导**，不落库 —— 避免 DB 与真实
 * 文件状态漂移（用户可能手动删了目录）。
 */
export function createAlertSkillService(deps: AlertSkillServiceDeps = {}) {
  const skillsRoot = deps.skillsRoot ?? path.join(os.homedir(), '.claude', 'skills');
  const addSkill = deps.addSkill ?? ((p, i) => providerSkillsService.addProviderSkills(p, i as never));
  const removeSkill = deps.removeSkill ?? ((p, i) => providerSkillsService.removeProviderSkill(p, i));
  const skillPath = path.join(skillsRoot, ALERT_SKILL_DIR, 'SKILL.md');

  function getStatus(): AlertSkillStatus {
    let installedVersion: string | null = null;
    try {
      const raw = fs.readFileSync(skillPath, 'utf8');
      const version = (parseFrontMatter(raw).data as Record<string, unknown> | undefined)?.version;
      installedVersion = typeof version === 'string' && version.trim() ? version.trim() : null;
    } catch {
      // 未安装 / 读不到 / frontmatter 缺失 → 一律按未安装处理
    }
    const installed = installedVersion !== null;
    return {
      installed,
      installedVersion,
      bundledVersion: ALERT_SKILL_VERSION,
      hasUpdate: installed && installedVersion !== ALERT_SKILL_VERSION,
      skillPath,
    };
  }

  /** 安装 / 更新 / 重装是同一个操作 —— addSkills 内部先 rm 整个技能目录再写。 */
  async function install(): Promise<AlertSkillStatus> {
    await addSkill('claude', {
      entries: [{ content: buildAlertSkillMarkdown(), directoryName: ALERT_SKILL_DIR }],
    });
    return getStatus();
  }

  async function uninstall(): Promise<AlertSkillStatus> {
    await removeSkill('claude', { directoryName: ALERT_SKILL_DIR });
    return getStatus();
  }

  return { getStatus, install, uninstall };
}

export type AlertSkillService = ReturnType<typeof createAlertSkillService>;
