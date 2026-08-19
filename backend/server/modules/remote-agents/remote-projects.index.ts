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
 * Live online-host snapshot provider, injected at boot by index.js. Returns the
 * registry's current live connections (`{ hostId, roots }[]`) or null when the
 * routing layer has not been wired yet. Used as the fallback for paths that are
 * NOT project rows (worktrees, ad-hoc dirs) — see {@link lookupHostForPath}.
 */
let hostsLookup: (() => { hostId: string; roots: string[] }[] | null) | null = null;

/** Inject the online-hosts snapshot thunk (index.js wires it after registry construction). */
export function setOnlineHostsLookup(fn: () => { hostId: string; roots: string[] }[] | null): void {
  hostsLookup = fn;
}

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

/**
 * Resolve which remote host (if any) backs an absolute path. Exact
 * project-path map hits win; otherwise the longest roots-prefix match across
 * the live online hosts wins (covers worktrees and other paths outside the
 * projects table). No match → null (local).
 */
export function lookupHostForPath(absPath: string | undefined): string | null {
  if (!absPath) return null;
  const exact = projectPathToHostId.get(absPath);
  if (exact) return exact;
  if (!hostsLookup) return null;
  const hosts = hostsLookup();
  if (!hosts) return null;
  let bestHost: string | null = null;
  let bestLen = 0;
  for (const h of hosts) {
    for (const root of h.roots) {
      if (absPath === root || absPath.startsWith(root + '/')) {
        if (root.length > bestLen) {
          bestHost = h.hostId;
          bestLen = root.length;
        }
      }
    }
  }
  return bestHost;
}
