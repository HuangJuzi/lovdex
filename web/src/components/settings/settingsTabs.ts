export type SettingsTab =
  | 'providers'
  | 'operator'
  | 'skills'
  | 'remote-hosts'
  | 'database'
  | 'account';

export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'providers', label: 'Provider 设置' },
  { key: 'operator', label: 'Operator Agent 设置' },
  { key: 'skills', label: '技能' },
  { key: 'remote-hosts', label: '远程机器' },
  { key: 'database', label: '数据库' },
  { key: 'account', label: '账号' },
];

// Derived from SETTINGS_TABS rather than hand-listed: a second literal is a
// place a new tab gets forgotten, and the failure is silent — `?tab=<new>`
// would just fall back to providers and render the wrong form.
const VALID_TABS: ReadonlySet<string> = new Set(SETTINGS_TABS.map((tab) => tab.key));

/** Map a `?tab=` value to a valid tab key, defaulting to `providers` for missing/unknown. */
export function resolveSettingsTab(raw: string | null | undefined): SettingsTab {
  return raw && VALID_TABS.has(raw) ? (raw as SettingsTab) : 'providers';
}
