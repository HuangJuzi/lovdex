import assert from 'node:assert/strict';
import test from 'node:test';

import { modelOptionsFor, nextModelOnLoad } from './useProviderModels';

const MODELS = [
  { value: 'default', label: '默认' },
  { value: 'opus', label: 'Opus' },
];

// ---- modelOptionsFor ----

test('modelOptionsFor falls back to a single 默认模型 entry when the list is empty', () => {
  assert.deepEqual(modelOptionsFor([], ''), [{ value: '', label: '默认模型' }]);
  // 列表为空时即便当前值非空也走兜底：没有可点的项，标一个「不在列表」没有意义。
  assert.deepEqual(modelOptionsFor([], 'opus'), [{ value: '', label: '默认模型' }]);
});

test('modelOptionsFor maps value/label when the current value is in the list', () => {
  assert.deepEqual(modelOptionsFor(MODELS, 'opus'), [
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor keeps a stale model as a labelled extra row', () => {
  assert.deepEqual(modelOptionsFor(MODELS, 'ghost'), [
    { value: 'ghost', label: 'ghost（不在当前引擎列表）' },
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor does not add an extra row for the empty (default) value', () => {
  assert.deepEqual(modelOptionsFor(MODELS, ''), [
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor falls back to value when a model has an empty label', () => {
  assert.deepEqual(modelOptionsFor([{ value: 'x', label: '' }], 'x'), [{ value: 'x', label: 'x' }]);
});

// ---- nextModelOnLoad ----

test('nextModelOnLoad picks the first model when creating', () => {
  assert.equal(nextModelOnLoad({ mode: 'create', engineSwitched: false, models: MODELS, current: '' }), 'default');
});

test('nextModelOnLoad falls back to the empty value when creating with no models', () => {
  assert.equal(nextModelOnLoad({ mode: 'create', engineSwitched: false, models: [], current: '' }), '');
});

test('nextModelOnLoad keeps the stored value when editing without an engine switch', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: false, models: MODELS, current: 'opus' }), 'opus');
});

test('nextModelOnLoad keeps NULL (empty) when editing without an engine switch', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: false, models: MODELS, current: '' }), '');
});

test('nextModelOnLoad resets to the first model when editing after an engine switch', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: true, models: MODELS, current: 'opus' }), 'default');
});

test('nextModelOnLoad resets to the empty value when editing after a switch to an engine with no models', () => {
  assert.equal(nextModelOnLoad({ mode: 'edit', engineSwitched: true, models: [], current: 'opus' }), '');
});
