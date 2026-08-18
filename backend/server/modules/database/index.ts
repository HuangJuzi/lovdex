import { getConnection } from '@/modules/database/connection.js';
import { createRemoteHostsDb, type RemoteHostsRepository } from '@/modules/remote-agents/remote-host.db.js';

export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
export { scheduledTasksDb } from '@/modules/database/repositories/scheduled-tasks.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { tasksDb } from '@/modules/database/repositories/tasks.db.js';
export { userDb } from '@/modules/database/repositories/users.js';

/**
 * Lazily-constructed singleton over the shared connection, mirroring the other
 * `*Db` repository exports. The instance is built on first access so it binds to
 * the same SQLite connection every other repository uses.
 */
let remoteHostsDbInstance: RemoteHostsRepository | null = null;

export const remoteHostsDb = new Proxy({} as RemoteHostsRepository, {
  get(_target, prop: keyof RemoteHostsRepository) {
    if (!remoteHostsDbInstance) {
      remoteHostsDbInstance = createRemoteHostsDb(getConnection());
    }
    return remoteHostsDbInstance[prop];
  },
});
