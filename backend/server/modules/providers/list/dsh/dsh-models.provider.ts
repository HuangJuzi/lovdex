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
 * PROVENANCE: every value below was read back from a real
 * `dsh --profile acp` session (`session/new`'s `configOptions[model]`) — not
 * copied from documentation. The wire format is a JSON-encoded
 * `[provider, model]` route pair; the runner sends exactly this string as the
 * ACP config-option value. The 'default' slot is the provider-neutral choice
 * and stays first so the pre-runtime picker has a safe selection.
 */
export const DSH_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'default', label: 'Default', description: 'DeepSeek Harness' },
    { value: '["deepseek-official","deepseek-v4-flash"]', label: 'DeepSeek V4 Flash', description: 'deepseek-official' },
    { value: '["deepseek-official","deepseek-v4-pro"]', label: 'DeepSeek V4 Pro', description: 'deepseek-official' },
    { value: '["deepseek-official","deepseek-flash"]', label: 'DeepSeek Flash', description: 'deepseek-official' },
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
