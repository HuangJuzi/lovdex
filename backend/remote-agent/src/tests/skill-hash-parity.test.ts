import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSkillHash, type SkillFileEntry } from '../../../server/shared/skill-hash.js';

/**
 * Golden fingerprint — freezes the algorithm on the LITE side.
 *
 * The main server and the lite agent must agree bit-for-bit, so this constant
 * is duplicated by `backend/server/shared/tests/skill-hash.test.ts`. If you
 * change the algorithm, BOTH goldens must change together in the same commit;
 * a one-sided change means remote diffs silently report every skill as
 * "changed".
 */
const GOLDEN = '67235fa7090160e8df19fa7052a0f40e01bb127f0b38991880eee38da70b24f4';

const FIXTURE: SkillFileEntry[] = [
  { relativePath: 'SKILL.md', content: 'hello', encoding: 'utf8', executable: false },
  { relativePath: 'scripts/run.sh', content: 'echo hi', encoding: 'utf8', executable: true },
];

test('lite computes the same golden fingerprint as main', () => {
  assert.equal(computeSkillHash(FIXTURE), GOLDEN);
});
