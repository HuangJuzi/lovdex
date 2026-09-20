import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

/**
 * Audit trail for skill syncs.
 *
 * `action` intentionally has NO CHECK constraint: v1 has no delete path, but a
 * future one must not require a table rebuild just to widen the enum. The
 * values in use today are `create` | `update` | `skip` | `conflict`.
 */
export type SkillSyncAuditInput = {
  actor: 'user' | 'operator' | 'system';
  /** `local` | `remote:<hostId>` — see skillNodeLabel(). */
  from_node: string;
  to_node: string;
  scope: 'user' | 'project';
  project_id?: number | null;
  target_project_id?: number | null;
  skill_name: string;
  action: string;
  content_hash?: string | null;
  backup_path?: string | null;
  status: 'ok' | 'failed';
  error?: string | null;
  /** Test seam: override the timestamp instead of relying on CURRENT_TIMESTAMP. */
  created_at?: string;
};

export type SkillSyncAuditRow = {
  id: number;
  created_at: string;
  actor: string;
  from_node: string;
  to_node: string;
  scope: string;
  project_id: number | null;
  target_project_id: number | null;
  skill_name: string;
  action: string;
  content_hash: string | null;
  backup_path: string | null;
  status: string;
  error: string | null;
};

export type SkillSyncAuditRepository = {
  record(input: SkillSyncAuditInput): void;
  list(limit?: number): SkillSyncAuditRow[];
};

export function createSkillSyncAuditDb(db: Database.Database): SkillSyncAuditRepository {
  db.exec(SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL);
  return {
    record(input) {
      db.prepare(
        `INSERT INTO skill_sync_audit
           (actor, from_node, to_node, scope, project_id, target_project_id,
            skill_name, action, content_hash, backup_path, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      ).run(
        input.actor,
        input.from_node,
        input.to_node,
        input.scope,
        input.project_id ?? null,
        input.target_project_id ?? null,
        input.skill_name,
        input.action,
        input.content_hash ?? null,
        input.backup_path ?? null,
        input.status,
        input.error ?? null,
        input.created_at ?? null,
      );
    },
    list(limit = 100) {
      return db
        .prepare('SELECT * FROM skill_sync_audit ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit) as SkillSyncAuditRow[];
    },
  };
}

/**
 * Production singleton.
 *
 * Built lazily through `getConnection()` — instantiating at module scope would
 * run the DDL before `initializeDatabase()` and crash the backend at boot
 * (exactly the trap the `notifications` table fell into). Mirrors
 * `operatorAuditDb`.
 */
export const skillSyncAuditDb: SkillSyncAuditRepository = {
  record: (input) => createSkillSyncAuditDb(getConnection()).record(input),
  list: (limit) => createSkillSyncAuditDb(getConnection()).list(limit),
};
