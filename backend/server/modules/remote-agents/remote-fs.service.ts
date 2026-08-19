import type { RemoteStat } from '@/shared/agent-runtime/protocol.js';

import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

/** Capped read size for remote file reads (bytes). */
export const REMOTE_MAX_READ_BYTES = 32 * 1024 * 1024; // 32 MiB

/** Capped upload size for remote file writes (bytes). */
export const REMOTE_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** One node of a remote file tree (a directory walked recursively). */
export type RemoteFileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink: boolean;
  children?: RemoteFileTreeNode[];
  [key: string]: unknown;
};

/** One entry of a remote directory listing (mirrors the lite's fs.ts shape). */
export type RemoteDirEntry = {
  name: string;
  type: 'dir' | 'file' | 'symlink';
  size: number | null;
};

/** fs/list result: the RESOLVED absolute path + the entries under it. */
export type RemoteDirList = { path: string; entries: RemoteDirEntry[] };

/**
 * Filesystem RPC client over a remote lite agent.
 *
 * Each method forwards to the registry's `rpc` for the given host, using the
 * `fs/*` methods the lite agent implements. `getRegistry` is a thunk so the
 * live registry is resolved lazily (the runtime seam is wired at boot, after
 * this client is constructed).
 */
export type RemoteFsClient = {
  stat(hostId: string, pathText: string): Promise<RemoteStat>;
  list(hostId: string, pathText: string, maxEntries?: number): Promise<RemoteDirList>;
  read(
    hostId: string,
    pathText: string,
    maxBytes?: number,
    encoding?: 'utf8' | 'base64',
  ): Promise<{ content: string; truncated: boolean }>;
  tree(
    hostId: string,
    pathText: string,
    maxDepth?: number,
    showHidden?: boolean,
  ): Promise<{ path: string; nodes: RemoteFileTreeNode[] }>;
  write(
    hostId: string,
    pathText: string,
    content: string,
    encoding?: 'utf8' | 'base64',
  ): Promise<{ success: boolean; size: number }>;
  create(
    hostId: string,
    parentPath: string,
    type: 'file' | 'directory',
    name: string,
  ): Promise<{ success: boolean; path: string }>;
  rename(hostId: string, oldPath: string, newName: string): Promise<{ success: boolean; newPath: string }>;
  delete(hostId: string, pathText: string, type: 'file' | 'directory'): Promise<{ success: boolean }>;
};

export function createRemoteFsClient(getRegistry: () => RemoteAgentsRegistry): RemoteFsClient {
  const reg = () => getRegistry();
  return {
    stat: (h, p) => reg().rpc<RemoteStat>(h, 'fs/stat', { path: p }),
    list(h, p, maxEntries = 200) {
      return reg().rpc(h, 'fs/list', { path: p, maxEntries });
    },
    read(h, p, maxBytes = REMOTE_MAX_READ_BYTES, encoding = 'utf8') {
      return reg().rpc(h, 'fs/read', { path: p, maxBytes, encoding });
    },
    tree(h, p, maxDepth = 10, showHidden = true) {
      return reg().rpc(h, 'fs/tree', { path: p, maxDepth, showHidden });
    },
    write(h, p, content, encoding = 'utf8') {
      return reg().rpc(h, 'fs/write', { path: p, content, encoding }, 120_000);
    },
    create(h, parentPath, type, name) {
      return reg().rpc(h, 'fs/create', { parentPath, type, name });
    },
    rename(h, oldPath, newName) {
      return reg().rpc(h, 'fs/rename', { oldPath, newName });
    },
    delete(h, p, type) {
      return reg().rpc(h, 'fs/delete', { path: p, type });
    },
  };
}
