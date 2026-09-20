import assert from 'node:assert/strict';
import test from 'node:test';

import { describeSkillStatus, type AlertSkillStatus } from '../inboxSkillStatus.js';

const status = (over: Partial<AlertSkillStatus> = {}): AlertSkillStatus => ({
  installed: false, installedVersion: null, bundledVersion: '1.0.0', hasUpdate: false,
  skillPath: '/home/u/.claude/skills/lovdex-inbox-alert/SKILL.md', ...over,
});

test('未安装：开关关、主按钮为安装', () => {
  const d = describeSkillStatus(status());
  assert.equal(d.switchOn, false);
  assert.equal(d.primaryLabel, '安装');
  assert.equal(d.highlight, false);
  assert.equal(d.versionLine, '内置 v1.0.0');
});

test('已安装且最新：开关开、主按钮为重装', () => {
  const d = describeSkillStatus(status({ installed: true, installedVersion: '1.0.0' }));
  assert.equal(d.switchOn, true);
  assert.equal(d.primaryLabel, '重装');
  assert.equal(d.highlight, false);
  assert.equal(d.versionLine, '已安装 v1.0.0 · 内置 v1.0.0');
});

test('有更新：主按钮为更新到新版本、高亮', () => {
  const d = describeSkillStatus(status({ installed: true, installedVersion: '0.9.0', bundledVersion: '1.0.0', hasUpdate: true }));
  assert.equal(d.switchOn, true);
  assert.equal(d.primaryLabel, '更新到 v1.0.0');
  assert.equal(d.highlight, true);
  assert.equal(d.versionLine, '已安装 v0.9.0 · 内置 v1.0.0');
});
