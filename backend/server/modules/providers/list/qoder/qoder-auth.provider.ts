import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { appConfig } from '@/modules/config/config.js';

type QoderCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class QoderProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('qodercli', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'qoder',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  private async checkCredentials(): Promise<QoderCredentialsStatus> {
    // app.config PAT takes precedence; falls back to env (matches qodercli's
    // own precedence) and then browser OAuth.
    const cfgPat = appConfig().get().providers.qoder.personalAccessToken?.trim();
    if (cfgPat) {
      return { authenticated: true, email: 'personal-access-token', method: 'config' };
    }

    // PAT env var takes precedence (matches qodercli's own precedence).
    const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN?.trim();
    if (pat) {
      return { authenticated: true, email: 'personal-access-token', method: 'environment' };
    }

    // Browser OAuth writes tokens under ~/.qoder/.auth. The exact filename is
    // not documented, so accept any non-empty file in that directory.
    try {
      const authDir = path.join(os.homedir(), '.qoder', '.auth');
      const files = await readdir(authDir);
      for (const file of files) {
        const info = await stat(path.join(authDir, file));
        if (info.isFile() && info.size > 0) {
          return { authenticated: true, email: 'browser', method: 'credentials_file' };
        }
      }
    } catch {
      // .auth dir missing/empty → not authenticated
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'Qoder not configured. Run `qodercli login` or set QODER_PERSONAL_ACCESS_TOKEN.',
    };
  }
}
