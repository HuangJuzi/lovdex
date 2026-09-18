import type { PermissionMode } from '../../types/types';

export interface PermissionModeLabelKeys {
  /** i18n key for the narrow-screen (< sm / 640px) label. */
  shortKey: string;
  /** i18n key for the desktop label — unchanged from the pre-existing rendering. */
  fullKey: string;
}

/**
 * `Record<PermissionMode, …>` is deliberate: adding a mode to the union turns a
 * missing entry into a typecheck error, which is the real guard here.
 */
export const LABEL_KEYS: Record<PermissionMode, PermissionModeLabelKeys> = {
  default: { shortKey: 'codex.modesShort.default', fullKey: 'codex.modes.default' },
  auto: { shortKey: 'codex.modesShort.auto', fullKey: 'codex.modes.auto' },
  acceptEdits: { shortKey: 'codex.modesShort.acceptEdits', fullKey: 'codex.modes.acceptEdits' },
  bypassPermissions: {
    shortKey: 'codex.modesShort.bypassPermissions',
    fullKey: 'codex.modes.bypassPermissions',
  },
  plan: { shortKey: 'codex.modesShort.plan', fullKey: 'codex.modes.plan' },
};

/**
 * The composer's `permissionMode` prop is typed `PermissionMode | string` — it can
 * hold a value restored from localStorage before provider capabilities load — so
 * unknown input is an expected path, not an error path. Falling back to `default`
 * guarantees the button always renders a readable label; the previous inline
 * `{mode === 'x' && t(…)}` chain rendered nothing at all for unknown values.
 */
export function getPermissionModeLabelKeys(mode: PermissionMode | string): PermissionModeLabelKeys {
  return LABEL_KEYS[mode as PermissionMode] ?? LABEL_KEYS.default;
}
