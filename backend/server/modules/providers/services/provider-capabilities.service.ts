import type { LLMProvider } from '@/shared/types.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
};

/**
 * The capability matrix mirrors what each runtime actually implements today:
 * - permission modes match the option sets accepted by each CLI/SDK.
 * - interactive permission requests reach the UI only where the runtime has a
 *   real request/response channel: the Claude SDK and the dsh ACP client.
 * - Cursor has no token usage endpoint support (its store.db has no usage rows).
 */
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    permissionModes: ['default', 'auto', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  codex: {
    provider: 'codex',
    permissionModes: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  opencode: {
    provider: 'opencode',
    permissionModes: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  qoder: {
    provider: 'qoder',
    permissionModes: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  // dsh is driven over ACP (runner lands in Task 9 of the dsh provider plan).
  // Permission requests and mid-turn cancel are native ACP methods, so both are
  // declared supported. The mode set is deliberately narrow: ACP has no
  // Claude-specific mode concepts, and the runner maps the Lovdex gateway's
  // normalized modes onto ACP itself, so only the gateway-normalized
  // 'autoApprove' is offered alongside the default. Images are NOT wired yet
  // (ACP image prompts need a durable attachment store). Token usage IS wired:
  // the endpoint (and the runner's per-step `token_budget` frames) read dsh's
  // `session_projcache` snapshot / session log. `supportsEffort` is honest
  // ahead of the runner: ACP exposes `reasoning_effort` through
  // `session/set_config_option`, which needs no new infrastructure.
  dsh: {
    provider: 'dsh',
    permissionModes: ['default', 'autoApprove'],
    defaultPermissionMode: 'default',
    supportsImages: false,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
};

/**
 * Application service exposing the provider capability matrix.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    return PROVIDER_CAPABILITIES[provider];
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return Object.values(PROVIDER_CAPABILITIES);
  },
};
