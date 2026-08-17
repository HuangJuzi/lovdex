import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { readOptionalString } from '@/shared/utils.js';

const PROVIDER = 'opencode';

type OpenCodeSessionRow = {
  id: string;
  title?: string;
  directory?: string;
  path?: string;
  time_created?: number;
  time_updated?: number;
};

export class OpenCodeSessionSynchronizer implements IProviderSessionSynchronizer {
  private openDb(): Database.Database {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  async synchronize(_since?: Date): Promise<number> {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (!fsSync.existsSync(dbPath)) {
      return 0;
    }

    let db: Database.Database;
    try {
      db = this.openDb();
    } catch {
      return 0;
    }

    try {
      const rows = db.prepare(
        `SELECT id, title, directory, path, time_created, time_updated FROM session WHERE time_archived IS NULL`,
      ).all() as OpenCodeSessionRow[];

      for (const row of rows) {
        // opencode v0.3.0 stores the real working directory in `directory`;
        // `path` is the git-relative subpath within the project (empty at the
        // repo root). Older v1 rows kept the absolute path in `path`, so it
        // remains the fallback. Preferring `directory` stops the synchronizer
        // from wiping project_path to '' for repo-root sessions.
        const projectPath = readOptionalString(row.directory) || readOptionalString(row.path) || '';
        const createdAt = typeof row.time_created === 'number'
          ? new Date(row.time_created).toISOString()
          : undefined;
        const updatedAt = typeof row.time_updated === 'number'
          ? new Date(row.time_updated).toISOString()
          : undefined;
        sessionsDb.createSession(
          String(row.id),
          PROVIDER,
          projectPath,
          readOptionalString(row.title) || undefined,
          createdAt,
          updatedAt,
          null,
        );
      }

      return rows.length;
    } finally {
      db.close();
    }
  }

  async synchronizeFile(_filePath: string): Promise<string | null> {
    // opencode.db is a single shared SQLite file; there is no per-file artifact
    // to incrementally map, so a watcher event degrades to a no-op here.
    return null;
  }
}
