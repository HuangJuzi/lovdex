import type { RemoteProvider } from '../../../server/shared/agent-runtime/protocol.js';
import type { QuerySdkLike, RunManager } from '../agent-run.js';
import { createClaudeRunManager } from '../agent-run.js';
import { createCodexRunManager } from './codex-runner.js';
import { createOpenCodeRunManager } from './opencode-runner.js';
import { createQoderRunManager } from './qoder-runner.js';

/**
 * The dependency bag every provider runner receives from rpc-dispatch:
 * the live push bus (re-pointed at the current ws on each reconnect) and the
 * allowlisted host roots (mirror of `cfg.roots`).
 */
export type RunManagerDeps = {
  push: (topic: string, payload: unknown) => void;
  roots?: string[];
  /** Test seam only — injected SDK; absent => the real claude query bridge. */
  querySdk?: QuerySdkLike;
};

/**
 * Dispatch a `RemoteProvider` to the run manager that executes its CLI.
 *
 * Task 12 adds the codex / opencode / qoder cases to the switch — each runner
 * ports its local `backend/server/` counterpart (openai-codex.js, opencode-runner.js,
 * qoder-runner.js) and speaks the same `RunManager` contract as the claude
 * manager (per-run AbortController, approval `respond`, early `providerSessionId`
 * resolution, terminal `{ type: 'complete' }` push). `env`-only construction
 * deps are deliberately absent: per-session provider config arrives as
 * `params.configEnv` on each `start()` call.
 */
export function createRunManagerFor(provider: RemoteProvider, deps: RunManagerDeps): RunManager {
  switch (provider) {
    case 'claude':
      return createClaudeRunManager(deps);
    case 'codex':
      return createCodexRunManager(deps);
    case 'opencode':
      return createOpenCodeRunManager(deps);
    case 'qoder':
      return createQoderRunManager(deps);
    default:
      throw new Error(`run manager not implemented: ${provider}`);
  }
}