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
 * dsh surfaces its live model catalog through ACP `session/set_config_option`,
 * which is only reachable while a session/runtime is up. Until a running
 * runtime is queried, this static list stands in — mirroring how qoder ships a
 * predefined catalog and appends CLI-discovered extras.
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
    return DSH_PREDEFINED_MODELS;
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
