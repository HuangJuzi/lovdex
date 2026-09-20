import { isAlertSeverity, type ParsedAlert } from './alert-format.js';

/** 只认 assistant 的文本消息；其它 kind/role 一律跳过（spec §4.1）。 */
type ScanMessage = { kind?: string; role?: string; content?: string };

// 捕获 ```lovdex-alert ... ``` 之间的正文。[\s\S] 跨行；?<json> 命名分组。
const FENCE_RE = /```lovdex-alert\s*\n(?<json>[\s\S]*?)```/g;

/**
 * 从一段 normalized 转录消息里提取所有合法的 lovdex-alert 标记。
 *
 * **只扫最后一条 assistant 文本**：约定要求标记出现在"最终回复"里
 * （ALERT_PROMPT_INSTRUCTION），而一次 run 的 events 里会有多条 assistant 文本
 * —— 多步 agentic 循环的中间说明、子 agent 的输出都算。全量扫描会把"解释这个
 * 格式"时写出的示例块当成真通知（上线首日实测到一次）。收窄到最后一条既贴合
 * 约定，也顺带免疫 events 缓冲的头部截断（chat-run-registry 丢最旧的 event）。
 *
 * 容错原则（spec §4.1）：非法 JSON / 缺 severity|title / 非法 severity 一律
 * console.warn 后丢弃，绝不 coerce。一条消息允许多个标记。
 */
export function parseAlertsFromMessages(messages: readonly ScanMessage[]): ParsedAlert[] {
  const text = lastAssistantText(messages);
  if (text === null || !text.includes('lovdex-alert')) return [];

  const out: ParsedAlert[] = [];
  for (const match of text.matchAll(FENCE_RE)) {
    const raw = match.groups?.json?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[notifications] discarded lovdex-alert: invalid JSON');
      continue;
    }
    const alert = coerceAlert(parsed);
    if (alert) out.push(alert);
  }
  return out;
}

/**
 * 最后一条 assistant 文本消息的内容。纯按位置选 —— 不看它是否含标记，否则会
 * "回退"到更早那条带示例块的消息，正是本次要消灭的误报。
 */
function lastAssistantText(messages: readonly ScanMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.kind === 'text' && message.role === 'assistant' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return null;
}

function coerceAlert(value: unknown): ParsedAlert | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isAlertSeverity(record.severity)) {
    console.warn('[notifications] discarded lovdex-alert: bad severity', record.severity);
    return null;
  }
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    console.warn('[notifications] discarded lovdex-alert: missing title');
    return null;
  }
  const alert: ParsedAlert = { severity: record.severity, title: record.title.trim() };
  if (typeof record.body === 'string' && record.body.trim() !== '') alert.body = record.body.trim();
  if (typeof record.code === 'string' && record.code.trim() !== '') alert.code = record.code.trim();
  return alert;
}
