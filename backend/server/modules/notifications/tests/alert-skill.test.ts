import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALERT_SKILL_DIR,
  ALERT_SKILL_VERSION,
  buildAlertSkillMarkdown,
} from '@/modules/notifications/alert-skill.js';
import { ALERT_PROMPT_INSTRUCTION } from '@/modules/notifications/alert-format.js';

test('markdown 有合法 frontmatter，含 name / description / version', () => {
  const md = buildAlertSkillMarkdown();
  const lines = md.split('\n');
  assert.equal(lines[0], '---');
  assert.ok(lines.includes(`name: ${ALERT_SKILL_DIR}`));
  assert.ok(lines.includes(`version: ${ALERT_SKILL_VERSION}`));
  assert.ok(lines.some((l) => l.startsWith('description: ')));
  assert.equal(lines.indexOf('---', 1) > 0, true);
});

test('description 含全部触发词（模型靠它决定是否调用）', () => {
  const md = buildAlertSkillMarkdown();
  const desc = md.split('\n').find((l) => l.startsWith('description: ')) ?? '';
  for (const word of ['放到收件箱', '发到收件箱', '通知我', '告警']) {
    assert.ok(desc.includes(word), `description 缺少触发词：${word}`);
  }
});

test('正文完整包含 ALERT_PROMPT_INSTRUCTION（防两处漂移）', () => {
  const md = buildAlertSkillMarkdown();
  for (const line of ALERT_PROMPT_INSTRUCTION.split('\n')) {
    if (!line.trim()) continue;
    assert.ok(md.includes(line), `skill 正文缺少约定行：${line}`);
  }
});

test('正文含 lovdex-alert 代码块围栏与合并规则说明', () => {
  const md = buildAlertSkillMarkdown();
  assert.ok(md.includes('```lovdex-alert'));
  assert.ok(md.includes('合并'));
});
