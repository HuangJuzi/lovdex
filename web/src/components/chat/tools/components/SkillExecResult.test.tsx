import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SkillExecResult } from './SkillExecResult';
import { getToolConfig } from '../configs/toolConfigs';

test('execute_skill success result renders badges + title', () => {
  const content = JSON.stringify({
    ok: true,
    skill: 'claw-agent-get-send',
    subcommand: 'groups',
    exitCode: 0,
    durationMs: 420,
    stdout: 'rid=r1 name=研发群',
    stderr: '',
  });
  const html = renderToStaticMarkup(React.createElement(SkillExecResult, { content }));
  assert.ok(html.includes('claw-agent-get-send:groups'));
  assert.ok(html.includes('成功'));
  assert.ok(html.includes('exit 0'));
  assert.ok(html.includes('420ms'));
});

test('denied result is highlighted with reason + hint', () => {
  const content = JSON.stringify({
    ok: false,
    error: 'copy destination outside allowed write prefixes: /other',
    hint: '跨出 Operator Home 的写操作请改用 create_task 下发任务到对应项目执行。',
  });
  const html = renderToStaticMarkup(React.createElement(SkillExecResult, { content }));
  assert.ok(html.includes('已拒绝'));
  assert.ok(html.includes('outside allowed write prefixes'));
  assert.ok(html.includes('create_task'));
});

test('workbench list result renders entries table', () => {
  const content = JSON.stringify({
    ok: true,
    command: 'list',
    path: '/home/u/.lovdex/operator-workspace',
    entries: [
      { name: 'a.txt', type: 'file', size: 12 },
      { name: 'inbox', type: 'dir', size: null },
    ],
    durationMs: 3,
  });
  const html = renderToStaticMarkup(React.createElement(SkillExecResult, { content }));
  assert.ok(html.includes('a.txt'));
  assert.ok(html.includes('inbox'));
});

test('non-JSON content falls back to plain pre block', () => {
  const html = renderToStaticMarkup(
    React.createElement(SkillExecResult, { content: 'plain output' }),
  );
  assert.ok(html.includes('plain output'));
});

test('tool configs registered for the operator MCP tool names', () => {
  const skillCfg = getToolConfig('mcp__lovdex-operator__execute_skill');
  assert.equal(skillCfg.result?.contentType, 'skill-exec');
  const benchCfg = getToolConfig('mcp__lovdex-operator__workbench');
  assert.equal(benchCfg.result?.contentType, 'skill-exec');
  assert.equal(benchCfg.input.getValue?.({ command: 'copy', src: '/a', dst: '/b' }), 'copy /a → /b');
});
