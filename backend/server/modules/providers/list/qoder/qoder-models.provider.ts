import spawn from 'cross-spawn';

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

export const QODER_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'Auto', description: 'Qoder' },
    { value: 'lite', label: 'Lite', description: 'Qoder' },
    { value: 'performance', label: 'Performance', description: 'Qoder' },
    { value: 'Qwen3.8-Max', label: 'Qwen3.8 Max', description: 'Qoder' },
  ],
  DEFAULT: 'auto',
};

function listModelsFromCli(): string[] {
  try {
    const result = spawn.sync('qodercli', ['--list-models'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, encoding: 'utf8' });
    if (result.error || result.status !== 0 || !result.stdout) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.toUpperCase() !== 'MODEL');
  } catch {
    return [];
  }
}

export class QoderProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const cliModels = listModelsFromCli();
    const known = new Set(QODER_PREDEFINED_MODELS.OPTIONS.map((o) => o.value));
    const extra = cliModels
      .filter((m) => !known.has(m))
      .map((m) => ({ value: m, label: m, description: 'Qoder' }));
    return {
      OPTIONS: [...QODER_PREDEFINED_MODELS.OPTIONS, ...extra],
      DEFAULT: QODER_PREDEFINED_MODELS.DEFAULT,
    };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(QODER_PREDEFINED_MODELS);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('qoder', input);
  }
}
