import test from 'node:test';
import assert from 'node:assert/strict';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

const base = {
  sessionId: 's1',
  timestamp: '2026-09-23T00:00:00.000Z',
  provider: 'claude',
} as const;

/**
 * 测试只需要几个字段，但函数签名要完整消息；一处收口，别在每个用例里写 cast。
 *
 * 注意这个 cast **关掉了多余属性检查与字段名检查**：这些用例验证的是「给定这种
 * 形状时的行为」，**不**验证「这种形状真的会从线上到达」。后者由后端
 * `auto-approve-deny-tag.test.ts` 负责。
 */
function rows(partial: Array<Record<string, unknown>>): NormalizedMessage[] {
  return partial as unknown as NormalizedMessage[];
}

test('threads autoApproveDeny from the standalone tool_result message (live shape)', () => {
  const messages = normalizedToChatMessages(rows([
    { ...base, id: 'u1', kind: 'tool_use', toolName: 'AskUserQuestion', toolInput: {}, toolId: 'T1' },
    {
      ...base,
      id: 'r1',
      kind: 'tool_result',
      toolId: 'T1',
      content: '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。',
      isError: true,
      autoApproveDeny: 'interaction',
    },
  ]));

  const toolUse = messages.find((m) => m.isToolUse);
  assert.ok(toolUse, 'expected a tool_use message');
  assert.equal(toolUse.toolResult?.autoApproveDeny, 'interaction');
  assert.equal(toolUse.toolResult?.isError, true);
});

test('threads autoApproveDeny from a pre-attached toolResult (history shape)', () => {
  const messages = normalizedToChatMessages(rows([
    {
      ...base,
      id: 'u2',
      kind: 'tool_use',
      toolName: 'Bash',
      toolInput: {},
      toolId: 'T2',
      toolResult: {
        content: '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）',
        isError: true,
        autoApproveDeny: 'blocked',
      },
    },
  ]));

  const toolUse = messages.find((m) => m.isToolUse);
  assert.equal(toolUse?.toolResult?.autoApproveDeny, 'blocked');
});

test('a genuine tool error carries no autoApproveDeny', () => {
  const messages = normalizedToChatMessages(rows([
    { ...base, id: 'u3', kind: 'tool_use', toolName: 'Read', toolInput: {}, toolId: 'T3' },
    { ...base, id: 'r3', kind: 'tool_result', toolId: 'T3', content: 'ENOENT', isError: true },
  ]));

  const toolUse = messages.find((m) => m.isToolUse);
  assert.equal(toolUse?.toolResult?.isError, true);
  assert.equal(toolUse?.toolResult?.autoApproveDeny, undefined);
});
