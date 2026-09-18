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
 * The composer's `permissionMode` prop is typed `PermissionMode | string`, so
 * unknown input is an expected path, not an error path. The genuinely unvalidated
 * source is the provider capability matrix: `getPermissionModesForProvider` in
 * `useChatProviderState.ts` casts the backend's `permissionModes: string[]` straight
 * to `PermissionMode[]` (`return capabilityModes as PermissionMode[]`), and
 * `cyclePermissionMode` feeds those values into `setPermissionMode` unchanged.
 *
 * (The localStorage restore path, by contrast, *is* validated — it filters saved
 * modes through `validModes.includes(mode)` before restoring. So this fallback is
 * not dead code; do not delete it on the assumption that localStorage is the only
 * way a stray string can arrive.)
 *
 * Falling back to `default` guarantees the button always renders a readable label;
 * the previous inline `{mode === 'x' && t(…)}` chain rendered nothing at all for
 * unknown values.
 *
 * Note: for an unknown mode the button's colour ternary falls through to the `plan`
 * colour, so such a mode renders as the `default` label on a `plan`-coloured dot.
 * That mismatch is a known, accepted trade-off.
 */
export function getPermissionModeLabelKeys(mode: PermissionMode | string): PermissionModeLabelKeys {
  return LABEL_KEYS[mode as PermissionMode] ?? LABEL_KEYS.default;
}
