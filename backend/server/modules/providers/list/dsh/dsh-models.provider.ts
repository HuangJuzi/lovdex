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
 * dsh's live model catalog is only reachable from a started ACP runtime (via
 * `session/set_config_option`); this facet has no runtime handle, so this
 * static placeholder is currently the only catalog it can offer.
 *
 * PROVENANCE: these ids are taken from DeepSeek Harness's own shipped package
 * examples, NOT from a verified live catalog —
 *   - 'deepseek-v4-flash' appears in `@deepseek-ai/dsh-sdk-client`'s README
 *   - 'deepseek-v4-pro'   appears in `@deepseek-ai/dsh-acp`'s README
 * The 'default' slot is the provider-neutral choice and is the safe default.
 * Re-verify all three against a real dsh runtime before trusting the picker
 * (tracked as the Task 11 acceptance check).
 */
export const DSH_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'default', label: 'Default', description: 'DeepSeek Harness' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'DeepSeek Harness' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'DeepSeek Harness' },
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
