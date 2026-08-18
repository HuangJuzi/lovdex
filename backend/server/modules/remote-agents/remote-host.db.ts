import type Database from 'better-sqlite3';

import { REMOTE_HOSTS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import type { RemoteHostRow } from '@/shared/types.js';

export type RemoteHostsRepository = {
  create(input: { host_id: string; name: string; host: string; ssh_user: string; port?: number }): string;
  getById(hostId: string): RemoteHostRow | null;
  list(): RemoteHostRow[];
  updateStatus(hostId: string, status: RemoteHostRow['status'], lastError?: string | null): void;
  touchSeen(hostId: string): void;
  setTokenHash(hostId: string, hash: string): void;
  getByTokenHash(hash: string): RemoteHostRow | null;
  remove(hostId: string): void;
  findHostForProjectPath(projectPath: string): RemoteHostRow | null;
};

export function createRemoteHostsDb(db: Database.Database): RemoteHostsRepository {
  db.exec(REMOTE_HOSTS_TABLE_SCHEMA_SQL);
  const get = db.prepare('SELECT * FROM remote_hosts WHERE host_id = ?');
  return {
    create({ host_id, name, host, ssh_user, port = 22 }) {
      db.prepare(
        'INSERT INTO remote_hosts (host_id, name, host, port, ssh_user, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(host_id, name, host, port, ssh_user, 'offline');
      return host_id;
    },
    getById(hostId) {
      const row = get.get(hostId) as RemoteHostRow | undefined;
      return row ?? null;
    },
    list() {
      return db.prepare('SELECT * FROM remote_hosts ORDER BY created_at DESC').all() as RemoteHostRow[];
    },
    updateStatus(hostId, status, lastError = null) {
      db.prepare(
        'UPDATE remote_hosts SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE host_id = ?',
      ).run(status, lastError, hostId);
    },
    touchSeen(hostId) {
      db.prepare('UPDATE remote_hosts SET last_seen_at = CURRENT_TIMESTAMP WHERE host_id = ?').run(hostId);
    },
    setTokenHash(hostId, hash) {
      db.prepare('UPDATE remote_hosts SET agent_token_hash = ? WHERE host_id = ?').run(hash, hostId);
    },
    getByTokenHash(hash) {
      const row = db.prepare('SELECT * FROM remote_hosts WHERE agent_token_hash = ?').get(hash) as
        | RemoteHostRow
        | undefined;
      return row ?? null;
    },
    remove(hostId) {
      db.prepare('DELETE FROM remote_hosts WHERE host_id = ?').run(hostId);
    },
    findHostForProjectPath(projectPath) {
      const row = db
        .prepare(
          'SELECT h.* FROM remote_hosts h JOIN projects p ON p.remote_host_id = h.host_id WHERE p.project_path = ?',
        )
        .get(projectPath) as RemoteHostRow | undefined;
      return row ?? null;
    },
  };
}
