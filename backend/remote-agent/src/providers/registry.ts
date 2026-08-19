import type { RemoteProvider } from '../../../server/shared/agent-runtime/protocol.js';
import type { QuerySdkLike, RunManager } from '../agent-run.js';
import { createClaudeRunManager } from '../agent-run.js';

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
 * T11 scopes the registry to the claude runner and makes every other provider
 * fail loudly with a `not implemented` error; Task 12 adds the codex /
 * opencode / qoder cases to the switch.
 */
export function createRunManagerFor(provider: RemoteProvider, deps: RunManagerDeps): RunManager {
  switch (provider) {
    case 'claude':
      return createClaudeRunManager(deps);
    default:
      throw new Error(`run manager not implemented: ${provider}`);
  }
}