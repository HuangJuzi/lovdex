import { ALERT_PROMPT_INSTRUCTION } from './alert-format.js';

/** skill 目录名（`~/.claude/skills` 下的文件夹名）。 */
export const ALERT_SKILL_DIR = 'lovdex-inbox-alert';

/**
 * 约定格式的版本。**改动 `ALERT_PROMPT_INSTRUCTION` 或解析器认可的格式时必须
 * bump** —— 否则已安装的 skill 不会被提示更新，新旧格式会静默不一致。
 */
export const ALERT_SKILL_VERSION = '1.0.0';

/**
 * SKILL.md 的 description。模型靠它判断是否调用本 skill，所以触发词必须写在这里
 * （这是"提示词提到放到收件箱就自动触发"的实现方式）。
 */
export const ALERT_SKILL_DESCRIPTION =
  '把结果或异常发送到 Lovdex 收件箱并在浏览器通知用户。'
  + '当用户要求"放到收件箱"、"发到收件箱"、"通知我"、"有异常告警"、"汇报结果到收件箱"时使用。';

/** 生成 SKILL.md 全文（YAML frontmatter + 正文）。 */
export function buildAlertSkillMarkdown(): string {
  return [
    '---',
    `name: ${ALERT_SKILL_DIR}`,
    `description: ${ALERT_SKILL_DESCRIPTION}`,
    `version: ${ALERT_SKILL_VERSION}`,
    '---',
    '',
    '# Lovdex 收件箱告警上报',
    '',
    '本 skill 说明如何把结果或异常上报到 Lovdex 收件箱。收件箱会在浏览器弹窗、',
    '在侧边栏显示未读角标，并可在 /inbox 页面回看。',
    '',
    ALERT_PROMPT_INSTRUCTION,
    '',
    '## 合并规则',
    '',
    '同一个 `code` 的告警会被收件箱合并成一条并累计次数（显示 ×N），',
    '所以同一个问题反复出现不会刷屏。请为每类异常使用稳定的 `code`。',
    '',
  ].join('\n');
}
