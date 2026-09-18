import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSettingsTab, SETTINGS_TABS } from './settingsTabs';

test('resolveSettingsTab defaults to providers for missing/unknown values', () => {
  assert.equal(resolveSettingsTab(undefined), 'providers');
  assert.equal(resolveSettingsTab(null), 'providers');
  assert.equal(resolveSettingsTab(''), 'providers');
  assert.equal(resolveSettingsTab('bogus'), 'providers');
});

test('resolveSettingsTab maps known tab keys', () => {
  assert.equal(resolveSettingsTab('providers'), 'providers');
  assert.equal(resolveSettingsTab('operator'), 'operator');
  assert.equal(resolveSettingsTab('remote-hosts'), 'remote-hosts');
  assert.equal(resolveSettingsTab('database'), 'database');
  assert.equal(resolveSettingsTab('account'), 'account');
});

test('resolveSettingsTab rejects the retired models tab', () => {
  // The model slots moved into the Operator tab (settings → Operator Agent 设置);
  // a stale ?tab=models link must fall back rather than render nothing.
  assert.equal(resolveSettingsTab('models'), 'providers');
});

test('SETTINGS_TABS lists the tabs in order', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((t) => t.key),
    ['providers', 'operator', 'remote-hosts', 'database', 'account'],
  );
});

test('every listed tab resolves back to itself (no tab is unreachable via ?tab=)', () => {
  for (const tab of SETTINGS_TABS) {
    assert.equal(resolveSettingsTab(tab.key), tab.key, `${tab.key} is listed but not resolvable`);
  }
});
