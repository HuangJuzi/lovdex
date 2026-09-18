/**
 * 任务取名：提示词构造、响应清洗、兜底提炼、竞速与回写判定。
 *
 * 纯逻辑，**不触网、不 import SDK** —— 真正的 LLM 调用在 `task-title-llm.ts`。
 * 这样「生成失败该不该降级」「迟到回来该不该覆盖」这些判断都能被 `node --test` 直测，
 * 而接线层（index.js 的注入）没有可测面。
 *
 * 移植自 sophclaw-client desktop/src/main/task-title.mjs（MR #243 / 任务 e6ca0090），
 * 差异只有两处：
 * - 兜底名 `deriveFallbackTitle` 在后端也要有一份（前端那份在
 *   web/src/components/tasks/taskName.ts，是 50 字素 + 省略号，这里保持同一语义）；
 * - `raceTaskTitle` 的 background 契约改成「reject 也解析成 null」，见该函数注释。
 */

/** 模型生成标题的上限（字素）。与本地提炼的 50 不同 —— 生成名要短到能在表格里一眼扫完。 */
export const TITLE_MAX_GRAPHEMES = 10;

/** 送进模型的需求原文上限（字符）。提示词可以粘贴几千字，取名只需要开头。 */
export const TITLE_PROMPT_MAX_CHARS = 2000;

/** 本地兜底名的上限（字素）。与前端 deriveTaskName 的 MAX_NAME_LENGTH 一致。 */
export const FALLBACK_TITLE_MAX_GRAPHEMES = 50;

/**
 * 阻塞窗口：等模型超过这个时长就先用本地名建任务，模型回来后走后台回写。
 * createTask 是调用方 await 的，这个值直接等于「空标题建任务」的额外延迟上限。
 */
export const TITLE_BLOCKING_TIMEOUT_MS = 3000;

/**
 * 单次取名请求的超时上限。后端走的是 `runOneShotClaudeText`（headless Claude CLI，
 * 没有内建超时），所以由 task-title-llm 用它把整个请求封顶。
 *
 * 与阻塞窗口是两个量级不是巧合：调用方只等 3 秒，剩下的约 12 秒留给后台回写。
 */
export const TITLE_TIMEOUT_MS = 15000;

/**
 * 取名固定走 DeepSeek Flash。传 claude provider 的 `default` 槽位而不是写死
 * `DeepSeek-V4-Flash-0731`：槽位由 config 解析
 * （DEFAULT_APP_CONFIG.providers.claude.defaultModel 就是 DeepSeek-V4-Flash-0731），
 * 换部署不用改源码。与 sophclaw task-title 的固定 relay 模型同义。
 */
export const TITLE_MODEL = 'default';

/**
 * 模型与本地提炼都拿不到名字时的兜底。理论上不可达（description 为空时本地兜底也会
 * 返回它），但建任务这条路径不能依赖调用方的保证。
 *
 * 注意与前端读时兜底是**同字面量、非同一真相源** —— 那边是「读到空标题时展示什么」，
 * 这边是「写不出去时先写什么」。回写 CAS 等的是**我们实际写进任务的那个占位名**，
 * 所以不要为了「统一」去 import 前端那份。
 */
export const FALLBACK_TITLE = '未命名任务';

export const TITLE_SYSTEM_PROMPT =
  '你是 Lovdex 的任务标题生成助手。你只输出任务标题本身，不要任何解释、引号、前后缀、标点结尾或代码块包裹标记。';

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * 按**字素**截断，不是 `String.slice` —— slice 按 UTF-16 码元切，会把一个 emoji
 * 劈成孤立代理项，也会把组合序列（e + U+0301）拆开。
 */
export function truncateGraphemes(text: string, max: number): string {
  const value = String(text ?? '');
  if (max <= 0) return '';
  if (!segmenter) return [...value].slice(0, max).join('');
  let out = '';
  let count = 0;
  for (const { segment } of segmenter.segment(value)) {
    if (count >= max) break;
    out += segment;
    count += 1;
  }
  return out;
}

function countGraphemes(text: string): number {
  if (!segmenter) return [...text].length;
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

export function buildTitleUserPrompt({ prompt }: { prompt?: string | null } = {}): string {
  // 按**码点**截断，不是 `String.slice` —— slice 按 UTF-16 码元切，会把一个 emoji
  // 劈成孤立代理项再送进提示词。
  const need = [...String(prompt ?? '')].slice(0, TITLE_PROMPT_MAX_CHARS).join('');
  return `为下面的任务需求起一个标题。

要求：
- 不超过 ${TITLE_MAX_GRAPHEMES} 个字，越精炼越好；中文按字计
- 动宾结构，直指要做什么（例：修复登录超时、重构任务面板筛选）
- 只输出标题本身：不要引号、不要结尾标点、不要解释、不要换行

任务需求：
\`${need}\``;
}

/**
 * 本地兜底提炼：取首个非空行、折叠空白、按字素截到 50 并补省略号；全空则给默认名。
 *
 * 与前端 `deriveTaskName` 同语义，但**不是同一份实现**：后端不能依赖渲染层一定送来了
 * 非空标题（API 直调、operator create_task、定时任务模板都可能有空标题）。
 */
export function deriveFallbackTitle(description?: string | null): string {
  const firstLine =
    String(description ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (!collapsed) return FALLBACK_TITLE;
  if (countGraphemes(collapsed) <= FALLBACK_TITLE_MAX_GRAPHEMES) return collapsed;
  return `${truncateGraphemes(collapsed, FALLBACK_TITLE_MAX_GRAPHEMES).trimEnd()}…`;
}

// 围栏后的 `\n?` 让单行围栏（`` ```修复登录超时``` ``）也落到捕获组里 ——
// 只认三行式的话，那个反引号会被原样当成标题首字素带出去，而剥围栏正是本函数存在的理由。
const FENCE_RE = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/;
const TRAILING_PUNCT_RE = /[。．.！!？?；;，,、]+$/;
const WRAPPING_QUOTES: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
];

/**
 * 宽容清洗模型输出。任一环出空返回 null（调用方据此降级到本地提炼）。
 *
 * 截断**不加省略号**：10 字已是硬上限，补个 `…` 等于把标题挤成 9 个字。
 */
export function sanitizeGeneratedTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let text = raw.trim();
  const fence = FENCE_RE.exec(text);
  if (fence) text = fence[1].trim();

  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  let title = firstLine.replace(/\s+/g, ' ');
  // 成对引号**不加长度守卫**：守卫（`length > 2`）与真实条件（剥完是否为空）在退化输入上
  // 背离 —— 模型回一个 `""` / `「」` 是经典的「我没什么可说」，剥完为空自然落到 `|| null`
  // 走降级，加守卫反而会放行一个名为 `""` 的任务。
  for (const [open, close] of WRAPPING_QUOTES) {
    if (title.startsWith(open) && title.endsWith(close)) {
      title = title.slice(open.length, title.length - close.length).trim();
      break;
    }
  }

  // 先截断再剥标点。反过来会把截断**新暴露**出来的标点留在末尾
  // （「重构任务面板，筛选，排序」截到 10 字素正好停在逗号上 → 「重构任务面板，筛选，」）。
  const truncated = truncateGraphemes(title, TITLE_MAX_GRAPHEMES).replace(TRAILING_PUNCT_RE, '').trim();
  return truncated || null;
}

/**
 * 阻塞窗口内等模型；超时则把**同一个 in-flight promise**（不是重发一次请求）留给后台。
 *
 * 返回 `{ title, background }`：`background` 非空表示「模型还没回来，回来后可以尝试回写」。
 * 模型回来但结果为 null（请求失败）时 `background` 为 null —— 没有可回写的东西。
 *
 * `background` 在超时后仍可能 reject（迟到的模型请求失败）。与 sophclaw 的版本不同，
 * 这里**自己把 reject 吞成 null** 再交给消费方：调用方（createTask）是 fire-and-forget
 * 的，漏挂 catch 就是一次静默的 unhandledRejection，而那个异常没有任何诊断价值 ——
 * 失败语义与「模型没答出可用的名字」完全一致，都是不回写。
 */
export async function raceTaskTitle(
  pending: Promise<string | null>,
  fallbackTitle: string,
  blockingMs: number = TITLE_BLOCKING_TIMEOUT_MS,
): Promise<{ title: string; background: Promise<string | null> | null }> {
  const TIMED_OUT = Symbol('task-title-timeout');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), blockingMs);
  });

  // 先挂上 handler：迟到的 reject 在这里被吞掉，绝不外泄成 unhandledRejection。
  const settled = pending.catch(() => null);

  try {
    const first = await Promise.race([settled, timeout]);
    if (first !== TIMED_OUT) return { title: first || fallbackTitle, background: null };
    return { title: fallbackTitle, background: settled };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 回写 CAS：只在标题**仍是我们写入的占位名**时覆盖。
 *
 * 判定在途期间用户可能已经改过名字、删除或归档了任务 —— 这三种情况一律让位。
 */
export function shouldApplyGeneratedTitle(
  task: { status?: string; title?: string } | null | undefined,
  placeholderTitle: string,
): boolean {
  if (!task) return false;
  if (task.status === 'archived') return false;
  return task.title === placeholderTitle;
}
