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
 * Model catalog for dsh.
 *
 * The live catalog is only reachable from a started ACP runtime: `session/new`
 * returns `configOptions` whose `model` entry groups real route ids, and
 * `session/set_config_option` switches between them. This facet has no runtime
 * handle, so the picker is built from app.config on every call (like the
 * claude provider): the `default` slot plus one option per
 * `providers.dsh.customModels` line.
 *
 * There is deliberately NO built-in model list. Model ids belong to whatever
 * endpoint the active provider profile points at (DeepSeek official, an
 * llm-proxy upstream, a vendor gateway, ...); serving one vendor's ids to a
 * deployment configured for another made the picker misleading. Each profile
 * carries its own list, and switching profiles switches the list.
 *
 * Wire format: the ACP config-option value is a JSON-encoded `[route, model]`
 * pair (read back from a real `dsh --profile acp` session, re-probed
 * 2026-10-16). The `deepseek-official` route name is the Messages adapter's
 * own; the shipped acp profile mounts it with no fixed model, so any id the
 * endpoint serves works. Bare `customModels` lines are wrapped with that route.
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

/** The only always-present option: let dsh use its own default model. */
const DSH_DEFAULT_MODEL = 'default';
const DSH_DEFAULT_OPTION: ProviderModelOption = {
  value: DSH_DEFAULT_MODEL,
  label: 'Default',
  description: 'dsh default',
  effort: DSH_EFFORT,
};

export const DSH_BUILTIN_MODELS: ProviderModelsDefinition = {
  OPTIONS: [DSH_DEFAULT_OPTION],
  DEFAULT: DSH_DEFAULT_MODEL,
};

/**
 * Turn `customModels` lines into picker options. The documented form is one
 * bare model id per line (`glm-5.3`); it is wrapped in the `deepseek-official`
 * route pair the runner forwards unchanged. A `route|model[|label]` line is
 * still accepted for lists saved by the earlier format. Empty lines are
 * skipped silently — a stray blank line must not take the whole list down.
 * Duplicate `[route, model]` pairs yield one option: the pickers key options
 * by value, so a repeated value would break React keys.
 */
export function buildDshCustomModelOptions(customModels: readonly string[] | undefined): ProviderModelOption[] {
  const out: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of customModels ?? []) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.includes('|') ? line.split('|').map((p) => p.trim()) : null;
    const route = parts ? parts[0] : 'deepseek-official';
    const model = parts ? parts[1] : line;
    const label = parts ? parts[2] : '';
    if (!route || !model) continue;
    const value = JSON.stringify([route, model]);
    if (seen.has(value)) continue;
    seen.add(value);
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
    return {
      OPTIONS: [
        DSH_DEFAULT_OPTION,
        ...buildDshCustomModelOptions(appConfig().get().providers.dsh.customModels),
      ],
      DEFAULT: DSH_DEFAULT_MODEL,
    };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(DSH_BUILTIN_MODELS);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('dsh', input);
  }
}
