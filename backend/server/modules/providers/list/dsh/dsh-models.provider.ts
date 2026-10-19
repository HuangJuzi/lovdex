import { appConfig } from '@/modules/config/config.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Catalog fallback for dsh.
 *
 * The live catalog is only reachable from a started ACP runtime: `session/new`
 * returns `configOptions` whose `model` entry groups real route ids, and
 * `session/set_config_option` switches between them. This facet has no runtime
 * handle, so it ships a static list for the picker's cold path, plus
 * config-driven `customModels` entries appended by `getSupportedModels` (read
 * fresh from app.config on every call, like the claude provider).
 *
 * PROVENANCE: the `deepseek-v4-flash` / `deepseek-flash` / `deepseek-v4-pro`
 * values were read back from a real `dsh --profile acp` session's
 * `configOptions[model]` (re-probed 2026-10-16). The wire format is a
 * JSON-encoded `[provider, model]` route pair, so the runner sends exactly
 * this string as the ACP config-option value; the adapter passes the model
 * through to whatever endpoint the route resolves to.
 *
 * The `deepseek-official` route name is the Messages adapter's own, and the
 * shipped acp profile mounts it with no fixed model, so any id the endpoint
 * serves works — including the ones the llm-proxy fronts for the claude
 * provider (its upstream answers `DeepSeek-Flash`, `DeepSeek-V4-Pro-0813`,
 * `glm-5.3-flash`, `claude-opus-4-8`, `GLM-5.3`; all verified reachable).
 * Only the two dsh-native ids are listed here to keep the cold-path picker
 * honest; the live catalog supersedes this list once a runtime is up.
 */

/**
 * Every model offers the same reasoning-effort slot set, but the names are
 * dsh's own: it accepts exactly `off/low/high/max` (verified live — the frontend
 * offers overlap but are NOT the same as this set). `high` is the runtime's own
 * default, so the option's `default` mirrors it rather than the app-wide
 * `'default'` sentinel, which dsh would reject as an unknown value.
 */
const DSH_EFFORT: NonNullable<ProviderModelOption['effort']> = {
  default: 'high',
  values: [
    { value: 'off' },
    { value: 'low' },
    { value: 'high' },
    { value: 'max' },
  ],
};

export const DSH_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'default', label: 'Default', description: 'DeepSeek Harness', effort: DSH_EFFORT },
    { value: '["deepseek-official","deepseek-v4-flash"]', label: 'DeepSeek V4 Flash', description: 'deepseek-official', effort: DSH_EFFORT },
    { value: '["deepseek-official","deepseek-flash"]', label: 'DeepSeek V41 Flash', description: 'deepseek-official', effort: DSH_EFFORT },
    { value: '["deepseek-official","deepseek-v4-pro"]', label: 'DeepSeek V4 Pro', description: 'deepseek-official', effort: DSH_EFFORT },
  ],
  DEFAULT: 'default',
};

/**
 * Parse a `route|model[|label]` customModels entry into a picker option whose
 * value is the same `["route","model"]` wire format the predefined entries
 * use, so the runner forwards it unchanged. Malformed entries (fewer than two
 * segments, empty route/model) are skipped silently — dropping one line in the
 * settings textarea must not take the whole list down.
 * Segments beyond the third are ignored; ids containing | are not
 * representable (dsh route names and model ids never contain it).
 * Entries whose wire value collides with a predefined one are dropped: the
 * pickers key options by value, so a duplicate would break React keys without
 * adding anything (selecting either entry is equivalent).
 */
export function buildDshCustomModelOptions(
  customModels: readonly string[] | undefined,
  predefinedValues: ReadonlySet<string> = new Set(DSH_PREDEFINED_MODELS.OPTIONS.map((o) => o.value)),
): ProviderModelOption[] {
  const out: ProviderModelOption[] = [];
  for (const raw of customModels ?? []) {
    const parts = raw.split('|').map((p) => p.trim());
    const [route, model, label] = parts;
    if (!route || !model) continue;
    const value = JSON.stringify([route, model]);
    if (predefinedValues.has(value)) continue;
    out.push({
      value,
      label: label || model,
      description: route,
      effort: DSH_EFFORT,
    });
  }
  return out;
}

export class DshProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const custom = appConfig().get().providers.dsh.customModels;
    return {
      OPTIONS: [
        ...DSH_PREDEFINED_MODELS.OPTIONS,
        ...buildDshCustomModelOptions(custom),
      ],
      DEFAULT: DSH_PREDEFINED_MODELS.DEFAULT,
    };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(DSH_PREDEFINED_MODELS);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('dsh', input);
  }
}
