/**
 * 任务取名的 LLM 调用。走调用方注入的 `runOneShot`（index.js 里接的是
 * `runOneShotClaudeText` —— headless claude-sdk，与任务上下文压缩同一条路径），
 * 模型固定 DeepSeek Flash（`TITLE_MODEL`）。
 *
 * 传输层依赖**注入**而不是 import：本模块因此不拉 SDK，单测可以直接塞替身
 * （与 task-context.service.ts 的 runOneShot 同一套做法）。
 *
 * 任何失败返回 null —— 调用方据此降级到本地 `deriveFallbackTitle`。
 * 「超时」在这里是**整个请求**的上限（`TITLE_TIMEOUT_MS`）：runOneShotClaudeText
 * 没有内建超时，不封顶的话后台回写那条路径可能永远挂着。
 */
import {
  TITLE_MODEL,
  TITLE_SYSTEM_PROMPT,
  TITLE_TIMEOUT_MS,
  buildTitleUserPrompt,
  sanitizeGeneratedTitle,
} from './task-title.js';

export type OneShotRunner = (args: {
  prompt: string;
  systemPrompt: string;
  model?: string;
}) => Promise<string | null>;

/**
 * 给不可中止的 await 套一个上限。超时后底层 query 仍在跑（SDK 没有暴露 abort 入口），
 * 但调用方不再等它 —— 与 sophclaw task-title 的取舍一致。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`task-title timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 返回清洗后的标题；请求失败、超时或清洗不出标题时返回 null。 */
export async function requestTaskTitle(input: {
  description?: string | null;
  runOneShot: OneShotRunner;
  /** 单测用的超时注入口；生产走 TITLE_TIMEOUT_MS。 */
  timeoutMs?: number;
}): Promise<string | null> {
  let content: string | null = null;
  try {
    content = await withTimeout(
      input.runOneShot({
        prompt: buildTitleUserPrompt({ prompt: input.description }),
        systemPrompt: TITLE_SYSTEM_PROMPT,
        model: TITLE_MODEL,
      }),
      input.timeoutMs ?? TITLE_TIMEOUT_MS,
    );
  } catch (error) {
    // 无 key / 401 / 超时 / SDK 抛错都在这里落地。取名失败绝不能冒泡成建任务失败。
    console.warn(
      '[task-title] 取名请求失败，降级到本地兜底',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  if (!content) return null;

  const title = sanitizeGeneratedTitle(content);
  // 「模型答了但答的东西不能用」必须留痕：这条路径静默降级成需求首行，
  // 用户只看到名字变短，而日志里若什么都没有，就无法区分「没 key」「relay 挂了」与「答非所问」。
  if (!title) {
    console.warn('[task-title] 响应清洗不出标题，降级到本地兜底', { raw: content.slice(0, 120) });
    return null;
  }
  // 成功路径也要留痕：用户报「名字不对」时，日志里得能看出模型到底答了什么。
  console.info('[task-title] 生成标题', { title, raw: content.slice(0, 120) });
  return title;
}
