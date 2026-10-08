import spawn from 'cross-spawn';

import { appConfig } from '@/modules/config/config.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

export class DshProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    const binPath = appConfig().get().providers.dsh.binPath || 'dsh';
    try {
      const result = spawn.sync(binPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const cfgKey = appConfig().get().providers.dsh.apiKey?.trim();
    const envKey = process.env.DEEPSEEK_API_KEY?.trim();
    const authenticated = Boolean(cfgKey || envKey);

    return {
      installed,
      provider: 'dsh',
      authenticated,
      email: null,
      method: cfgKey ? 'config' : envKey ? 'environment' : null,
      error: authenticated
        ? undefined
        : 'DeepSeek Harness not configured. Set DEEPSEEK_API_KEY or run dsh login.',
    };
  }
}
