import spawn from 'cross-spawn';

import { appConfig } from '@/modules/config/config.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

export class DshProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    // binPath is configurable, so fall back to the bare name when a deployment
    // blanks it out rather than passing an empty argv[0] to spawn.
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
      // No account identity exists for an API-key grant, so the UI has nothing
      // to label the credential with; the sibling convention of a sentinel
      // string (qoder's 'personal-access-token') does not apply here.
      email: null,
      method: cfgKey ? 'config' : envKey ? 'environment' : null,
      error: authenticated
        ? undefined
        : 'DeepSeek Harness not configured. Run `dsh login` or set DEEPSEEK_API_KEY.',
    };
  }
}
