/**
 * Central app configuration.
 *
 * Single source of truth for all backend runtime settings and provider
 * credentials. Lives at <DATA_DIR>/app.config.json (default ~/.lovdex/data),
 * auto-generated on first load with deep-merged defaults. Writes are atomic
 * (tmp + rename) so a crash can never corrupt the file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_APP_CONFIG = {
  server: {
    host: '0.0.0.0',
    port: 3188,
    corsOrigin: '*',
    contextWindow: null as number | null,
    isPlatform: false,
    workflowsEnabled: true,
    ultracodeKeywordTrigger: '',
  },
  database: { path: path.join(os.homedir(), '.sophcode', 'auth.db') },
  workspaces: { root: '~', mainWorkspace: '' },
  auth: { enabled: true, email: null as string | null, code: null as string | null, jwtSecret: '' },
  providers: {
    claude: {
      cliPath: 'claude',
      apiKey: '',
      authToken: '',
      baseUrl: 'https://www.sophnet.com/api/open-apis/anthropic',
      defaultModel: 'DeepSeek-V4-Flash-0731',
      haikuModel: 'DeepSeek-V4-Flash-0731',
      opusModel: 'DeepSeek-V4-Pro-0813',
      sonnetModel: 'claude-opus-4-8',
      oneMillionModels: '',
      // Third-party reasoning models (DeepSeek/Kimi/GLM via the proxy) must run
      // without extended thinking: their reasoning phase lands as standalone
      // thinking-only assistant turns that trip Claude Code CLI's "no visible
      // output" nudge loop. Comma-separated model ids (exact match, both slot
      // names like 'default' and concrete ids resolve). Anthropic models never
      // listed here.
      disableThinkingModels: 'DeepSeek-V4-Flash-0731,DeepSeek-V4-Pro-0813,Kimi-K3,GLM-5.2',
      streamCloseTimeoutMs: 10000,
      toolApprovalTimeoutMs: 60000,
      // Session-level run guardrails (run-guard.ts). A single unattended
      // `default`-permission run once burned ~2500 turns / ~4 MB of transcript
      // before dying on a 402 (balance exhausted); these fuses cap that. 0
      // disables a fuse. Deep-merge means a deployment can override any one key
      // without re-specifying the rest. See docs for the rationale on each default.
      runGuard: {
        maxTurns: 300,
        maxDurationMs: 60 * 60 * 1000,
        maxTotalTokens: 0,
        maxBudgetUsd: 0,
        maxRepeatedErrors: 5,
        // Consecutive unanswered permission approvals before the run is
        // killed (the original runaway: an unattended default-permission run
        // kept re-requesting the same tool until 402). 0 = disabled.
        maxApprovalTimeouts: 5,
        // Cheap slot for auto-dispatched sub-tasks with no explicit model.
        defaultTaskModel: 'haiku',
      },
    },
    codex: { binPath: 'codex' },
    opencode: { binPath: 'opencode', apiKeys: {} as Record<string, string> },
    qoder: { personalAccessToken: '', toolApprovalTimeoutMs: 60000 },
    dsh: {
      // `dsh` executable name or absolute path. The CLI is the sole launcher:
      // Lovdex always spawns it as `dsh --profile acp` (see server/dsh-acp-runner.js).
      binPath: 'dsh',
      // Isolated DSH_HOME passed to the child so a Lovdex-spawned runtime never
      // discovers the user's own profiles/credentials. Empty = use dsh default
      // ($DSH_HOME, else ~/.dsh).
      dshHome: '',
      // Explicit Messages endpoint override, handed to the child as
      // DEEPSEEK_BASE_URL. Leave EMPTY to follow the claude provider's rule: an
      // enabled llm-proxy is the model front door, so dsh targets
      // http://127.0.0.1:<llmProxy.port> and the proxy supplies the upstream
      // credential (see resolveDshProviderEnv in modules/config/env-sync.ts).
      //
      // Set this only to point dsh somewhere the proxy does NOT front. dsh
      // resolves the endpoint as explicit profile `baseURL` → $DEEPSEEK_BASE_URL
      // → the official root, so a profile that pins its own `baseURL` (e.g. a
      // hand-edited $DSH_HOME/profiles/acp/cordis.patch.yml) shadows this value;
      // set `dshHome` to a Lovdex-owned home when this field must win.
      baseUrl: '',
      // Credential handed to the child as DEEPSEEK_API_KEY (dsh's api-key
      // adapter reads that exact env name and never inlines a secret in its
      // config). Leave EMPTY to inherit the resolved llm-proxy credential, the
      // same `providers.claude.apiKey` the proxy itself authenticates with. The
      // adapter requires a non-empty key even when the proxy ignores the inbound
      // value, so the inherited default matters.
      apiKey: '',
      // Optional `--patch <path>` overlay layered onto the acp profile. Needed
      // only for endpoints the `deepseek-official` route cannot serve — e.g. an
      // OpenAI-compatible gateway, which requires a dsh-llm-pi-ai route.
      // Lovdex always layers its bundled retry overlay FIRST (see
      // server/dsh-retry.patch.yml); later overlays replace earlier ones per
      // config key, so a patch set here still overrides the bundled values.
      patchPath: '',
      // Bound for a pending tool-approval popup before the runner auto-denies.
      toolApprovalTimeoutMs: 60000,
      // The model picker catalog: one model id per line/entry, exactly what the
      // dropdown shows (plus the always-present `default` slot). There is no
      // built-in list — model ids belong to whatever endpoint the active
      // provider profile points at, so each profile carries its own list and
      // switching profiles switches the picker. Entries are bare model ids
      // (wrapped in the deepseek-official route pair by DshProviderModels) or a
      // legacy `route|model[|label]`.
      customModels: [] as string[],
    },
  },
  operator: {
    enabled: true,
    autoVerdictEnabled: true,
    model: '',
    workspace: '',
    maxConcurrent: 2,
  },
  /**
   * Model slots for the single-shot LLM jobs (Operator settings → 自动判定 / 标题生成模型). Both default to
   * the provider's `default` slot — a slot name, not a concrete id, so the
   * deployment's own model (providers.claude.defaultModel) is used without a
   * source change. These jobs are pure text-in/text-out (no tools, no file
   * reads), so the cheap default model is the right choice.
   *
   * Clearing a slot is also legal and means the same thing as leaving it at
   * `default`: follow that job's built-in default.
   */
  oneshot: {
    titleModel: 'default',
    verdictModel: 'default',
  },
  llmProxy: {
    enabled: false,
    port: 8088,
    anthropicUrl: '',
    openaiUrl: 'https://www.sophnet.com/api/open-apis/openai',
    routing: {} as Record<string, string | { model: string; upstream?: string }>,
  },
  /**
   * 多套凭据「配置档」：某个 provider 的一组凭据字段的命名快照（字段范围见
   * provider-profiles.ts 的 PROFILE_FIELDS）。**纯存储** —— `providers.*` 才
   * 是"实际跑什么"的唯一真源；配置档只有被应用时才改变行为（PUT 带
   * activeProviderProfiles 选择，服务端把该档真值拷进 `providers.*`，所以
   * 密钥从不经过浏览器）。
   *
   * values 里存的是**真密钥**：GET 会打码（maskConfig 按 key 名递归），PUT 会在
   * 合并前丢掉打码占位串，所以客户端把整份 draft 打回来也绝不会覆盖已存的 key。
   */
  providerProfiles: {} as Record<
    string,
    Record<string, { name: string; values: Record<string, unknown> }>
  >,
  /**
   * 每个 provider 的生效字段当前来自哪个档。**仅 UI 标注用**，env-sync / 各
   * runner 从不读它。空串（**不是 null** —— deepMerge 的 `override ?? base` 会把
   * null 当成"未提供"而保留旧值）表示"自定义，不归属任何档"。
   */
  activeProviderProfiles: {} as Record<string, string>,
  runtime: { fsConcurrency: 64 },
};

export type AppConfig = typeof DEFAULT_APP_CONFIG;

/** Keys whose values are secrets; masked when serialized for the API. */
const SENSITIVE_KEYS = new Set([
  'apiKey', 'authToken', 'personalAccessToken', 'jwtSecret', 'code',
]);
/**
 * Keys masked with a zero-hint marker (no tail) because they're user-guessable
 * (login code / JWT secret) and the config is served anonymously — revealing
 * the last 4 chars of a 6-digit code leaves only ~100 brute-force combos.
 */
const ZERO_HINT_KEYS = new Set(['code', 'jwtSecret']);

/**
 * Keys whose object VALUES are all secrets (e.g. `providers.opencode.apiKeys`,
 * a `Record<envVarName, key>`). Containers are masked wholesale so inner keys
 * like `ANTHROPIC_API_KEY` don't need to match SENSITIVE_KEYS.
 */
const SENSITIVE_CONTAINER_KEYS = new Set(['apiKeys']);

export function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(base) || Array.isArray(override)) {
    return (override ?? base) as T;
  }
  if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      const b = (base as Record<string, unknown>)[k];
      out[k] = deepMerge(b, v);
    }
    return out as T;
  }
  return (override ?? base) as T;
}

export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/**
 * Masks an API key as `first6****last6`. Short values degrade: length <= 6 →
 * `****`, length <= 12 → `first4****last4` (so the middle is never fully
 * revealed). The `****` marker is what PUT's stripMaskedPlaceholders uses to
 * treat the field as "unchanged" (see config.routes.ts).
 */
export function maskApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 6) return '****';
  if (value.length <= 12) return `${value.slice(0, 4)}****${value.slice(-4)}`;
  return `${value.slice(0, 6)}****${value.slice(-6)}`;
}

/** Recursively replaces sensitive leaf values with a masked marker. */
export function maskConfig(value: unknown, key?: string): unknown {
  // Container keys (e.g. `apiKeys`) hold secrets under arbitrary inner key
  // names, so mask every value immediately instead of recursing into them.
  if (key && SENSITIVE_CONTAINER_KEYS.has(key) && typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecret(v);
    return out;
  }
  // Zero-hint keys never reveal a tail: the login code / JWT secret is
  // user-guessable and this config is served to anonymous clients. Empty
  // values still serialize as '' rather than the mask.
  if (key && ZERO_HINT_KEYS.has(key)) {
    return typeof value === 'string' && value.length > 0 ? '••••' : '';
  }
  if (Array.isArray(value)) return value.map((v) => maskConfig(v));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskConfig(v, k);
    }
    return out;
  }
  if (key === 'apiKey') return maskApiKey(value);
  if (key && SENSITIVE_KEYS.has(key)) return maskSecret(value);
  return value;
}

export type AppConfigApi = {
  /** Returns the full merged config (runtime use). */
  get(): AppConfig;
  /** Returns a masked copy for the HTTP API. */
  getMasked(): AppConfig;
  /** Deep-merges a partial update and atomically persists. */
  update(partial: unknown): AppConfig;
  /**
   * 删除一个配置档。`update()` 走的 deepMerge 只能加键/覆盖键、删不掉键，
   * 所以删除必须走自己的路径。若该档正是当前档则顺手清空标记（`''`）；
   * **生效字段刻意不动** —— 删档不该改变正在跑的东西。
   */
  removeProviderProfile(provider: string, id: string): AppConfig;
  /** The config file path. */
  filePath: string;
};

export function createAppConfig(options?: {
  dataDir?: string;
  filePath?: string;
}): AppConfigApi {
  // Overridable data dir enables isolated E2E/data-dir tests while defaulting
  // to the stable user-level location (~/.lovdex/data).
  const dir = options?.dataDir ?? process.env.LOVDEX_DATA_DIR ?? path.join(os.homedir(), '.lovdex', 'data');
  const filePath = options?.filePath ?? path.join(dir, 'app.config.json');
  const jwtSecret = crypto.randomBytes(48).toString('hex');

  function load(): AppConfig {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const cfg = deepMerge(structuredClone(DEFAULT_APP_CONFIG), parsed) as AppConfig;
      if (!cfg.auth.jwtSecret) {
        // Persisted file has no JWT secret — inject a stable random one and
        // write it back now, so restarts don't rotate the key and invalidate
        // existing logins.
        cfg.auth.jwtSecret = jwtSecret;
        persist(cfg); // hoisted function declaration — safe to call from here
      }
      return cfg;
    } catch (err) {
      // ENOENT → first boot: generate defaults and persist (idempotent).
      // Anything else (corrupt JSON, EACCES, ...) → rotate the damaged file to
      // `<filePath>.corrupt` so stored credentials stay recoverable, then
      // regenerate defaults.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        if (fs.existsSync(filePath)) {
          try {
            fs.renameSync(filePath, `${filePath}.corrupt`);
          } catch {
            // Best-effort rotation; never mask the original error.
          }
        }
        console.error(
          `app.config: failed to load ${filePath} (${code ?? 'unknown'}); rotated to .corrupt`, err);
      }
      const cfg = structuredClone(DEFAULT_APP_CONFIG) as AppConfig;
      cfg.auth.jwtSecret = jwtSecret;
      persist(cfg);
      return cfg;
    }
  }

  function persist(cfg: AppConfig): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  let current = load();

  return {
    get: () => structuredClone(current),
    getMasked: () => maskConfig(current) as AppConfig,
    update(partial: unknown): AppConfig {
      const next = deepMerge(structuredClone(current), partial) as AppConfig;
      if (!next.auth.jwtSecret) next.auth.jwtSecret = current.auth.jwtSecret;
      persist(next);
      current = next;
      return current;
    },
    removeProviderProfile(provider: string, id: string): AppConfig {
      const next = structuredClone(current);
      const bucket = next.providerProfiles[provider];
      if (bucket) delete bucket[id];
      if (next.activeProviderProfiles[provider] === id) next.activeProviderProfiles[provider] = '';
      persist(next);
      current = next;
      return current;
    },
    filePath,
  };
}

export type LlmProxyResolved = {
  enabled: boolean;
  port: number;
  anthropicUrl: string;
  openaiUrl: string;
  routing: Record<string, string | { model: string; upstream?: string }>;
  apiKey: string;
};

/** Resolve the effective llm-proxy settings, deriving upstream URLs and the key
 * from providers.claude when the dedicated fields are empty. */
export function resolveLlmProxy(cfg: AppConfig): LlmProxyResolved {
  const p = cfg.llmProxy;
  return {
    enabled: p.enabled,
    port: p.port || 8088,
    anthropicUrl: p.anthropicUrl || cfg.providers.claude.baseUrl,
    openaiUrl: p.openaiUrl || 'https://www.sophnet.com/api/open-apis/openai',
    routing: p.routing ?? {},
    apiKey: cfg.providers.claude.apiKey,
  };
}

/** Process-wide singleton (call once at server boot). */
let singleton: AppConfigApi | null = null;
export function appConfig(): AppConfigApi {
  if (!singleton) singleton = createAppConfig();
  return singleton;
}
