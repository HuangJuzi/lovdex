import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';
import { OpenCodeMcpProvider } from '@/modules/providers/list/opencode/opencode-mcp.provider.js';
import { OpenCodeProviderModels } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { OpenCodeSkillsProvider } from '@/modules/providers/list/opencode/opencode-skills.provider.js';
import type { IProviderAuth, IProviderMcp, IProviderModels, IProviderSkills, IProviderSessions } from '@/shared/interfaces.js';

export class OpenCodeProvider extends AbstractProvider {
  readonly models: IProviderModels = new OpenCodeProviderModels();
  readonly mcp: IProviderMcp = new OpenCodeMcpProvider();
  readonly auth: IProviderAuth = new OpenCodeProviderAuth();
  readonly skills: IProviderSkills = new OpenCodeSkillsProvider();
  readonly sessions: IProviderSessions = new OpenCodeSessionsProvider();
  readonly sessionSynchronizer = new OpenCodeSessionSynchronizer();

  constructor() {
    super('opencode');
  }
}