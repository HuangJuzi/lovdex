import { PERSISTED_SUB_STATUSES, TASK_LABELS, TASK_PRIORITIES, TASK_STATUSES } from '@/shared/task-status.js';

const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0,
    is_explicit INTEGER DEFAULT 0,
    remote_host_id TEXT
);
`;

export const REMOTE_HOSTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS remote_hosts (
    host_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'lovdex_key',
    key_credential_id INTEGER,
    agent_token_hash TEXT,
    os TEXT,
    status TEXT NOT NULL DEFAULT 'offline',
    last_error TEXT,
    last_seen_at DATETIME,
    -- ssh -R reverse-tunnel local port on the target (NULL = dial back
    -- directly). When set, deploy points the lite at ws://127.0.0.1:<port>
    -- and the main host maintains a per-host ssh -N -R tunnel.
    tunnel_port INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    custom_name TEXT,
    summary TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_operator      INTEGER DEFAULT 0,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

const STATUS_CHECK = `CHECK (status IN (${TASK_STATUSES.map((s) => `'${s}'`).join(',')}))`;
const SUB_STATUS_CHECK = `CHECK (sub_status IS NULL OR sub_status IN (${PERSISTED_SUB_STATUSES.map((s) => `'${s}'`).join(',')}))`;
const PRIORITY_CHECK = `CHECK (priority IN (${TASK_PRIORITIES.map((p) => `'${p}'`).join(',')}))`;
const LABEL_CHECK = `CHECK (label IN (${TASK_LABELS.map((l) => `'${l}'`).join(',')}))`;
// Task executor engines. Kept in sync with TaskEngine in shared/types.ts and
// TASK_ENGINES in tasks.db.ts. The CHECK constraint is rebuilt by a migration
// when a new engine is added so existing DBs accept it.
const EXECUTOR_PROVIDERS = ['claude', 'codex', 'opencode', 'qoder'] as const;
const EXECUTOR_CHECK = `CHECK (executor_provider IN (${EXECUTOR_PROVIDERS.map((p) => `'${p}'`).join(',')}))`;

export const TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo'
                      ${STATUS_CHECK},
    executor_provider TEXT NOT NULL DEFAULT 'claude'
                      ${EXECUTOR_CHECK},
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary       TEXT,
    sub_status       TEXT ${SUB_STATUS_CHECK},
    verdict_reason   TEXT,
    verdict_at       DATETIME,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      ${PRIORITY_CHECK},
    deadline          TEXT,
    is_operator       INTEGER DEFAULT 0,
    label             TEXT NOT NULL DEFAULT 'other'
                      ${LABEL_CHECK},
    remark            TEXT,
    source_schedule_id TEXT
);
`;

export const SCHEDULED_TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    schedule_id       TEXT PRIMARY KEY NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    project_path      TEXT,
    executor_provider TEXT NOT NULL DEFAULT 'claude',
    executor_model    TEXT,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
    is_operator       INTEGER DEFAULT 0,
    auto_run          INTEGER DEFAULT 1,
    schedule_type     TEXT NOT NULL CHECK (schedule_type IN ('once','interval','cron')),
    cron_expr         TEXT,
    interval_seconds  INTEGER,
    run_at            DATETIME,
    timezone          TEXT DEFAULT 'local',
    next_run_at       DATETIME NOT NULL,
    last_run_at       DATETIME,
    last_task_id      TEXT,
    enabled           INTEGER DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(enabled, next_run_at);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const OPERATOR_EXEC_AUDIT_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operator_exec_audit (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    caller         TEXT NOT NULL,
    tool           TEXT NOT NULL CHECK (tool IN ('execute_skill','workbench')),
    action         TEXT NOT NULL,
    target         TEXT,
    decision       TEXT NOT NULL CHECK (decision IN ('allow','deny')),
    reason         TEXT,
    duration_ms    INTEGER,
    exit_code      INTEGER,
    result_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_operator_exec_audit_created ON operator_exec_audit(created_at);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${REMOTE_HOSTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_remote_hosts_status ON remote_hosts(status);

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${TASKS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

${SCHEDULED_TASKS_TABLE_SCHEMA_SQL}

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${OPERATOR_EXEC_AUDIT_TABLE_SCHEMA_SQL}
`;
