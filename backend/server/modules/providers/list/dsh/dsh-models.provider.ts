import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
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
 * handle, so it ships a static list for the picker's cold path.
 *
 * PROVENANCE: the `deepseek-v4-flash` / `deepseek-v4-pro` values were read back
 * from a real `dsh --profile acp` session's `configOptions[model]`. The wire
 * format is a JSON-encoded `[provider, model]` route pair, so the runner sends
 * exactly this string as the ACP config-option value; the adapter passes the
 * model through to whatever endpoint the route resolves to.
 *
 * The `deepseek-official` route name is the Messages adapter's own, and the
 * shipped acp profile mounts it with no fixed model, so any id the endpoint
 * serves works — including the ones the llm-proxy fronts for the claude
 * provider (its upstream answers `DeepSeek-Flash`, `DeepSeek-V4-Pro-0813`,
 * `glm-5.3-flash`, `claude-opus-4-8`, `GLM-5.3`; all verified reachable).
 * Only the two dsh-native ids are listed here to keep the cold-path picker
 * honest; the live catalog supersedes this list once a runtime is up.
 */
export const DSH_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'default', label: 'Default', description: 'DeepSeek Harness' },
    { value: '["deepseek-official","deepseek-v4-flash"]', label: 'DeepSeek V4 Flash', description: 'deepseek-official' },
    { value: '["deepseek-official","deepseek-v4-pro"]', label: 'DeepSeek V4 Pro', description: 'deepseek-official' },
  ],
  DEFAULT: 'default',
};

export class DshProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return {
      OPTIONS: [...DSH_PREDEFINED_MODELS.OPTIONS],
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
