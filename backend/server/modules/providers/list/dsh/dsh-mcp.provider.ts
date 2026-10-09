import type { IProviderMcp } from '@/shared/interfaces.js';
import type {
  McpScope,
  ProviderMcpServer,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * dsh mounts MCP servers per session over ACP — the runner passes them into
 * `session/new`'s `mcpServers` parameter. Unlike the other providers there is
 * no persisted, addressable on-disk server store to list or mutate, so this
 * facet reads empty and rejects writes instead of silently dropping them.
 */
export class DshMcpProvider implements IProviderMcp {
  async listServers(): Promise<Record<McpScope, ProviderMcpServer[]>> {
    return { user: [], local: [], project: [] };
  }

  async listServersForScope(
    _scope: McpScope,
    _options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    return [];
  }

  async upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    throw new AppError(
      `dsh mounts MCP servers per session over ACP, so "${input.name}" cannot be persisted here.`,
      { code: 'PROVIDER_MCP_WRITE_UNSUPPORTED', statusCode: 400 },
    );
  }

  async removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: 'dsh'; name: string; scope: McpScope }> {
    return { removed: false, provider: 'dsh', name: input.name, scope: input.scope ?? 'project' };
  }
}
