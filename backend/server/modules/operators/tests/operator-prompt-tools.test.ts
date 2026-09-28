import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildOperatorTools } from '@/modules/operators/operator.tools.js';

/**
 * Operator 的能力枚举是**手写**在 claude-sdk.js 的 systemPrompt 里的（刻意不
 * import buildOperatorTools —— 那会把整条数据库依赖链拉进 claude-sdk 的模块图，
 * 而 index.js 的导入顺序很敏感）。代价是新增工具容易漏提名，且漏了**不报错**：
 * 工具其实注册了，只是模型不知道它能用，表现成「助手说自己不能做某件事」。
 *
 * `list_sessions` / `delete_session` / `delete_task` 就漏过一轮 —— 而它们正是
 * 「定时任务跑助手清理会话」这个诉求的落地路径。本测试把这份手工清单和真实的
 * 工具 key 集合钉在一起，漏一个就红。
 *
 * 断言的是**工具名这个符号**，不是 systemPrompt 的完整文本：文案措辞随便改，
 * 但「这个工具在不在提示里」是硬约束。
 */
// 读源码文本而不是 import：claude-sdk.js 的模块图会拉起整条数据库依赖链，而这里
// 只需要那个字面量数组。也不能写 '@/claude-sdk.js' —— `new URL` 不解析 tsconfig
// 的 `@/` 别名，必须给真实的相对路径。
const CLAUDE_SDK_SOURCE = readFileSync(new URL('../../../claude-sdk.js', import.meta.url), 'utf8');

/** 从 `const OPERATOR_TOOL_NAMES = [ 'a', 'b', ... ].join('/');` 里抽出全部字面量。 */
function operatorToolNamesFromPrompt(): string[] {
  const block = /const OPERATOR_TOOL_NAMES = \[([\s\S]*?)\]\.join\('\/'\);/.exec(CLAUDE_SDK_SOURCE);
  assert.ok(block, 'claude-sdk.js must declare OPERATOR_TOOL_NAMES as a literal array joined by "/"');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test('the operator prompt names every tool that buildOperatorTools registers', () => {
  const registered = Object.keys(buildOperatorTools({} as never)).sort();
  const nominated = operatorToolNamesFromPrompt();

  const missing = registered.filter((name) => !nominated.includes(name));
  assert.deepEqual(
    missing,
    [],
    `these tools are registered but never named in the operator system prompt, so the model will not know it can call them: ${missing.join(', ')}`,
  );
});

test('the operator prompt names no tool that no longer exists', () => {
  const registered = new Set(Object.keys(buildOperatorTools({} as never)));
  const stale = operatorToolNamesFromPrompt().filter((name) => !registered.has(name));
  assert.deepEqual(stale, [], `these names are in the prompt but are not registered tools: ${stale.join(', ')}`);
});

test('the system prompt actually interpolates the tool list and the cleanup paragraph', () => {
  // 光有名册数组还不够：拼接漏了的话，名册就是死代码。
  assert.ok(
    /OPERATOR_TOOL_NAMES/.test(CLAUDE_SDK_SOURCE.replace(/const OPERATOR_TOOL_NAMES = [\s\S]*?\.join\('\/'\);/, '')),
    'the tool list must be interpolated into a prompt string, not just declared',
  );
  assert.ok(
    CLAUDE_SDK_SOURCE.includes("' + OPERATOR_SESSION_CLEANUP_PROMPT + '"),
    'the session-cleanup paragraph must be interpolated into the prompt',
  );
  assert.ok(CLAUDE_SDK_SOURCE.includes('lastActiveBefore'), 'the cleanup paragraph must teach the inactivity filter');
});
