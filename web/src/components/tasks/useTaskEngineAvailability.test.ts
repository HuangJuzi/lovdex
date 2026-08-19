import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeEngineAvailability,
  installedEngineOptions,
  type EngineAvailability,
} from './useTaskEngineAvailability';

test('installedEngineOptions keeps installed providers in canonical order', () => {
  assert.deepEqual(
    installedEngineOptions([
      { provider: 'codex', installed: true },
      { provider: 'claude', installed: true },
      { provider: 'qoder', installed: false },
    ]),
    ['claude', 'codex'],
  );
});

test('assistant target always resolves to assistant status', () => {
  assert.deepEqual(computeEngineAvailability({ isAssistant: true, targetHostId: null, records: [] }), {
    status: 'assistant',
  });
});

test('remote with installed engines resolves ready(source remote)', () => {
  const state = computeEngineAvailability({
    isAssistant: false,
    targetHostId: 'h1',
    records: [{ provider: 'claude', installed: true }, { provider: 'opencode', installed: true }],
  });
  assert.deepEqual(state, { status: 'ready', options: ['claude', 'opencode'], source: 'remote' });
});

test('remote with no installed engines resolves unavailable (disable + hint)', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: 'h1', records: [] });
  assert.equal(state.status, 'unavailable');
});

test('remote probe failure resolves unavailable, never degrades to local engines', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: 'h1', records: null });
  assert.equal(state.status, 'unavailable');
});

test('local with installed engines resolves ready(source local)', () => {
  const state = computeEngineAvailability({
    isAssistant: false,
    targetHostId: null,
    records: [{ provider: 'claude', installed: true }],
  });
  assert.deepEqual(state, { status: 'ready', options: ['claude'], source: 'local' });
});

test('local with an empty probe degrades to all four with a hint', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: null, records: [] }) as Extract<EngineAvailability, { status: 'ready' }>;
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.options, ['claude', 'codex', 'opencode', 'qoder']);
  assert.ok(state.hint);
});

test('local probe failure degrades to all four with a hint', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: null, records: null }) as Extract<EngineAvailability, { status: 'ready' }>;
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.options, ['claude', 'codex', 'opencode', 'qoder']);
  assert.ok(state.hint);
});
