/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
// Guard `import.meta.env` so this module loads safely outside a Vite context
// (e.g. under plain `node:test` via tsx, where `import.meta.env` is undefined).
// In Vite this is the real env object; outside Vite it falls back to `{}`,
// preserving the OSS defaults (IS_PLATFORM=false, API_BASE_URL='').
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const IS_PLATFORM = ENV.VITE_IS_PLATFORM === 'true';

/**
 * Base URL of the backend API. When non-empty, all `/api/*` requests and the
 * `/ws` WebSocket are opened against this origin (cross-origin deployment).
 * When empty (default), the frontend uses same-origin (relative paths), which
 * matches the dev proxy and the original same-origin monolith deployment.
 *
 * Set via `VITE_API_BASE_URL` at build/dev time, e.g.
 *   VITE_API_BASE_URL=http://localhost:3007
 * Trailing slash is stripped so concatenation with `/api/...` is safe.
 */
export const API_BASE_URL = (ENV.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

/**
 * For empty shell instances where no project is provided,
 * we use a default project object to ensure the shell can still function.
 * This prevents errors related to missing project data.
 *
 * `projectId` is set to a well-known sentinel ('default') because the empty
 * shell doesn't correspond to any real project row in the database; any API
 * call that routes through this placeholder must tolerate a missing match.
 */
export const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: IS_PLATFORM ? '/workspace' : '',
  path: IS_PLATFORM ? '/workspace' : '',
};