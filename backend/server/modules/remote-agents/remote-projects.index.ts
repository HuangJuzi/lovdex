/**
 * In-memory index mapping a project's canonical path → the remote host id that
 * backs it. The routing layer (Task 6/13) consults this on every spawn/abort to
 * decide whether a session runs locally or must be forwarded to a lite agent,
 * so the lookup has to be a synchronous, allocation-free map hit rather than a
 * DB join on the hot path.
 *
 * The index is a projection of the `projects` table (project_path,
 * remote_host_id). Task 13 must hook `refreshRemoteProjectsIndex` into the
 * project persist path — i.e. `modules/projects/services/project-management.service.js`
 * (create/delete of projects) plus one refresh at boot — so it can never diverge
 * from the DB for longer than one mutation. Rows whose `remote_host_id` is null
 * are local projects and are simply omitted from the map.
 */

let projectPathToHostId = new Map<string, string>();

/**
 * Rebuild the whole index from the current project rows. Called at boot and
 * after project mutations. A full rebuild (rather than incremental patching)
 * keeps the index a pure projection of the DB with no drift.
 */
export function refreshRemoteProjectsIndex(
  rows: { project_path: string; remote_host_id: string | null }[],
): void {
  const next = new Map<string, string>();
  for (const row of rows) {
    if (row.remote_host_id && row.project_path) {
      next.set(row.project_path, row.remote_host_id);
    }
  }
  // Swap in one shot so a concurrent lookup never sees a half-built map.
  projectPathToHostId = next;
}

/**
 * Resolve the remote host id for a project path, or null when the path is
 * unknown or local. `undefined` input (e.g. a session with no cwd yet) is
 * treated as local.
 */
export function lookupRemoteHost(projectPath: string | undefined): string | null {
  if (!projectPath) return null;
  return projectPathToHostId.get(projectPath) ?? null;
}
