/**
 * Runtime config — sourced from GET /api/config at startup instead of build
 * time env vars (VITE_IS_PLATFORM / VITE_API_BASE_URL are gone).
 */
export const API_BASE_URL = '';

type RuntimeConfig = {
  isPlatform: boolean;
};

let runtimeConfig: RuntimeConfig = { isPlatform: false };

export const IS_PLATFORM = () => runtimeConfig.isPlatform;

/** Fetches server config once; safe when called outside a fetch context. */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/config`);
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    const cfg = (await res.json()) as { server?: { isPlatform?: boolean } };
    runtimeConfig = { isPlatform: cfg.server?.isPlatform === true };
  } catch {
    runtimeConfig = { isPlatform: false };
  }
  return runtimeConfig;
}

export const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: '',
  path: '',
};
