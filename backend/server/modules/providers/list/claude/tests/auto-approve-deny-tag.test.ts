import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { UNATTENDED_INTERACTION_DENY_REASON } from '@/modules/permissions/auto-approve-policy.js';

const provider = new ClaudeSessionsProvider();
const SID = 'sess-auto-approve';

/** 造一条 transcript 里的 user 行，里面挂一个 tool_result。 */
function transcriptRow(toolUseId: string, content: unknown, isError: boolean) {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    sessionId: SID,
    timestamp: '2026-09-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
  };
}

test('an unattended interaction denial is tagged as interaction', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T1', UNATTENDED_INTERACTION_DENY_REASON, true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.ok(result, 'expected a normalized tool_result');
  assert.equal(result.isError, true);
  assert.equal(result.autoApproveDeny, 'interaction');
});

test('a blocked dangerous command is tagged as blocked', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T2', '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）', true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'blocked');
});

test('a genuine tool error is left untagged', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T3', 'Error: ENOENT: no such file or directory', true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.isError, true);
  assert.equal(result?.autoApproveDeny, undefined);
});

test('a successful result is left untagged', () => {
  const out = provider.normalizeMessage(transcriptRow('T4', 'file contents', false), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, undefined);
});

// 真实 transcript 里 content 有 str / list 两种形态（本机实测 78744 : 2005）。
// 分类必须按 `.text` 约定解码数组，否则序列化后以 `[{` 开头、前缀匹配不成立，
// 标签会静默丢失。展示用的 content 保持 JSON 形态不变。
test('an array-shaped denial is tagged, and the displayed content is unchanged', () => {
  const parts = [{ type: 'text', text: UNATTENDED_INTERACTION_DENY_REASON }];
  const out = provider.normalizeMessage(transcriptRow('T5', parts, true), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'interaction');
  assert.equal(result?.content, JSON.stringify(parts), 'display value stays JSON');
});
