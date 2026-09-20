/**
 * `lovdex-alert` 标记的格式约定 —— skill 正文与 prompt 注入共享的 single source
 * of truth（spec §3.2）。后端解析器（alert-parser.ts）认这份定义，skill 的
 * SKILL.md 也应由它生成/核对，避免两处漂移。
 */

export const ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** 一个已校验的告警标记（parser 输出）。 */
export type ParsedAlert = {
  severity: AlertSeverity;
  title: string;
  body?: string;
  code?: string;
};

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(value);
}

/** 代码块围栏的语言标记。 */
export const ALERT_FENCE_LANG = 'lovdex-alert';

/**
 * 注入巡检 prompt 或 skill 正文的约定文本。用户在巡检任务描述里带上它，
 * 模型据此在需要通知时输出标记。故意精简，能随 prompt 走到远程主机。
 */
export const ALERT_PROMPT_INSTRUCTION = [
  '当你需要通知用户（发现异常、需要关注的结果）时，在最终回复里输出一个代码块：',
  '',
  '```lovdex-alert',
  '{"severity":"warning","title":"一句话摘要","body":"详细描述（可选）","code":"稳定类别标识（可选，用于合并同类）"}',
  '```',
  '',
  'severity 取 critical / warning / info。无需通知时不要输出该代码块。',
].join('\n');
