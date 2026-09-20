import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAlertSkillService } from '@/modules/notifications/alert-skill.service.js';
import { ALERT_SKILL_DIR, ALERT_SKILL_VERSION } from '@/modules/notifications/alert-skill.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-skill-'));
}

function writeInstalled(root: string, version: string): void {
  const dir = path.join(root, ALERT_SKILL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${ALERT_SKILL_DIR}\ndescription: x\nversion: ${version}\n---\n\nbody\n`, 'utf8');
}

const noopAdd = async () => [];
const noopRemove = async () => ({ removed: true, provider: 'claude', directoryName: '' });

test('未安装：installed=false、无更新', () => {
  const root = tmpRoot();
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: noopAdd, removeSkill: noopRemove });
  const status = svc.getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.installedVersion, null);
  assert.equal(status.hasUpdate, false);
  assert.equal(status.bundledVersion, ALERT_SKILL_VERSION);
});

test('已安装且版本一致：installed=true、hasUpdate=false', () => {
  const root = tmpRoot();
  writeInstalled(root, ALERT_SKILL_VERSION);
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: noopAdd, removeSkill: noopRemove });
  const status = svc.getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.installedVersion, ALERT_SKILL_VERSION);
  assert.equal(status.hasUpdate, false);
});

test('已安装但版本落后：hasUpdate=true', () => {
  const root = tmpRoot();
  writeInstalled(root, '0.0.1');
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: noopAdd, removeSkill: noopRemove });
  const status = svc.getStatus();
  assert.equal(status.hasUpdate, true);
  assert.equal(status.installedVersion, '0.0.1');
});

test('已安装但 frontmatter 缺 version：视为未安装（读不到版本）', () => {
  const root = tmpRoot();
  const dir = path.join(root, ALERT_SKILL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n', 'utf8');
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: noopAdd, removeSkill: noopRemove });
  assert.equal(svc.getStatus().installed, false);
});

test('install 调 addSkill(claude, 正确 entries) 后状态变已安装', async () => {
  const root = tmpRoot();
  const calls: Array<{ provider: string; input: unknown }> = [];
  const svc = createAlertSkillService({
    skillsRoot: root,
    addSkill: async (provider: string, input: unknown) => {
      calls.push({ provider, input });
      writeInstalled(root, ALERT_SKILL_VERSION); // 模拟真实写盘
      return [];
    },
    removeSkill: noopRemove,
  });

  const status = await svc.install();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  const entries = (calls[0].input as { entries: Array<{ directoryName?: string; content?: string }> }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].directoryName, ALERT_SKILL_DIR);
  assert.ok((entries[0].content ?? '').includes('```lovdex-alert'));
  assert.equal(status.installed, true);
});

test('uninstall 调 removeSkill(claude, 正确 directoryName) 后状态变未安装', async () => {
  const root = tmpRoot();
  writeInstalled(root, ALERT_SKILL_VERSION);
  const calls: Array<{ provider: string; input: unknown }> = [];
  const svc = createAlertSkillService({
    skillsRoot: root,
    addSkill: noopAdd,
    removeSkill: async (provider: string, input: unknown) => {
      calls.push({ provider, input });
      fs.rmSync(path.join(root, ALERT_SKILL_DIR), { recursive: true, force: true });
      return { removed: true, provider: 'claude', directoryName: ALERT_SKILL_DIR };
    },
  });

  const status = await svc.uninstall();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.deepEqual(calls[0].input, { directoryName: ALERT_SKILL_DIR });
  assert.equal(status.installed, false);
});
