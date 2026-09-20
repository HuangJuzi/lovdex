import { isAlertSeverity, type ParsedAlert } from './alert-format.js';

/** 只认 assistant 的文本消息；其它 kind/role 一律跳过（spec §4.1）。 */
type ScanMessage = { kind?: string; role?: string; content?: string };

// 捕获 ```lovdex-alert ... ``` 之间的正文。[\s\S] 跨行；?<json> 命名分组。
const FENCE_RE = /```lovdex-alert\s*\n(?<json>[\s\S]*?)```/g;

/**
 * 从一段 normalized 转录消息里提取所有合法的 lovdex-alert 标记。
 * 容错原则（spec §4.1）：非法 JSON / 缺 severity|title / 非法 severity 一律
 * console.warn 后丢弃，绝不 coerce。一条消息允许多个标记。
 */
export function parseAlertsFromMessages(messages: readonly ScanMessage[]): ParsedAlert[] {
  const out: ParsedAlert[] = [];
  for (const message of messages) {
    if (message.kind !== 'text' || message.role !== 'assistant') continue;
    const text = message.content;
    if (typeof text !== 'string' || !text.includes('lovdex-alert')) continue;

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
  }
  return out;
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
