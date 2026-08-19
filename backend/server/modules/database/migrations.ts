import { Database } from 'better-sqlite3';

import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  REMOTE_HOSTS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  TASKS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';
import { canonicalizeProjectPath } from '@/shared/utils.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows that existed before this migration were always keyed directly by the
 * provider-native session id, so backfilling `provider_session_id` with
 * `session_id` keeps every legacy row resolvable through the new mapping.
 */
const addProviderSessionIdMapping = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'provider_session_id', 'TEXT');
  db.exec(`
    UPDATE sessions
    SET provider_session_id = session_id
    WHERE provider_session_id IS NULL
  `);
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

const migrateTasksTable = (db: Database): void => {
  if (!tableExists(db, 'tasks')) {
    console.log('Running migration: creating tasks table');
    db.exec(TASKS_TABLE_SCHEMA_SQL);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
    return;
  }
  const tasksTableInfo = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  const taskColumnNames = tasksTableInfo.map((column) => column.name);
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'started_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'completed_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'ai_summary', 'TEXT');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'verdict_reason', 'TEXT');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'verdict_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'priority', "TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3'))");
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'deadline', 'TEXT');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'is_operator', 'INTEGER DEFAULT 0');
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'label', "TEXT NOT NULL DEFAULT 'other' CHECK (label IN ('bug','feature','optimization','refactor','docs','other'))");
  addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'remark', 'TEXT');

  const tasksTableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (!tasksTableSql.includes('sub_status')) {
    console.log('Running migration: rebuild tasks table for two-layer status');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      // Only needed on pre-verdict legacy tables so the INSERT...SELECT below
      // can read `verdict`; on fresh installs the schema already has sub_status
      // (no verdict) and this rebuild is skipped entirely.
      addColumnToTableIfNotExists(db, 'tasks', taskColumnNames, 'verdict', "TEXT CHECK (verdict IS NULL OR verdict IN ('done','only_plan','needs_review','blocked'))");
      // FK enforcement stays OFF through the rebuild: legacy tasks rows can hold
      // project_path values orphaned from a past projects rebuild (run with FK
      // off, no cascade), so re-validating the INSERT...SELECT against projects
      // would throw SQLITE_CONSTRAINT_FOREIGNKEY and block boot. Rows are copied
      // verbatim, so disabling yields the same data with FK re-enabled after.
      db.exec('ALTER TABLE tasks RENAME TO tasks_legacy;');
      db.exec(TASKS_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at)
        SELECT task_id, project_path, title, description,
               CASE
                 WHEN status = 'backlog' THEN 'todo'
                 WHEN status = 'in_review' AND verdict IN ('only_plan','needs_review','blocked') THEN 'in_progress'
                 ELSE status
               END,
               executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary,
               verdict,
               verdict_reason, verdict_at
        FROM tasks_legacy;
      `);
      db.exec('DROP TABLE tasks_legacy;');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Rebuild tasks table when a new executor engine was added to the
  // executor_provider CHECK constraint (e.g. sophcode). SQLite can't ALTER a
  // CHECK, so rename → recreate from the current schema → copy every column →
  // drop legacy. Re-fetch the table SQL fresh (the sub_status rebuild above may
  // have just changed it) and gate on the new engine name so it's idempotent.
  // The gate also requires that no newer engine list ('opencode') is already in
  // place: TASKS_TABLE_SCHEMA_SQL no longer carries 'sophcode', so on fresh
  // installs / already-upgraded DBs this must stay a no-op.
  const tasksSqlForEngine =
    (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (!tasksSqlForEngine.includes("'sophcode'") && !tasksSqlForEngine.includes("'opencode'")) {
    console.log('Running migration: rebuild tasks table for executor engines (opencode + qoder)');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec('ALTER TABLE tasks RENAME TO tasks_legacy_engine;');
      db.exec(TASKS_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark)
        SELECT task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark
        FROM tasks_legacy_engine;
      `);
      db.exec('DROP TABLE tasks_legacy_engine;');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Scheduled-tasks: link created tasks back to their schedule template.
  // Adds the column unconditionally (fresh DBs already have it via
  // TASKS_TABLE_SCHEMA_SQL; upgraded DBs get it here). Re-fetch column names:
  // a rebuild above may have just recreated `tasks` from TASKS_TABLE_SCHEMA_SQL
  // (which already carries source_schedule_id), so the earlier snapshot would
  // be stale and falsely trigger ALTER TABLE ADD COLUMN. This must run before
  // the opencode rebuild below so every rename→recreate→copy gate down-chain has
  // source_schedule_id available to preserve (the label gate already expects it).
  const currentTaskColumnNames = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((column) => column.name);
  addColumnToTableIfNotExists(db, 'tasks', currentTaskColumnNames, 'source_schedule_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id)');

  // Rename provider id 'sophcode' -> 'opencode' across sessions and tasks, and
  // rebuild the tasks CHECK to accept opencode + qoder executors. sessions has
  // no CHECK on provider, so the rename there is unconditional. The tasks rename
  // can only happen through the rebuild: the legacy CHECK rejects 'opencode', so
  // the rebuild maps sophcode -> opencode inside its INSERT...SELECT instead of
  // pre-renaming rows.
  db.prepare(`UPDATE sessions SET provider='opencode' WHERE provider='sophcode'`).run();
  const tasksSqlForOpenCode =
    (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (!tasksSqlForOpenCode.includes("'opencode'")) {
    console.log('Running migration: rebuild tasks table to accept opencode + qoder executors');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec('ALTER TABLE tasks RENAME TO tasks_legacy_engine;');
      db.exec(TASKS_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id)
        SELECT task_id, project_path, title, description, status,
               CASE WHEN executor_provider = 'sophcode' THEN 'opencode' ELSE executor_provider END,
               executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id
        FROM tasks_legacy_engine
      `);
      db.exec('DROP TABLE tasks_legacy_engine;');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id);`);
      db.exec('COMMIT');
    } catch (rebuildError) {
      db.exec('ROLLBACK');
      throw rebuildError;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  // Re-run AFTER rebuild for the unlikely case CREATE TABLE already produced
  // 'opencode' data (idempotent); safe because the tasks CHECK accepts
  // 'opencode' whenever this statement runs.
  db.prepare(`UPDATE tasks SET executor_provider='opencode' WHERE executor_provider='sophcode'`).run();

  // Rebuild tasks table so the sub_status CHECK accepts the persisted
  // waiting_answer / waiting_plan values (a run that ended at an
  // AskUserQuestion / ExitPlanMode gate now persists "waiting for human" instead
  // of falling back to the "进行中" running badge). Same rename→recreate→copy→
  // drop pattern as the executor rebuild above; gated on 'waiting_answer' so it
  // is idempotent and skipped on fresh installs whose schema already has it.
  // This is legacy-conservative: only DDL from the opencode era that predates
  // the waiting_* sub_statuses triggers it — every newer schema already carries
  // 'waiting_answer', so it stays a no-op there.
  const tasksSqlForWaiting =
    (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (!tasksSqlForWaiting.includes("'waiting_answer'")) {
    console.log('Running migration: rebuild tasks table to accept persisted waiting_* sub_status');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec('ALTER TABLE tasks RENAME TO tasks_legacy_waiting;');
      db.exec(TASKS_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id)
        SELECT task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id
        FROM tasks_legacy_waiting;
      `);
      db.exec('DROP TABLE tasks_legacy_waiting;');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id);`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Rebuild the tasks table to extend the label CHECK constraint with
  // 'reminder' (SQLite can't ALTER a CHECK, so rename → recreate from the
  // current schema → copy every column → drop legacy). Gated on the current
  // DDL lacking 'reminder' so it's idempotent. The index name conflict is
  // why DROP TABLE tasks_legacy_label runs BEFORE the indexes are recreated.
  // Like the waiting_* gate above, this is legacy-conservative: only DDL from
  // the opencode era that predates the 'reminder' label value triggers it.
  const tasksDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
  if (tasksDdl && !tasksDdl.sql.includes("'reminder'")) {
    console.log('Running migration: rebuilding tasks table for label CHECK (reminder)');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec('ALTER TABLE tasks RENAME TO tasks_legacy_label;');
      db.exec(TASKS_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id)
        SELECT task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark, source_schedule_id
        FROM tasks_legacy_label
      `);
      db.exec('DROP TABLE tasks_legacy_label;');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id);`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
};

/**
 * Adds the `is_explicit` flag that distinguishes user-created projects
 * (wizard create-project / clone) from disk-scan auto-discovered ones.
 */
export function migrateProjectsExplicitColumn(db: Database): void {
  const columns = getTableInfo(db, 'projects').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columns, 'is_explicit', 'INTEGER DEFAULT 0');
}

/**
 * Remote-agents support: creates the `remote_hosts` table on fresh/upgraded
 * installs and adds the `projects.remote_host_id` foreign-key column that links
 * a project directory to the host it lives on (NULL for local projects).
 */
export function migrateRemoteHostsTable(db: Database): void {
  db.exec(REMOTE_HOSTS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_remote_hosts_status ON remote_hosts(status)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_hosts_token ON remote_hosts(agent_token_hash)');

  // ssh -R reverse-tunnel support: opt-in per host (upgraded installs).
  const remoteHostsColumns = getTableInfo(db, 'remote_hosts').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'remote_hosts', remoteHostsColumns, 'tunnel_port', 'INTEGER');

  const columns = getTableInfo(db, 'projects').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columns, 'remote_host_id', 'TEXT');
}

/**
 * One-time canonicalization of stored project paths.
 *
 * Walks every `projects` row and re-keys it to its real (symlink-resolved)
 * path. When two rows resolve to the same physical directory (a symlink-path
 * row and a real-path row), the duplicate is merged into the survivor: child
 * `sessions` / `tasks` rows are repointed first (their FKs reference
 * `projects(project_path)`), the surviving project row absorbs the doomed
 * row's flags/name, then the doomed row is deleted.
 */
export function canonicalizeProjectPathsMigration(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');

  const rows = db
    .prepare('SELECT project_id, project_path FROM projects')
    .all() as Array<{ project_id: string; project_path: string }>;

  for (const row of rows) {
    const canonical = canonicalizeProjectPath(row.project_path);
    if (!canonical || canonical === row.project_path) {
      continue;
    }

    const survivor = db
      .prepare('SELECT project_id FROM projects WHERE project_path = ?')
      .get(canonical) as { project_id: string } | undefined;

    if (survivor) {
      const doomed = db
        .prepare(
          'SELECT project_id, custom_project_name, isStarred, isArchived, is_explicit, remote_host_id FROM projects WHERE project_id = ?'
        )
        .get(row.project_id) as {
        project_id: string;
        custom_project_name: string | null;
        isStarred: number;
        isArchived: number;
        is_explicit: number;
        remote_host_id: string | null;
      };
      const keep = db
        .prepare(
          'SELECT project_id, custom_project_name, isStarred, isArchived, is_explicit, remote_host_id FROM projects WHERE project_id = ?'
        )
        .get(survivor.project_id) as typeof doomed;

      db.prepare('UPDATE sessions SET project_path = ? WHERE project_path = ?').run(canonical, row.project_path);
      db.prepare('UPDATE tasks SET project_path = ? WHERE project_path = ?').run(canonical, row.project_path);
      db.prepare(
        'UPDATE projects SET custom_project_name = ?, isStarred = ?, isArchived = ?, is_explicit = ?, remote_host_id = ? WHERE project_id = ?'
      ).run(
        keep.custom_project_name ?? doomed.custom_project_name,
        keep.isStarred || doomed.isStarred,
        keep.isArchived || doomed.isArchived,
        keep.is_explicit || doomed.is_explicit,
        keep.remote_host_id ?? doomed.remote_host_id,
        keep.project_id,
      );
      db.prepare('DELETE FROM projects WHERE project_id = ?').run(doomed.project_id);
      continue;
    }

    // No existing canonical row: rename in place. The FK ON UPDATE CASCADE on
    // sessions/tasks repoints child rows automatically.
    db.prepare('UPDATE projects SET project_path = ? WHERE project_id = ?').run(canonical, row.project_id);
  }
}

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');
    db.exec(NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled)');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    addProviderSessionIdMapping(db);

    const sessionsTableInfoForSummary = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const sessionColumnNamesForSummary = sessionsTableInfoForSummary.map((column) => column.name);
    addColumnToTableIfNotExists(db, 'sessions', sessionColumnNamesForSummary, 'summary', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', sessionColumnNamesForSummary, 'is_operator', 'INTEGER DEFAULT 0');

    ensureProjectsForSessionPaths(db);
    migrateProjectsExplicitColumn(db);
    migrateRemoteHostsTable(db);
    canonicalizeProjectPathsMigration(db);

    migrateTasksTable(db);

    // Scheduled-tasks row rename for the sophcode → opencode provider id.
    // The scheduler dispatches a due row by passing executor_provider straight
    // to createTask, and the tasks CHECK now only accepts opencode/qoder — a
    // legacy 'sophcode' value would hard-fail that insert. No CHECK exists on
    // scheduled_tasks.executor_provider, so the rows are renamed in place.
    // Guarded on table existence because runMigrations itself never creates the
    // table (it lives in the combined schema only); fresh DBs start clean.
    const scheduledTasksExists = tableExists(db, 'scheduled_tasks');
    if (scheduledTasksExists) {
      db.prepare(`UPDATE scheduled_tasks SET executor_provider='opencode' WHERE executor_provider='sophcode'`).run();
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_provider_session_id ON sessions(provider_session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    db.exec(LAST_SCANNED_AT_SQL);
    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};
