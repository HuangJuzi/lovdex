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

// A tool_result whose `content` is missing entirely must not take the whole
// chat pane down. dsh's ACP normalizer emits `content: undefined` for a
// terminal `tool_call_update` that carries no rawOutput, and the converter used
// to run `JSON.stringify(undefined).trim()` on it — a TypeError that surfaced as
// an ErrorBoundary screen attributed to ChatInterface (the hook runs inside its
// render). Undefined and null must both degrade to the empty string here, so no
// provider's wire shape can crash the renderer.
test('a tool_result with no content does not throw and renders empty', () => {
  for (const missing of [undefined, null]) {
    const messages = normalizedToChatMessages(rows([
      { ...base, id: 'u9', kind: 'tool_use', toolName: 'Bash', toolInput: {}, toolId: 'T9' },
      { ...base, id: 'r9', kind: 'tool_result', toolId: 'T9', content: missing },
    ]));

    const toolUse = messages.find((m) => m.isToolUse);
    assert.ok(toolUse, `tool_use must still convert when content is ${String(missing)}`);
    assert.equal(toolUse?.toolResult?.content, '');
  }
});

// ---------------------------------------------------------------------------
// `permission_auto` → ⚡ 实时提示的接线。
//
// 这里测的是**接线**，不是叶子：只渲染 `AutoApproveNotice` 覆盖不到「分支有没有
// 把分类字段写进 notice」这一步。把分支里 `autoApproveDenyKind: kind` 那行删掉，
// 下面第一条必须变红 —— 否则这组用例是空转的。
// ---------------------------------------------------------------------------

test('a denied interaction becomes a notice tagged interaction, without the model-facing tail', () => {
  const messages = normalizedToChatMessages(rows([
    {
      ...base,
      id: 'p1',
      kind: 'permission_auto',
      toolName: 'AskUserQuestion',
      autoApproveBehavior: 'deny',
      autoApproveReason:
        '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。',
    },
  ]));

  const notice = messages.find((m) => m.type === 'notice');
  // 肯定式断言：这条 notice 真的产出了（不是空数组碰巧全绿）。
  assert.ok(notice, 'expected a notice message');
  const { content } = notice;
  assert.ok(content, 'the notice must carry copy');
  assert.ok(content.includes('AskUserQuestion'), 'the tool name must appear');
  assert.equal(notice.autoApproveDenyKind, 'interaction');
  // 正向锁定这句文案：它同时是 `AutoApproveDenyNotice` 组件里那行（两处共用
  // `interactionNoticeCopy`）。只写「不含指令」是否定式断言，任一处改字都不会红。
  assert.ok(
    content.includes('无人值守，无人可应答'),
    'the shared interaction copy must be what the notice says',
  );
  // 后半句是写给模型的协议指令，不是 UI 文案。
  assert.ok(
    !content.includes('请基于现有信息自行判断'),
    'the model-facing instruction must not leak into the notice',
  );
});

test('a denied non-interaction tool becomes a notice tagged blocked, keeping the reason', () => {
  const reason = '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）';
  const messages = normalizedToChatMessages(rows([
    {
      ...base,
      id: 'p2',
      kind: 'permission_auto',
      toolName: 'Bash',
      autoApproveBehavior: 'deny',
      autoApproveReason: reason,
    },
  ]));

  const notice = messages.find((m) => m.type === 'notice');
  assert.ok(notice, 'expected a notice message');
  const { content } = notice;
  assert.ok(content, 'the notice must carry copy');
  assert.ok(content.includes('Bash'), 'the tool name must appear');
  assert.equal(notice.autoApproveDenyKind, 'blocked');
  assert.ok(content.includes(reason), 'the reason is the point — keep it verbatim');
});

test('an allowed tool call is a plain notice with no deny kind', () => {
  const messages = normalizedToChatMessages(rows([
    {
      ...base,
      id: 'p3',
      kind: 'permission_auto',
      toolName: 'Read',
      autoApproveBehavior: 'allow',
    },
  ]));

  const notice = messages.find((m) => m.type === 'notice');
  assert.ok(notice, 'expected a notice message');
  assert.ok(notice.content?.includes('Read'), 'the tool name must appear');
  assert.equal(notice.autoApproveDenyKind, undefined);
});
