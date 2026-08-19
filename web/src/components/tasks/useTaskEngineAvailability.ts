import { useEffect, useRef, useState } from 'react';

import type { TaskEngine } from '../../types/app';
import { api } from '../../utils/api';

export const ENGINE_IDS: TaskEngine[] = ['claude', 'codex', 'opencode', 'qoder'];

export const ENGINE_NAMES: Record<TaskEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  qoder: 'Qoder',
};

export type EngineAvailability =
  | { status: 'assistant' }
  | { status: 'loading' }
  | { status: 'ready'; options: TaskEngine[]; source: 'local' | 'remote'; hint?: string }
  | { status: 'unavailable'; hint: string };

const REMOTE_UNAVAILABLE_HINT = '该远程主机离线或无可用引擎';
const LOCAL_DEGRADE_HINT = '无法探测已安装引擎，已展示全部引擎';
const LOCAL_EMPTY_HINT = '本机未探测到已安装引擎';

/** Records shape returned by both /api/providers/installed and
 *  /api/remote-agents/:hostId/providers: `{ provider, installed }[]`. */
export type EngineInstalledRecord = { provider: TaskEngine; installed: boolean };

/** Installed providers, canonical ENGINE_IDS order. */
export function installedEngineOptions(records: EngineInstalledRecord[]): TaskEngine[] {
  return ENGINE_IDS.filter((id) => records.some((r) => r.provider === id && r.installed));
}

/**
 * Pure decision mapping for the task-form engine dropdown.
 * `records === null` means "the probe failed" (network/backend); the remote
 * branch treats failure exactly like an empty probe — disable, never degrade —
 * because the frontend cannot tell "host offline" from "network error" through
 * the current API and the user chose disable+hint for both.
 */
export function computeEngineAvailability(input: {
  isAssistant: boolean;
  targetHostId?: string | null;
  records?: EngineInstalledRecord[] | null;
}): EngineAvailability {
  if (input.isAssistant) return { status: 'assistant' };
  const remote = Boolean(input.targetHostId);

  if (input.records == null) {
    return remote
      ? { status: 'unavailable', hint: REMOTE_UNAVAILABLE_HINT }
      : { status: 'ready', options: [...ENGINE_IDS], source: 'local', hint: LOCAL_DEGRADE_HINT };
  }

  const options = installedEngineOptions(input.records);
  if (remote) {
    return options.length === 0
      ? { status: 'unavailable', hint: REMOTE_UNAVAILABLE_HINT }
      : { status: 'ready', options, source: 'remote' };
  }
  if (options.length === 0) {
    return { status: 'ready', options: [...ENGINE_IDS], source: 'local', hint: LOCAL_EMPTY_HINT };
  }
  return { status: 'ready', options, source: 'local' };
}

export type EngineTarget = { value: string; remoteHostId?: string | null } | null;

/** Resolve the engine list the form should offer for the selected project. */
export function useTaskEngineAvailability(
  target: EngineTarget,
  isAssistant: boolean,
): EngineAvailability {
  const [state, setState] = useState<EngineAvailability>({ status: 'loading' });
  const requestRef = useRef(0);

  useEffect(() => {
    // Next fetch (or a re-render with a different target) supersedes this one.
    const requestId = ++requestRef.current;
    if (isAssistant || !target) {
      setState({ status: 'assistant' });
      return;
    }
    setState({ status: 'loading' });
    const probe = target.remoteHostId
      ? api.getRemoteHostProviders(target.remoteHostId)
      : api.getInstalledProviders();

    probe
      .then((records) => {
        if (requestRef.current !== requestId) return;
        setState(
          computeEngineAvailability({
            isAssistant,
            targetHostId: target.remoteHostId ?? null,
            records: (records ?? []) as EngineInstalledRecord[],
          }),
        );
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return;
        console.error('resolve task engine availability failed:', error);
        setState(
          computeEngineAvailability({ isAssistant, targetHostId: target.remoteHostId ?? null, records: null }),
        );
      });
  }, [isAssistant, target?.value, target?.remoteHostId]);

  return state;
}
