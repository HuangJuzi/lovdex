import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  REMOTE_USER_SKILL_ROOT,
  parseSkillNode,
  skillNodeLabel,
  userSkillRoot,
} from '../skill-node.js';

test('skillNodeLabel / parseSkillNode round-trip', () => {
  assert.equal(skillNodeLabel({ kind: 'local' }), 'local');
  assert.equal(skillNodeLabel({ kind: 'remote', hostId: 'h1' }), 'remote:h1');
  assert.deepEqual(parseSkillNode('local'), { kind: 'local' });
  assert.deepEqual(parseSkillNode('remote:h1'), { kind: 'remote', hostId: 'h1' });
});

test('parseSkillNode rejects malformed labels', () => {
  for (const bad of ['', 'remote:', 'remote', 'REMOTE:h1', 'local:h1']) {
    assert.throws(() => parseSkillNode(bad), /invalid skill node/);
  }
});

test('userSkillRoot is the local claude skills dir for local and a tilde path for remote', () => {
  assert.equal(
    userSkillRoot({ kind: 'local' }),
    path.join(os.homedir(), '.claude', 'skills'),
  );
  // 远程节点必须发字面量 `~`：main 不知道远程主机的 home，
  // lite 侧 expandHome() 会把它展开成自己的 home。
  assert.equal(userSkillRoot({ kind: 'remote', hostId: 'h1' }), REMOTE_USER_SKILL_ROOT);
  assert.equal(REMOTE_USER_SKILL_ROOT, '~/.claude/skills');
});
