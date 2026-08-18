import { z } from 'zod';

/**
 * Frame sent by the lite (remote) agent to the main process (lite → 主).
 *
 * - `hello`: first frame on connect. `roots` lists the host directories the
 *   lite agent is allowed to operate on; `capabilities` lists the supported
 *   features.
 * - `rpc_res`: reply to a `rpc_req`. `ok` marks success; on failure `error`
 *   carries a human-readable message string.
 * - `push`: unsolicited event notification delivered on a topic.
 * - `pong`: reply to a `ping`; `at` is the receive timestamp in ms epoch.
 */
export type AgentFrameIn =
  | { type: 'hello'; hostId: string; agentVersion: string; nodeVersion: string; os: string; roots: string[]; capabilities: string[] }
  | { type: 'rpc_res'; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'push'; topic: string; payload: unknown }
  | { type: 'pong'; at: number };

/**
 * Frame sent by the main process to the lite (remote) agent (主 → lite).
 *
 * - `rpc_req`: a method call the lite agent must execute; `params` are the
 *   method-specific arguments.
 * - `rpc_cancel`: aborts the in-flight request identified by `id`.
 * - `ping`: liveness probe; `at` is the send timestamp in ms epoch.
 */
export type AgentFrameOut =
  | { type: 'rpc_req'; id: string; method: string; params: unknown }
  | { type: 'rpc_cancel'; id: string }
  | { type: 'ping'; at: number };

/**
 * Decodes raw WebSocket input into an {@link AgentFrameIn}.
 *
 * Validates the `type` discriminant plus the required payload fields of each
 * variant (explicit field checks, so missing keys are rejected). Returns
 * `null` for non-object input, unknown types, or frames with missing/mistyped
 * required fields.
 */
export function decodeAgentFrameIn(raw: unknown): AgentFrameIn | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  switch (f.type) {
    case 'hello': {
      const { hostId, agentVersion, nodeVersion, os } = f;
      if (
        typeof hostId !== 'string' ||
        typeof agentVersion !== 'string' ||
        typeof nodeVersion !== 'string' ||
        typeof os !== 'string'
      ) {
        return null;
      }
      if (!isStringArray(f.roots) || !isStringArray(f.capabilities)) return null;
      return { type: 'hello', hostId, agentVersion, nodeVersion, os, roots: f.roots, capabilities: f.capabilities };
    }
    case 'rpc_res': {
      const { id, ok } = f;
      const data = 'data' in f ? f.data : undefined;
      const error = 'error' in f ? f.error : undefined;
      if (typeof id !== 'string' || typeof ok !== 'boolean') return null;
      if (error !== undefined && typeof error !== 'string') return null;
      return {
        type: 'rpc_res',
        id,
        ok,
        ...(data !== undefined ? { data } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    }
    case 'push': {
      if (typeof f.topic !== 'string' || !('payload' in f)) return null;
      return { type: 'push', topic: f.topic, payload: f.payload };
    }
    case 'pong': {
      if (typeof f.at !== 'number') return null;
      return { type: 'pong', at: f.at };
    }
    default:
      return null;
  }
}

/**
 * Type guard for {@link AgentFrameIn}; derived from `decodeAgentFrameIn`.
 */
export function isAgentFrameIn(frame: unknown): frame is AgentFrameIn {
  return decodeAgentFrameIn(frame) !== null;
}

/**
 * Decodes a raw WebSocket message into an {@link AgentFrameOut}.
 *
 * Validates the `type` discriminant plus the required payload fields of each
 * variant (id/method/params for `rpc_req`, id for `rpc_cancel`, `at` for
 * `ping`). Returns `null` for non-object input, unknown types, or frames with
 * missing/mistyped required fields.
 */
export function decodeAgentFrameOut(frame: unknown): AgentFrameOut | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const f = frame as Record<string, unknown>;
  switch (f.type) {
    case 'rpc_req': {
      const { id, method } = f;
      if (typeof id !== 'string' || typeof method !== 'string' || !('params' in f)) return null;
      return { type: 'rpc_req', id, method, params: f.params };
    }
    case 'rpc_cancel': {
      if (typeof f.id !== 'string') return null;
      return { type: 'rpc_cancel', id: f.id };
    }
    case 'ping': {
      if (typeof f.at !== 'number') return null;
      return { type: 'ping', at: f.at };
    }
    default:
      return null;
  }
}

/**
 * Type guard for {@link AgentFrameOut}; derived from `decodeAgentFrameOut`.
 */
export function isAgentFrameOut(frame: unknown): frame is AgentFrameOut {
  return decodeAgentFrameOut(frame) !== null;
}

/**
 * Constructor: builds an `rpc_req` frame for `method` with the given `params`.
 */
export function encodeRpcRequest(id: string, method: string, params: unknown): AgentFrameOut {
  return { type: 'rpc_req', id, method, params };
}

/**
 * Constructor: builds an `rpc_cancel` frame aborting the request with `id`.
 */
export function makeRpcCancel(id: string): AgentFrameOut {
  return { type: 'rpc_cancel', id };
}

/**
 * Constructor: builds a `ping` liveness probe with a ms epoch timestamp.
 */
export function makePing(): AgentFrameOut {
  return { type: 'ping', at: Date.now() };
}

/**
 * Zod schema for `session/start` `rpc_req` params.
 *
 * `providerSessionId` defaults to `null`; `cwd` and `command` are required.
 */
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

/**
 * `fs.stat`-style metadata returned for a remote path.
 */
export type RemoteStat = {
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}