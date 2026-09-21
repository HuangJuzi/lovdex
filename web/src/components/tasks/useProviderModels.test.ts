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
    { value: '', label: '默认模型' },
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor keeps a stale model as a labelled extra row', () => {
  assert.deepEqual(modelOptionsFor(MODELS, 'ghost'), [
    { value: '', label: '默认模型' },
    { value: 'ghost', label: 'ghost（不在当前引擎列表）' },
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor always keeps the 默认模型 entry first, even for the empty value', () => {
  assert.deepEqual(modelOptionsFor(MODELS, ''), [
    { value: '', label: '默认模型' },
    { value: 'default', label: '默认' },
    { value: 'opus', label: 'Opus' },
  ]);
});

test('modelOptionsFor falls back to value when a model has an empty label', () => {
  assert.deepEqual(modelOptionsFor([{ value: 'x', label: '' }], 'x'), [
    { value: '', label: '默认模型' },
    { value: 'x', label: 'x' },
  ]);
});

test('modelOptionsFor resolves the empty value to 默认模型 even when models are loaded', () => {
  // 回归：ChipSelect 渲染的是 `current?.label ?? label`，若列表非空时没有值为 '' 的项，
  // 编辑一条 executor_model 为 NULL 的老任务会显示裸的「模型」二字。
  const options = modelOptionsFor(MODELS, '');
  assert.equal(options.find((o) => o.value === '')?.label, '默认模型');
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
