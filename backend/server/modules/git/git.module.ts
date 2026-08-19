import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import {
  createRemoteAwareFileSystem,
  createRemoteAwareSpawn,
} from '@/modules/remote-agents/remote-adapters.js';
import {
  createRemoteGitClient,
  readLocalGitIdentity,
} from '@/modules/remote-agents/remote-git.service.js';
import { lookupHostForPath } from '@/modules/remote-agents/remote-projects.index.js';
import { getRemoteAgentsRuntime } from '@/modules/remote-agents/runtime.js';

import { createGitRouter } from './git.routes.js';

/**
 * Assembles the Git router with the lovdex DB-backed project path resolver and
 * remote-host-aware spawn/fs adapters.
 *
 * The remote git client is resolved lazily (first request only): git routes are
 * mounted at app init, before `setRemoteAgentsRuntime` fires at boot, so calling
 * `createRemoteGitClient` here would throw. The adapters fetch the live runtime
 * through their own getters, which only run once a route touches a remote path.
 */
export function createGitModule() {
  let gitClient: ReturnType<typeof createRemoteGitClient> | null = null;
  const getRemoteGit = () => {
    if (!gitClient) gitClient = createRemoteGitClient(() => getRemoteAgentsRuntime().registry);
    return gitClient;
  };
  return createGitRouter({
    fileSystem: createRemoteAwareFileSystem({
      localFs: fs,
      getRemoteFs: () => getRemoteAgentsRuntime().fsClient,
      lookupHost: lookupHostForPath,
    }) as never,
    spawnProcess: createRemoteAwareSpawn({
      localSpawn: spawn as never,
      getRemoteGit,
      lookupHost: lookupHostForPath,
      identity: readLocalGitIdentity(),
    }) as never,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  });
}