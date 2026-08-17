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
  assert.equal(resolveSettingsTab('database'), 'database');
  assert.equal(resolveSettingsTab('account'), 'account');
});

test('SETTINGS_TABS lists the four tabs in order', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((t) => t.key),
    ['providers', 'operator', 'database', 'account'],
  );
});
