import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';

import { createGitRouter } from './git.routes.js';

/** Assembles the Git router with the lovdex DB-backed project path resolver. */
export function createGitModule() {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  });
}
