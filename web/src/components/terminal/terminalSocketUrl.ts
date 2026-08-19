import { buildWebSocketUrl } from '../../utils/wsUrl';

/** Build the /ws/terminal socket URL with the drawer's start-cwd and, for
 *  remote projects, the remote hostId the backend should route the shell to. */
export function buildTerminalSocketUrl(
  token: string | null,
  cwd: string | null,
  hostId: string | null,
): string {
  let url = buildWebSocketUrl(token, '/ws/terminal');
  if (cwd) url += `${url.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwd)}`;
  if (hostId) url += `${url.includes('?') ? '&' : '?'}hostId=${encodeURIComponent(hostId)}`;
  return url;
}
