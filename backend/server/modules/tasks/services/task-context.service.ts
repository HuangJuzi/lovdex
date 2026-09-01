/**
 * Task-context compression: turn a source session's transcript into a compact
 * fixed-template context summary, persisted on the task as `context_summary`.
 *
 * Flow (spec 2026-08-31-task-context-source-design):
 *   POST /api/tasks { sourceSessionId } → createTask 校验 + onContextSourceProvided
 *   → scheduleTaskContextCompression (fire-and-forget, in-flight dedupe)
 *   → fetchHistory(sourceSession) → compactTranscriptToText → runOneShot (headless
 *   Claude) → writeBack(task_id, summary).
 *
 * All failures are swallowed + reported via onError — compression must never
 * block the created task or crash the caller. The task is created normally with
 * context_summary NULL; the summary arrives later asynchronously.
 *
 * `runOneShot` defaults to the real headless helper in claude-sdk.js (lazy
 * import so unit tests never pull the SDK); `writeBack` defaults to a
 * tasks-service hook passed by the caller (avoids a hard service dependency).
 */

export type TaskContextCompressionDeps = {
  fetchHistory: (sessionId: string, opts?: { limit?: number; offset?: number }) => Promise<{ messages?: unknown[] }>;
  runOneShot: (args: { prompt: string; systemPrompt: string; model?: string }) => Promise<string | null>;
  writeBack: (taskId: string, summary: string) => void;
};

export type TaskContextCompressionArgs = {
  sourceSessionId: string;
  taskId: string;
  title: string;
  deps: TaskContextCompressionDeps;
  onError?: (error: unknown) => void;
};

/** Max messages pulled from the source transcript. */
const MAX_MESSAGES = 200;

/**
 * Compact normalized session messages to plain text so the compression prompt
 * does not blow the token budget with raw provider payloads. Mirrors the
 * operator get_session_transcript compaction (same field shapes, same caps):
 * tool results truncated to 300 chars, user/assistant text to 1200.
 */
export function compactTranscriptToText(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as {
      role?: string;
      kind?: string;
      content?: string;
      commandName?: string;
      toolName?: string;
      toolResult?: string;
      isLocalCommand?: boolean;
    };
    const role = m.role ?? m.kind ?? 'message';
    if (m.isLocalCommand && m.commandName) {
      lines.push(`[${role}] /${m.commandName}`);
      continue;
    }
    if (role === 'tool' || m.kind === 'tool') {
      const res = typeof m.toolResult === 'string' ? m.toolResult : '';
      lines.push(`[tool ${m.toolName ?? ''}] ${res.slice(0, 300)}`);
      continue;
    }
    const text = (m.content ?? '').trim();
    if (text) {
      lines.push(`[${role}] ${text.slice(0, 1200)}`);
    }
  }
  return lines.join('\n\n') || '(empty transcript)';
}

const CONTEXT_SYSTEM_PROMPT =
  '你是 Lovdex 的会话上下文压缩助手。你只负责把给定的会话转录压缩为' +
  '固定模板的中文上下文摘要，供新任务开始执行前注入使用。' +
  '只输出摘要正文，不要任何解释、前后缀、代码块包裹标记。若某个板块无信息，写"（无）"。';

function buildPrompt(title: string, transcript: string): string {
  return [
    `任务：${title || ''}`,
    '',
    '以下是来源会话转录（已精简，可能截断）：',
    '',
    transcript,
    '',
    '请按以下固定模板输出任务的新开始上下文：',
    '## 项目背景 / 决策',
    '## 前序任务交接',
    '## 环境详情',
    '## 注意事项 / 约束',
  ].join('\n');
}

export async function runTaskContextCompression(args: TaskContextCompressionArgs): Promise<void> {
  const { sourceSessionId, taskId, title, deps, onError } = args;
  try {
    let transcript = '';
    try {
      const first = await deps.fetchHistory(sourceSessionId, { limit: MAX_MESSAGES, offset: 0 });
      const messages = Array.isArray(first?.messages) ? first.messages : [];
      transcript = compactTranscriptToText(messages);
    } catch (e) {
      onError?.(e);
      return; // 读不到 transcript => 不压缩，保持 NULL
    }
    const summary = await deps.runOneShot({
      prompt: buildPrompt(title, transcript),
      systemPrompt: CONTEXT_SYSTEM_PROMPT,
    });
    if (summary) {
      deps.writeBack(taskId, summary);
    }
  } catch (e) {
    onError?.(e);
  }
}

/** fire-and-forget + in-flight per-task dedupe。 */
export function scheduleTaskContextCompression(args: TaskContextCompressionArgs): void {
  const { taskId } = args;
  if (inFlight.has(taskId)) return;
  inFlight.add(taskId);
  void runTaskContextCompression(args)
    .catch((e) => args.onError?.(e))
    .finally(() => inFlight.delete(taskId));
}

const inFlight = new Set<string>();