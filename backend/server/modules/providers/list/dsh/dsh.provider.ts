import { DshProviderAuth } from '@/modules/providers/list/dsh/dsh-auth.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshProviderModels } from '@/modules/providers/list/dsh/dsh-models.provider.js';
import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';
import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';
import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class DshProvider extends AbstractProvider {
  readonly models: IProviderModels = new DshProviderModels();
  readonly mcp = new DshMcpProvider();
  readonly auth: IProviderAuth = new DshProviderAuth();
  readonly skills: IProviderSkills = new DshSkillsProvider();
  readonly sessions: IProviderSessions = new DshSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new DshSessionSynchronizer();

  constructor() {
    super('dsh');
  }
}
