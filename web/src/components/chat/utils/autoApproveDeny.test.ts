import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AUTO_APPROVE_INTERACTION_TOOLS,
  classifyAutoApproveNotice,
  resolveToolResultVariant,
} from './autoApproveDeny';

test('both interaction tools are covered', () => {
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('AskUserQuestion'), true);
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('ExitPlanMode'), true);
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('Bash'), false);
});

test('a denied interaction tool classifies as interaction', () => {
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'deny'), 'interaction');
  assert.equal(classifyAutoApproveNotice('ExitPlanMode', 'deny'), 'interaction');
});

test('a denied ordinary tool classifies as blocked', () => {
  assert.equal(classifyAutoApproveNotice('Bash', 'deny'), 'blocked');
});

test('an allow has no classification', () => {
  assert.equal(classifyAutoApproveNotice('Bash', 'allow'), undefined);
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'allow'), undefined);
});

test('a missing tool name still classifies as blocked, never interaction', () => {
  assert.equal(classifyAutoApproveNotice(undefined, 'deny'), 'blocked');
});

test('the deny-kind literals are the exact wire values', () => {
  // 这条测试**冻结的是前端侧的字面量**：防止前端重构时把 `'blocked'` 写成别的。
  // 它**防不住跨进程漂移** —— 后端改 `AutoApproveDenyKind`（或加交互型工具名）时
  // 这条测试不会红，因为 web 与 backend 是两个独立的包，没有共享类型通道
  // （web 里没有 backend 的 tsconfig paths）。别把它当成跨进程契约的保证。
  //
  // 后端对应定义：backend/server/shared/types.ts 的 AutoApproveDenyKind。
  assert.deepEqual([...AUTO_APPROVE_INTERACTION_TOOLS].sort(), ['AskUserQuestion', 'ExitPlanMode']);
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'deny'), 'interaction');
  assert.equal(classifyAutoApproveNotice('Bash', 'deny'), 'blocked');
});

// --- 三分支判定（渲染接线的判据；渲染本身在 MessageComponent.test.tsx）---

test('a tagged result wins over isError, and keeps its kind', () => {
  // 核心语义：带标记的结果不是错误，即使 isError 为真。
  // 返回的是 kind 本身（而非笼统的 'auto-denied'），调用处收窄后直接拿去选渲染。
  assert.equal(
    resolveToolResultVariant({ isError: true, autoApproveDeny: 'interaction' }),
    'interaction',
  );
  assert.equal(
    resolveToolResultVariant({ isError: true, autoApproveDeny: 'blocked' }),
    'blocked',
  );
});

test('an untagged error stays an error', () => {
  assert.equal(resolveToolResultVariant({ isError: true }), 'error');
});

test('a plain result is a result', () => {
  assert.equal(resolveToolResultVariant({}), 'result');
  assert.equal(resolveToolResultVariant(null), 'result');
  assert.equal(resolveToolResultVariant(undefined), 'result');
});

// --- 跨包对账：后端交互型工具名单 ---

/**
 * 后端策略模块的路径。web 与 backend 是两个独立的包（web 的 tsconfig 不覆盖
 * backend），所以这里读**源码**对账，而不是 import —— 跨包 import 会把两个包的
 * 构建绑死。仓库有先例：`permissionModeLabels.i18n.test.ts` 也是读源码/bundle
 * 断言结构。
 *
 * 相对层级：本文件在 `web/src/components/chat/utils/`，往上 5 层到仓库根。
 */
const POLICY_PATH = fileURLToPath(
  new URL(
    '../../../../../backend/server/modules/permissions/auto-approve-policy.ts',
    import.meta.url,
  ),
);

function readPolicySource(): string {
  try {
    return readFileSync(POLICY_PATH, 'utf8');
  } catch (err) {
    // 刻意**不**静默跳过：跳过会让这条对账测试变成新的空转（看起来在测，其实
    // 什么都没测）。这条测试**耦合**到后端源码路径，后端挪文件时必须一起改。
    throw new Error(
      `cannot read the backend policy module at ${POLICY_PATH}: ${String(err)}\n` +
        'This test reconciles two hand-copied interaction-tool lists ' +
        '(web AUTO_APPROVE_INTERACTION_TOOLS vs backend TOOLS_REQUIRING_INTERACTION), ' +
        'so it is deliberately coupled to the backend source path. ' +
        'If the backend module moved, update POLICY_PATH in this file.',
    );
  }
}

test('the interaction tool list matches the backend policy module', () => {
  // 两份手抄副本只靠注释互指。漂移的后果不是理论上的：后端加了第三个交互型工具
  // 而前端没同步 → `classifyAutoApproveNotice` 把它判成 `blocked` → 拒绝理由原文
  // （后半句是写给模型的协议指令「请基于现有信息自行判断并继续…」）被原样渲染进 UI。
  const source = readPolicySource();

  const match = /export const TOOLS_REQUIRING_INTERACTION[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
    source,
  );
  assert.ok(
    match,
    `could not find the TOOLS_REQUIRING_INTERACTION Set literal in ${POLICY_PATH} — ` +
      'if the backend reshaped it, update the regex in this test.',
  );

  const backendTools = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // 肯定式断言：正则真的抽到了名字。空对空会让下面的 deepEqual 失去意义。
  assert.ok(backendTools.length > 0, 'the regex must actually extract tool names');

  assert.deepEqual(
    [...AUTO_APPROVE_INTERACTION_TOOLS].sort(),
    [...backendTools].sort(),
    'the frontend and backend interaction-tool lists have drifted apart',
  );
});
