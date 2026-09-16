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
 * `runOneShot`, `writeBack` and `fetchHistory` are injected deps provided by the
 * caller (index.js wiring, Task 6): runOneShot = the headless claude-sdk helper,
 * writeBack = a tasks-service hook. Keeping them injected keeps this module
 * import-free so unit tests never pull the SDK.
 */

export type TaskContextResult = { status: 'ready' | 'failed'; summary?: string; raw?: string };

export type TaskContextCompressionDeps = {
  fetchHistory: (sessionId: string, opts?: { limit?: number; offset?: number }) => Promise<{ messages?: unknown[] }>;
  runOneShot: (args: { prompt: string; systemPrompt: string; model?: string }) => Promise<string | null>;
  writeResult: (taskId: string, result: TaskContextResult) => void;
};

export type TaskContextCompressionArgs = {
  sourceSessionId: string;
  taskId: string;
  title: string;
  mode: 'summary' | 'raw';
  deps: TaskContextCompressionDeps;
  onError?: (error: unknown) => void;
};

/** Max messages pulled from the source transcript. */
const MAX_MESSAGES = 200;

/** Upper bound on the transcript text handed to the compression model. */
const MAX_TRANSCRIPT_CHARS = 60_000;

/** Upper bound on the raw transcript stored verbatim for raw mode (~200k chars). */
const MAX_RAW_CHARS = 200_000;

/** Upper bound on one background compression run (headless CLI may stall). */
const RUN_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`task-context compression timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // onError 回调自身抛错时吞掉，避免级联
  }
}

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
  const { sourceSessionId, taskId, title, mode, deps, onError } = args;
  const fail = (e?: unknown) => {
    if (e !== undefined) reportError(onError, e);
    try {
      deps.writeResult(taskId, { status: 'failed' });
    } catch {
      // writeResult 自身抛错时吞掉，避免级联
    }
  };
  let transcript = '';
  try {
    const first = await deps.fetchHistory(sourceSessionId, { limit: MAX_MESSAGES, offset: 0 });
    const messages = Array.isArray(first?.messages) ? first.messages : [];
    transcript = compactTranscriptToText(messages);
  } catch (e) {
    fail(e); // 读不到 transcript => 置 failed，不写产物
    return;
  }

  // raw：不调 LLM，直接把精简转录截断后存 context_raw。
  if (mode === 'raw') {
    deps.writeResult(taskId, { status: 'ready', raw: transcript.slice(0, MAX_RAW_CHARS) });
    return;
  }

  // summary：截断到 token 预算内，走 LLM 压缩。
  transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  let summary: string | null = null;
  try {
    summary = await withTimeout(
      deps.runOneShot({
        prompt: buildPrompt(title, transcript),
        systemPrompt: CONTEXT_SYSTEM_PROMPT,
      }),
      RUN_TIMEOUT_MS,
    );
  } catch (e) {
    reportError(onError, e);
  }
  if (summary) {
    deps.writeResult(taskId, { status: 'ready', summary });
  } else {
    fail(); // 超时/空结果 => failed
  }
}

/** fire-and-forget + in-flight per-task dedupe. */
export function scheduleTaskContextCompression(args: TaskContextCompressionArgs): void {
  const { taskId } = args;
  if (inFlight.has(taskId)) return;
  inFlight.add(taskId);
  void runTaskContextCompression(args)
    .catch((e) => reportError(args.onError, e))
    .finally(() => inFlight.delete(taskId));
}

const inFlight = new Set<string>();