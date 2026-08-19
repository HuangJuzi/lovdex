import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelOption,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';
import {
  DEFAULT_EFFORT_VALUE,
  FALLBACK_PROVIDER_EFFORT_VALUES,
  toProviderEffortOptions,
} from '../constants/providerEffort';

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  codex: 'gpt-5.4',
  opencode: 'opencode/deepseek-v4-flash-free',
  qoder: 'auto',
};

const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder'];

/**
 * Providers whose runtime actually honors the persisted session-scoped model
 * override on resume. claude and codex call `resolveResumeModel`, which makes a
 * `/model` selection stick to a session across reopens even when the request
 * default (localStorage) changes afterward. opencode/qoder only forward the
 * per-send `--model`, so their override is cosmetic — the composer must keep
 * showing the localStorage value those runtimes actually send. Gate the
 * active-model override read/apply on this set.
 */
const RUNTIME_HONORS_SESSION_MODEL_OVERRIDE = new Set<LLMProvider>(['claude', 'codex']);

const readStoredProvider = (): LLMProvider => {
  const storedProvider = localStorage.getItem('selected-provider');
  return PROVIDERS.includes(storedProvider as LLMProvider)
    ? storedProvider as LLMProvider
    : 'claude';
};

/**
 * Fallback permission-mode matrix used only until the backend capability
 * matrix (`GET /api/providers/capabilities`) has loaded. The backend is the
 * source of truth; this mirror exists so the composer renders sensibly on
 * first paint and when the capabilities request fails.
 */
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  qoder: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
  /**
   * The linked task's `executor_model` for the selected session, when that
   * session is linked to a task. `undefined` means "no linked task (or the
   * reverse-lookup has not resolved yet)" and leaves the chat model untouched;
   * `null`/string means the session belongs to a task.
   *
   * A task run sends `options.model = task.executor_model || undefined`, so the
   * session actually executes with the task's model (or the provider default
   * when blank). The composer indicator, however, reads the per-provider model
   * stored in localStorage — a different source of truth. Syncing the provider
   * model to the task's resolved model when the session opens keeps the task
   * detail's 模型 field and the session's model indicator consistent.
   */
  linkedTaskModel?: string | null;
}

/**
 * Compute the chat model a task-linked session should display / send with.
 * - A task that names an `executor_model` → that model.
 * - A task that leaves it blank (默认模型) → the provider catalog default (the
 *   same model the backend run resolves when `chat.send` carries no model).
 * - No linked task (`linkedTaskModel === undefined`) → null (no change).
 * Returns null when the model is still unknown (catalog default not loaded).
 */
export function resolveLinkedTaskModel(
  linkedTaskModel: string | null | undefined,
  catalogDefault: string | undefined,
): string | null {
  if (linkedTaskModel === undefined) return null;
  if (typeof linkedTaskModel === 'string' && linkedTaskModel.trim()) return linkedTaskModel.trim();
  if (catalogDefault && catalogDefault.trim()) return catalogDefault.trim();
  return null;
}

/**
 * Compute the model the composer should display for the selected session, in
 * priority order:
 * 1. A persisted session-scoped override (a `/model` selection made inside the
 *    session) — the runtime applies this on resume, so it must not be clobbered
 *    by the task's `executor_model`.
 * 2. A task-linked session's resolved model (`executor_model`, or the catalog
 *    default when the task leaves it blank).
 * 3. The plain per-provider model (localStorage) unchanged.
 * Returns the target model, or `currentModel` when nothing overrides it.
 */
export function resolveSessionComposerModel(input: {
  sessionOverrideModel?: string | null;
  linkedTaskModel?: string | null | undefined;
  catalogDefault?: string;
  currentModel: string;
}): string {
  const { sessionOverrideModel, linkedTaskModel, catalogDefault, currentModel } = input;
  if (typeof sessionOverrideModel === 'string' && sessionOverrideModel.trim()) {
    return sessionOverrideModel.trim();
  }
  if (linkedTaskModel !== undefined) {
    const taskModel = resolveLinkedTaskModel(linkedTaskModel, catalogDefault);
    if (taskModel) return taskModel;
  }
  return currentModel;
}

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
    cache?: ProviderModelsCacheInfo;
  };
};

type ChangeActiveModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string;
    supported?: boolean;
    changed?: boolean;
    model?: string | null;
  };
};

export function useChatProviderState({ selectedSession, selectedProject: _selectedProject, linkedTaskModel }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<LLMProvider>(readStoredProvider);
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || FALLBACK_DEFAULT_MODEL.claude;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || FALLBACK_DEFAULT_MODEL.codex;
  });
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });
  const [opencodeModel, setOpenCodeModel] = useState<string>(() => {
    return localStorage.getItem('opencode-model') || FALLBACK_DEFAULT_MODEL.opencode;
  });
  const [qoderModel, setQoderModel] = useState<string>(() => {
    return localStorage.getItem('qoder-model') || FALLBACK_DEFAULT_MODEL.qoder;
  });

  /**
   * Backend-owned capability matrix keyed by provider. Drives the permission
   * mode picker (and is the extension point for future per-provider UI
   * differences) so the frontend stays free of hardcoded provider branching.
   * Null until `/api/providers/capabilities` resolves; the static fallback
   * map covers that window.
   */
  const [providerCapabilities, setProviderCapabilities] = useState<
    Partial<Record<LLMProvider, ProviderCapabilities>> | null
  >(null);

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);

  const providerModelsRequestIdRef = useRef(0);

  /**
   * Persisted session-scoped model overrides keyed by app session id: set when
   * the active-model fetch resolves on session open, or when `selectProviderModel`
   * writes a session-scoped change. The composer-model sync effect below reads
   * it so a `/model` selection made inside a session survives reopens AND
   * outranks the linked task's `executor_model` (the runtime honors the
   * override on resume). Keyed by session so switching sessions never leaks a
   * previous session's override into the next.
   */
  const sessionOverrideModelRef = useRef<Record<string, string>>({});

  /**
   * The last model this hook itself applied per session id (from the composer
   * sync effect below). Used as a loop guard against the catalog reconciliation
   * effects — see the sync effect's comment.
   */
  const lastAppliedComposerModelRef = useRef<Record<string, string>>({});

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    if (targetProvider === 'claude') {
      setClaudeModel(model);
      localStorage.setItem('claude-model', model);
      return;
    }

    if (targetProvider === 'codex') {
      setCodexModel(model);
      localStorage.setItem('codex-model', model);
      return;
    }

    if (targetProvider === 'qoder') {
      setQoderModel(model);
      localStorage.setItem('qoder-model', model);
      return;
    }

    setOpenCodeModel(model);
    localStorage.setItem('opencode-model', model);
  }, []);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(`${targetProvider}-effort`, effort);
  }, []);

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    try {
      const results = await Promise.all(
        PROVIDERS.map(async (p) => {
          const params = new URLSearchParams();
          if (options.bypassCache) {
            params.set('bypassCache', 'true');
          }

          const queryString = params.toString();
          const response = await authenticatedFetch(`/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`);
          const body = (await response.json()) as ProviderModelsApiResponse;
          if (!body.success || !body.data?.models || !body.data?.cache) {
            return null;
          }

          return body.data;
        }),
      );

      if (providerModelsRequestIdRef.current !== requestId) {
        return;
      }

      const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
      const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};

      PROVIDERS.forEach((p, i) => {
        const entry = results[i];
        if (!entry) {
          return;
        }

        nextCatalog[p] = entry.models;
        nextCacheCatalog[p] = entry.cache;
      });

      setProviderModelCatalog(nextCatalog);
      setProviderModelCacheCatalog(nextCacheCatalog);
    } catch (error) {
      console.error('Error loading provider models:', error);
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
        setProviderModelsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/capabilities');
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (cancelled || !body.success || !Array.isArray(body.data?.providers)) {
          return;
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }
        setProviderCapabilities(byProvider);
      } catch (error) {
        console.error('Error loading provider capabilities:', error);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    const capabilityModes = providerCapabilities?.[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return FALLBACK_PERMISSION_MODES[targetProvider] ?? ['default'];
  }, [providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities?.[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return modes[0] ?? 'default';
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsEffort;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return Boolean(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider]?.length);
  }, [providerCapabilities]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = localStorage.getItem(storageKey);
    if (stored && def.OPTIONS.some((o) => o.value === stored)) {
      return stored;
    }
    if (current && def.OPTIONS.some((o) => o.value === current)) {
      return current;
    }
    return def.DEFAULT;
  };

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    const definition = providerModelCatalog[targetProvider];
    if (!definition) {
      return null;
    }

    return definition.OPTIONS.find((option) => option.value === model) ?? null;
  }, [providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return toProviderEffortOptions(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider] ?? []);
  }, [getModelOption, getSupportsEffortForProvider]);

  const getAllowedEffortValues = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): string[] => (
    getEffortOptionsForModel(targetProvider, model).map((value) => value.value)
  ), [getEffortOptionsForModel]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    const allowedValues = getAllowedEffortValues(targetProvider, model);
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getAllowedEffortValues]);

  const providerModels = useMemo<Record<LLMProvider, string>>(() => ({
    claude: claudeModel,
    codex: codexModel,
    opencode: opencodeModel,
    qoder: qoderModel,
  }), [claudeModel, codexModel, opencodeModel, qoderModel]);

  useEffect(() => {
    const claude = providerModelCatalog.claude;
    if (claude) {
      const next = pickStoredOrCurrent('claude-model', claudeModel, claude);
      if (next !== claudeModel) {
        setClaudeModel(next);
      }
      if (localStorage.getItem('claude-model') !== next) {
        localStorage.setItem('claude-model', next);
      }
    }
  }, [providerModelCatalog.claude, claudeModel]);

  useEffect(() => {
    const codex = providerModelCatalog.codex;
    if (codex) {
      const next = pickStoredOrCurrent('codex-model', codexModel, codex);
      if (next !== codexModel) {
        setCodexModel(next);
      }
      if (localStorage.getItem('codex-model') !== next) {
        localStorage.setItem('codex-model', next);
      }
    }
  }, [providerModelCatalog.codex, codexModel]);

  useEffect(() => {
    const opencode = providerModelCatalog.opencode;
    if (opencode) {
      const next = pickStoredOrCurrent('opencode-model', opencodeModel, opencode);
      if (next !== opencodeModel) {
        setOpenCodeModel(next);
      }
      if (localStorage.getItem('opencode-model') !== next) {
        localStorage.setItem('opencode-model', next);
      }
    }
  }, [providerModelCatalog.opencode, opencodeModel]);

  useEffect(() => {
    const qoder = providerModelCatalog.qoder;
    if (qoder) {
      const next = pickStoredOrCurrent('qoder-model', qoderModel, qoder);
      if (next !== qoderModel) {
        setQoderModel(next);
      }
      if (localStorage.getItem('qoder-model') !== next) {
        localStorage.setItem('qoder-model', next);
      }
    }
  }, [providerModelCatalog.qoder, qoderModel]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDERS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const nextEffort = reconcileStoredEffort(targetProvider, providerModels[targetProvider], currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(`${targetProvider}-effort`, nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  // Keep the composer model aligned with the model the selected session will
  // actually use on its next turn. Priority:
  //   1. A persisted session-scoped override (a `/model` selection made inside
  //      the session) — the runtime applies it on resume, so it must win over
  //      the task's executor_model. Landed in `sessionOverrideModelRef` by the
  //      active-model fetch below or by selectProviderModel.
  //   2. A task-linked session's resolved model (task detail 模型 field, or the
  //      provider catalog default when the task leaves it blank).
  //   3. The plain per-provider default already in localStorage.
  // Recomputing against the CURRENT state (instead of a once-per-session flag)
  // also covers a task model edited on the task detail while the session stays
  // open: the linkedTaskModel change flows through `task_upserted` and re-applies
  // here, where a one-shot guard would have kept the old value forever.
  useEffect(() => {
    const sid = selectedSession?.id;
    const sessionProvider = selectedSession?.__provider;
    if (!sid || !sessionProvider || !PROVIDERS.includes(sessionProvider)) return;
    const target = resolveSessionComposerModel({
      sessionOverrideModel: sessionOverrideModelRef.current[sid],
      linkedTaskModel,
      catalogDefault: providerModelCatalog[sessionProvider]?.DEFAULT,
      currentModel: providerModels[sessionProvider],
    });
    if (!target || target === providerModels[sessionProvider]) return;
    // Loop guard against the catalog reconciliation effects: when a
    // task/override model is NOT in the provider catalog, pickStoredOrCurrent
    // reverts the composer to the catalog default and we would re-apply ours
    // forever. Stop once the composer already shows OUR target and the current
    // value is the plain catalog default (someone reconciled it away); keep
    // re-applying when the current value drifted for another reason (e.g. a
    // different session changed the shared default) or the target changed.
    if (
      lastAppliedComposerModelRef.current[sid] === target
      && providerModels[sessionProvider] === providerModelCatalog[sessionProvider]?.DEFAULT
    ) {
      return;
    }
    lastAppliedComposerModelRef.current[sid] = target;
    setStoredProviderModel(sessionProvider, target);
  }, [selectedSession?.id, selectedSession?.__provider, linkedTaskModel, providerModelCatalog, providerModels, setStoredProviderModel]);

  // Read the selected session's persisted model override (if any) on open, so
  // the composer reflects what the next turn will run with even after a page
  // reload / session reopen — the override alone is the runtime's resume source
  // of truth for claude/codex. opencode/qoder send the composer value verbatim,
  // so their (unused) override must NOT be applied here.
  useEffect(() => {
    const sid = selectedSession?.id;
    const sessionProvider = selectedSession?.__provider;
    if (!sid || !sessionProvider || !PROVIDERS.includes(sessionProvider)) return;
    if (!RUNTIME_HONORS_SESSION_MODEL_OVERRIDE.has(sessionProvider)) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/providers/${sessionProvider}/sessions/${encodeURIComponent(sid)}/active-model`,
        );
        if (cancelled) return;
        const body = (await response.json()) as {
          success?: boolean;
          data?: { supported?: boolean; changed?: boolean; model?: string | null };
        };
        if (!body.success) return;
        const data = body.data;
        if (data?.supported === true && data.changed === true && typeof data.model === 'string' && data.model.trim()) {
          sessionOverrideModelRef.current[sid] = data.model.trim();
          setStoredProviderModel(sessionProvider, data.model.trim());
        }
      } catch (error) {
        // Best-effort lookup: a backend that predates the GET endpoint (or a
        // transient failure) just leaves the composer on the task/localStorage
        // model — the next in-session /model read stays authoritative.
        console.debug('[useChatProviderState] session active-model lookup failed:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id, selectedSession?.__provider, setStoredProviderModel]);

  useEffect(() => {
    const validModes = getPermissionModesForProvider(provider);
    const sessionSavedMode = selectedSession?.id
      ? (localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null)
      : null;
    // Fall back to the last mode picked for this provider: a brand-new chat
    // only receives its session id after the first send, so without this the
    // mode chosen beforehand would snap back to the default as soon as the
    // session id appears.
    const providerSavedMode = localStorage.getItem(`permissionMode-last-${provider}`) as PermissionMode | null;
    const savedMode = [sessionSavedMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(provider));
  }, [selectedSession?.id, provider, getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    // Persist per provider as well as per session: a brand-new chat has no
    // session id yet, and the per-provider key keeps the choice sticky when
    // the real id arrives (and for future sessions of this provider).
    localStorage.setItem(`permissionMode-last-${provider}`, nextMode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedSession?.id, getPermissionModesForProvider]);

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setStoredProviderModel(targetProvider, model);
      return {
        scope: 'default' as const,
        changed: false,
        model,
      };
    }

    const response = await authenticatedFetch(
      `/api/providers/${targetProvider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
      },
    );

    const body = (await response.json()) as ChangeActiveModelApiResponse;
    if (!response.ok || !body.success || !body.data?.supported) {
      throw new Error('Unable to change the active model for this session.');
    }

    const resolvedModel = body.data.model || model;
    // Keep the composer's model indicator in sync. The indicator reads the
    // provider model state (claudeModel etc.), which a session-scoped change
    // otherwise leaves untouched — only the backend's pending model was updated,
    // so the input box kept showing the old model after the modal switched.
    setStoredProviderModel(targetProvider, resolvedModel);
    // The session now owns its model (the backend persisted the override): mark
    // it so the task-linked sync defers to the override instead of reverting the
    // composer to the task's (possibly stale) executor_model if the reverse
    // write-back lags or fails.
    sessionOverrideModelRef.current[normalizedSessionId] = resolvedModel;

    return {
      scope: 'session' as const,
      changed: body.data.changed === true,
      model: resolvedModel,
    };
  }, [setStoredProviderModel]);

  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(provider, providerModels[provider]);
  }, [getEffortOptionsForModel, provider, providerModels]);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      provider,
      providerModels[provider],
      providerEfforts[provider] ?? DEFAULT_EFFORT_VALUE,
    );
  }, [provider, providerEfforts, providerModels, reconcileStoredEffort]);

  return {
    provider,
    setProvider,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    qoderModel,
    setQoderModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  };
}
