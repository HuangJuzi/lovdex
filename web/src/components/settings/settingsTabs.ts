export type SettingsTab = 'providers' | 'operator' | 'remote-hosts' | 'database' | 'account';

export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'providers', label: 'Provider 设置' },
  { key: 'operator', label: 'Operator Agent 设置' },
  { key: 'remote-hosts', label: '远程机器' },
  { key: 'database', label: '数据库' },
  { key: 'account', label: '账号' },
];

const VALID_TABS = new Set<SettingsTab>([
  'providers',
  'operator',
  'remote-hosts',
  'database',
  'account',
]);

/** Map a `?tab=` value to a valid tab key, defaulting to `providers` for missing/unknown. */
export function resolveSettingsTab(raw: string | null | undefined): SettingsTab {
  return raw && VALID_TABS.has(raw as SettingsTab) ? (raw as SettingsTab) : 'providers';
}
