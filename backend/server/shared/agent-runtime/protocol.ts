import { z } from 'zod';

/** lite → 主 */
export type AgentFrameIn =
  | { type: 'hello'; hostId: string; agentVersion: string; nodeVersion: string; os: string; roots: string[]; capabilities: string[] }
  | { type: 'rpc_res'; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'push'; topic: string; payload: unknown }
  | { type: 'pong'; at: number };

/** 主 → lite */
export type AgentFrameOut =
  | { type: 'rpc_req'; id: string; method: string; params: unknown }
  | { type: 'rpc_cancel'; id: string }
  | { type: 'ping'; at: number };

export function isAgentFrameOut(frame: unknown): frame is AgentFrameOut {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return f.type === 'rpc_req' || f.type === 'rpc_cancel' || f.type === 'ping';
}

export function encodeRpcRequest(id: string, method: string, params: unknown): AgentFrameOut {
  return { type: 'rpc_req', id, method, params };
}

export function makePing(): AgentFrameOut {
  return { type: 'ping', at: Date.now() };
}

export function makeSessionStartParamsSchema() {
  return z.object({
    appSessionId: z.string().min(1),
    providerSessionId: z.string().nullish().default(null),
    command: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    includePartialMessages: z.boolean().optional(),
  });
}

export type RemoteStat = {
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
};
