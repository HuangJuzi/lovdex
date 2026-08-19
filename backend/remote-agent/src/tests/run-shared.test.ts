import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRunEnv, makeCompleteMarker } from '../providers/run-shared.js';

test('makeCompleteMarker: clean success carries top-level exitCode 0, no error key', () => {
  assert.deepEqual(makeCompleteMarker(true), { type: 'complete', exitCode: 0 });
  assert.deepEqual(makeCompleteMarker(true, undefined), { type: 'complete', exitCode: 0 });
});

test('makeCompleteMarker: failure carries top-level exitCode 1 + error message', () => {
  assert.deepEqual(makeCompleteMarker(false, 'boom'), { type: 'complete', exitCode: 1, error: 'boom' });
  assert.deepEqual(makeCompleteMarker(false, new Error('kaboom')), { type: 'complete', exitCode: 1, error: 'kaboom' });
});

test('makeCompleteMarker: interrupted runs are reported as done (abort is not failure)', () => {
  // Interrupts pass done: true so main's finish() treats them as terminal (not
  // failed) — the same semantic as the claude abort marker (no exitCode ⇒ 0).
  assert.deepEqual(makeCompleteMarker(true), { type: 'complete', exitCode: 0 });
});

test('buildRunEnv merges process.env with permission-env and configEnv (never bare)', () => {
  const prevFoo = process.env.T12_UNIT_FOO;
  process.env.T12_UNIT_FOO = 'base';
  try {
    const env = buildRunEnv(
      { T12_UNIT_OPENCODE: 'oc' },
      { T12_UNIT_CONFIG: 'cfg', T12_UNIT_FOO: 'override' },
    );
    assert.equal(env.T12_UNIT_FOO, 'override'); // configEnv wins over process.env
    assert.equal(env.T12_UNIT_OPENCODE, 'oc'); // permission/base env lands
    assert.equal(env.T12_UNIT_CONFIG, 'cfg'); // configEnv lands
    assert.equal(env.PATH, process.env.PATH); // bare-strip would drop PATH
  } finally {
    if (prevFoo === undefined) delete process.env.T12_UNIT_FOO;
    else process.env.T12_UNIT_FOO = prevFoo;
  }
});