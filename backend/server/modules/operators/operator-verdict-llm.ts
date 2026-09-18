/**
 * Lightweight LLM verdict channel.
 *
 * Replaces "spawn a full operator headless session (MCP tools + multi-turn
 * agent) just to judge a transcript" with ONE text completion. The judgement
 * inputs are the task title, the compacted session transcript and the decisive
 * final output; the output is a schema-validated `{ summary, verdict, reason }`.
 *
 * Contract with the trigger (`operator-verdict.service.ts`) — a tri-state, not a
 * boolean, because "the model said nothing usable" and "we deliberately refused
 * to judge" need opposite handling:
 *   'written' — a valid verdict was persisted; the trigger is done.
 *   'skipped' — no evidence to judge (unreadable transcript / no assistant
 *               output). The provider path would reach the same conclusion, so
 *               the trigger must NOT fall back — it would just burn a session.
 *   'failed'  — transport, timeout or schema failure. The trigger may fall back
 *               to the provider path.
 *
 * Failure isolation: `runLlmVerdict` never rejects. It runs inside the
 * session-status hook's call stack; a throw there would surface as an
 * unhandledRejection in the WS event loop.
 *
 * Deps are injected via `initVerdictLlm` (mirrors `initOperatorHeadless`) so
 * unit tests can drive the whole module with a fake LLM and no DB.
 */

import { compactTranscriptToText } from '@/shared/session-transcript.js';
import { lastAssistantText } from '@/modules/operators/operator.tools.js';
import { isAiVerdict, type AiVerdict } from '@/shared/task-status.js';

/**
 * One-shot model for every verdict judgement.
 *
 * A provider SLOT name (`default`), never a concrete model id — the slot is
 * resolved by config (`providers.claude.defaultModel`, DeepSeek Flash in the
 * reference deployment) so swapping the deployment's model needs no source
 * change. Same rule as `TITLE_MODEL` in the task-title channel.
 */
export const VERDICT_LLM_MODEL = 'default';

/** Per-attempt budget for one judgement. Mirrors sophclaw-client's verdict
 * timeout (compression gets 120s; a verdict reads far less). */
export const VERDICT_LLM_TIMEOUT_MS = 60_000;

/** Max messages pulled from the session transcript. */
const MAX_MESSAGES = 200;

/** Upper bound on the compacted transcript handed to the model. */
export const MAX_VERDICT_TRANSCRIPT_CHARS = 60_000;

/** Upper bound on the final output. It is the decisive evidence, so it is
 * surfaced first and capped separately from the transcript rather than being
 * the first thing truncated away. */
export const MAX_FINAL_OUTPUT_CHARS = 20_000;

export type VerdictLlmResult = { summary: string; verdict: AiVerdict; reason: string | null };

/** `written` | `skipped` | `failed` — see the module docblock. */
export type VerdictLlmOutcome = 'written' | 'skipped' | 'failed';

export type PriorVerdict = { summary: string | null; verdictAt: string | null };

export type VerdictLlmDeps = {
  fetchHistory: (
    sessionId: string,
    opts?: { limit?: number; offset?: number },
  ) => Promise<{ messages?: unknown[] }>;
  oneShot: (args: { prompt: string; systemPrompt: string; model?: string }) => Promise<string | null>;
  getTask: (taskId: string) => { ai_summary?: string | null; verdict_at?: string | null } | null;
  writeSummary: (
    taskId: string,
    input: { summary: string; verdict: AiVerdict; reason?: string | null },
  ) => unknown;
  /**
   * Operator settings → 自动判定 → 状态判断模型. Injected rather than read here so this
   * module keeps zero config coupling and unit tests need no config file.
   * Blank/unset falls back to VERDICT_LLM_MODEL.
   */
  getModel?: () => string | null | undefined;
};

export type RunLlmVerdictArgs = {
  sessionId: string;
  taskId: string;
  title: string;
  /** Test seam; defaults to the initVerdictLlm-wired deps. */
  deps?: VerdictLlmDeps | null;
  /** Test seam; defaults to VERDICT_LLM_MODEL. */
  model?: string;
  /** Test seam; defaults to VERDICT_LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Operator-supplied replacement for the built-in judgement criteria
   * (`operator_config.verdict_llm_prompt_override`). Replaces ONLY the
   * criteria — the evidence blocks and the JSON output contract are always
   * included, so an override can never break parsing.
   */
  promptOverride?: string | null;
};

let depsRef: VerdictLlmDeps | null = null;

/** Wire the production deps once at app startup (see index.js). */
export function initVerdictLlm(deps: VerdictLlmDeps): void {
  depsRef = deps;
}

/** Test-only: drop the wired deps so the un-wired path can be exercised. */
export function __resetVerdictLlm(): void {
  depsRef = null;
}

const VERDICT_LLM_SYSTEM_PROMPT =
  '你是 Lovdex 的任务完成度判定助手。你只做一件事：读一段会话转录，判断该任务的实际完成度，' +
  '并只输出一个 JSON 对象，不要任何解释、前后缀或代码块包裹标记。' +
  'JSON 形如 {"summary": "中文≤3句", "verdict": "done|only_plan|needs_review|blocked", "reason": "一句判定依据"}。';

/**
 * The judgement criteria. This is the ONLY part an operator-supplied
 * `verdict_llm_prompt_override` replaces — the task header, prior-verdict
 * block, evidence and JSON output contract are invariant (see
 * `buildVerdictLlmPrompt`).
 */
const DEFAULT_VERDICT_CRITERIA = [
  '判定要同时权衡三方面，不要只看结尾措辞：',
  '1. 实际产出质量：是否定位了根因、做了真实改动、交付物已落地（而非只给计划）。',
  '2. 验证结果：单测/E2E/构建等是否真正通过（看最终输出与转录里明确给出的验证结论）。',
  '3. 是否真正收尾：剩余事项的性质——是 Agent 按惯例应自行完成的例行收尾（提交、推送、合入 main、重启、部署），还是必须用户亲自决策的事项（选方案、确认业务方向、授权外部操作）。',
  '',
  '判定规则（按优先级）：',
  '- 实际改动已落地 + 验证已真实完成（有测试/构建/运行结论佐证）+ 仅差例行收尾（提交/推送/合入/部署）→ verdict = done。按 Lovdex 用户偏好，提交推送合入 main 是 Agent 的例行职责，不算用户决策门；仅当工作实质完成、验证已真实通过、只差提交推送时，最终输出礼貌性地问「要我提交并推送吗？」「还需要我做什么吗？」不否定完成度。',
  '- 实际改动已落地 + 验证通过 + 剩余事项确实需要用户决策（非例行收尾）→ verdict = needs_review。特别注意，以下都判 needs_review 而非 done：验证尚未真正完成（只过了类型检查、没跑运行时/单测/E2E 冒烟，或 Agent 停下来问「要不要我跑验证」）；代码改动尚未提交/推送（根本没提交，不是已提交仅差推送）；最终输出在等用户登录验收、人工冒烟、选方案、拍板分支/合并处理等。',
  '- 只给了计划/方案、没有实际改动 → verdict = only_plan。',
  '- 产出错误、验证失败、卡死或必须用户介入才能继续 → verdict = blocked。',
  '',
  '注意：仅凭最终输出以问句结尾不足以判 needs_review/blocked——若工作实质完成且验证已真实通过、仅差提交推送，礼貌性收尾提问应判 done；但「要不要我跑验证」「代码还没提交」是实际未完成，不是礼貌性收尾。',
].join('\n');

/**
 * The output contract. Never overridable: `parseVerdictLlmResponse` rejects a
 * response without this JSON shape, so dropping it would make every verdict
 * fail schema validation and silently fall back to the provider channel.
 */
const VERDICT_OUTPUT_CONTRACT =
  '只输出 JSON：{"summary": "中文≤3句", "verdict": "done|only_plan|needs_review|blocked", "reason": "一句，说明判定依据，含验证结论与剩余事项性质"}。';

/**
 * Build the judgement prompt. `finalOutput` (the session's newest assistant
 * text) is listed first and untruncated — it is the decisive evidence; the
 * transcript is supporting context.
 *
 * `promptOverride` replaces ONLY `DEFAULT_VERDICT_CRITERIA`. Everything the
 * channel structurally depends on is appended regardless: the task header, the
 * prior-verdict block, the evidence blocks (without which the model has nothing
 * to judge) and the JSON output contract (without which parsing fails). An
 * override that is null or blank falls back to the built-in criteria.
 */
export function buildVerdictLlmPrompt(args: {
  taskId: string;
  title: string;
  transcript: string;
  finalOutput: string;
  priorVerdict: PriorVerdict | null;
  promptOverride?: string | null;
}): { system: string; user: string } {
  const { taskId, title, transcript, finalOutput, priorVerdict } = args;

  const criteria =
    typeof args.promptOverride === 'string' && args.promptOverride.trim()
      ? args.promptOverride.trim()
      : DEFAULT_VERDICT_CRITERIA;

  const priorBlock = priorVerdict
    ? [
        '',
        `【任务此前的判定记录】该任务此前已被 AI 判定过：verdict_at=${priorVerdict.verdictAt ?? '未知'}，summary="${priorVerdict.summary ?? ''}"。`,
        '此前的判定只是弱参考，不得绑架本次判定——每次都应基于本会话的实际产出、验证结果与是否真正收尾独立评审。',
        '若本次追加工作与主任务无关，且追加工作本身也已完整收尾（改动落地、验证通过、无待决事项），可维持 done，不因追加工作的存在而降级；',
        '但若追加工作仍停留在计划/方案阶段、代码未实现（例如只有 spec 没有落地），或会话停在等 review/等用户决策，则按本次实际产出独立判定为 only_plan / needs_review / blocked，不得因历史判定是 done 而强行维持 done。',
        '',
      ].join('\n')
    : '';

  const user = [
    `判断任务 ${taskId}（${title}）在 session 里的实际完成度。`,
    priorBlock,
    '【最终输出】最终输出（最后一条 assistant 消息）是第一依据：',
    '<<<FINAL_OUTPUT',
    finalOutput.slice(0, MAX_FINAL_OUTPUT_CHARS),
    'FINAL_OUTPUT',
    '',
    '【会话转录】（已精简，可能截断，仅作佐证）：',
    '<<<TRANSCRIPT',
    transcript.slice(0, MAX_VERDICT_TRANSCRIPT_CHARS),
    'TRANSCRIPT',
    '',
    criteria,
    '',
    VERDICT_OUTPUT_CONTRACT,
  ].join('\n');

  return { system: VERDICT_LLM_SYSTEM_PROMPT, user };
}

/**
 * Pull the first JSON object out of a model response and validate it.
 *
 * Models wrap JSON in prose or a ```json fence often enough that a bare
 * `JSON.parse` is not viable. Returns null — never a coerced/default verdict —
 * when anything is off: an unrecognised verdict must not reach the DB, where it
 * would be persisted into the `sub_status` column.
 */
export function parseVerdictLlmResponse(raw: string | null | undefined): VerdictLlmResult | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as { summary?: unknown; verdict?: unknown; reason?: unknown };
  if (!isAiVerdict(obj.verdict)) return null;

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) return null;

  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : null;

  return { summary, verdict: obj.verdict, reason };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`verdict LLM call timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Resolve which model judges this run. Precedence: explicit argument (the test
 * seam / caller override) → configured value → built-in constant. A config read
 * that throws must not sink the verdict — the channel's whole job is to be the
 * cheap path, so it degrades to the built-in model instead.
 */
function resolveModel(args: RunLlmVerdictArgs, deps: VerdictLlmDeps): string {
  if (args.model?.trim()) return args.model.trim();
  try {
    const configured = deps.getModel?.();
    if (configured?.trim()) return configured.trim();
  } catch (e) {
    console.error('[operator-verdict-llm] read configured model failed', e);
  }
  return VERDICT_LLM_MODEL;
}

/**
 * Judge one completed session with a single LLM call and persist the verdict.
 * Resolves with the outcome; never rejects. See the module docblock for the
 * tri-state contract.
 */
export async function runLlmVerdict(args: RunLlmVerdictArgs): Promise<VerdictLlmOutcome> {
  const { sessionId, taskId, title } = args;
  const deps = args.deps ?? depsRef;
  if (!deps) {
    console.error('[operator-verdict-llm] no deps wired — call initVerdictLlm at startup');
    return 'failed';
  }

  // Read the transcript. The verdict hinges on the final output: with no
  // assistant text there is no evidence, and a model asked to judge nothing
  // historically hard-codes `done`. Skip rather than guess.
  let messages: unknown[] = [];
  let finalOutput: string | null = null;
  try {
    const history = await deps.fetchHistory(sessionId, { limit: MAX_MESSAGES, offset: 0 });
    messages = Array.isArray(history?.messages) ? history.messages : [];
    finalOutput = lastAssistantText(messages);
  } catch (e) {
    console.error('[operator-verdict-llm] transcript read failed', e);
    return 'failed';
  }
  if (finalOutput == null) {
    console.error('[operator-verdict-llm] no readable final output — skipping verdict', {
      sessionId,
      taskId,
    });
    return 'skipped';
  }

  // The prior verdict is a weak reference only; each run judges this session's
  // actual output independently. Best-effort: a missing task record must not
  // block the judgement.
  let priorVerdict: PriorVerdict | null = null;
  try {
    const row = deps.getTask(taskId);
    if (row?.ai_summary || row?.verdict_at) {
      priorVerdict = { summary: row.ai_summary ?? null, verdictAt: row.verdict_at ?? null };
    }
  } catch (e) {
    console.error('[operator-verdict-llm] read prior verdict failed', e);
  }

  const { system, user } = buildVerdictLlmPrompt({
    taskId,
    title,
    transcript: compactTranscriptToText(messages),
    finalOutput,
    priorVerdict,
    promptOverride: args.promptOverride,
  });

  let raw: string | null = null;
  try {
    raw = await withTimeout(
      deps.oneShot({
        prompt: user,
        systemPrompt: system,
        model: resolveModel(args, deps),
      }),
      args.timeoutMs ?? VERDICT_LLM_TIMEOUT_MS,
    );
  } catch (e) {
    console.error('[operator-verdict-llm] LLM call failed', e);
    return 'failed';
  }

  const verdict = parseVerdictLlmResponse(raw);
  if (!verdict) {
    console.error('[operator-verdict-llm] unusable LLM response — refusing to label', {
      taskId,
      raw: typeof raw === 'string' ? raw.slice(0, 200) : raw,
    });
    return 'failed';
  }

  try {
    deps.writeSummary(taskId, verdict);
  } catch (e) {
    console.error('[operator-verdict-llm] write verdict failed', e);
    return 'failed';
  }
  return 'written';
}
