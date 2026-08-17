import path from 'path';
import { fileURLToPath } from 'url';

import { appConfig } from '../modules/config/config.js';

export function getModuleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function findServerRoot(startDir) {
  // Source files live under /server, while compiled files live under /dist-server/server.
  // Walking up to the nearest "server" folder gives every backend module one stable anchor
  // that works in both layouts instead of relying on fragile "../.." assumptions.
  let currentDir = startDir;

  while (path.basename(currentDir) !== 'server') {
    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(`Could not resolve the backend server root from "${startDir}".`);
    }

    currentDir = parentDir;
  }

  return currentDir;
}

export function findAppRoot(startDir) {
  const serverRoot = findServerRoot(startDir);
  const parentOfServerRoot = path.dirname(serverRoot);

  // Source files live at <app>/server, while compiled files live at <app>/dist-server/server.
  // When the nearest server folder sits inside dist-server we need to hop one extra level up
  // so repo-level files still resolve from the real app root instead of the build directory.
  return path.basename(parentOfServerRoot) === 'dist-server'
    ? path.dirname(parentOfServerRoot)
    : parentOfServerRoot;
}

export function getAppRoot() {
  return findAppRoot(getModuleDir(import.meta.url));
}

export function getMainAgentWorkspace() {
  const mainWs = appConfig().get().workspaces.mainWorkspace;
  return mainWs ? path.resolve(mainWs) : path.dirname(getAppRoot());
}
