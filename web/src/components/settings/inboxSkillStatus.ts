export type AlertSkillStatus = {
  installed: boolean;
  installedVersion: string | null;
  bundledVersion: string;
  hasUpdate: boolean;
  skillPath: string;
};

export type SkillStatusView = {
  switchOn: boolean;
  primaryLabel: string;
  versionLine: string;
  highlight: boolean;
};

/** 状态 → UI 文案/开关。纯函数，便于无 DOM 单测。 */
export function describeSkillStatus(status: AlertSkillStatus): SkillStatusView {
  const versionLine = status.installed
    ? `已安装 v${status.installedVersion} · 内置 v${status.bundledVersion}`
    : `内置 v${status.bundledVersion}`;
  return {
    switchOn: status.installed,
    primaryLabel: status.hasUpdate ? `更新到 v${status.bundledVersion}` : (status.installed ? '重装' : '安装'),
    versionLine,
    highlight: status.hasUpdate,
  };
}
