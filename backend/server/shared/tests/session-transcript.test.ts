/**
 * Contract for the shared session-transcript compactor.
 *
 * This function existed as two byte-identical copies (the `get_session_transcript`
 * operator tool and the task-context compression job). It lives in `shared/`
 * because that is the only element type the `boundaries` ESLint config
 * recognises besides `backend-module` — a cross-module import would add a
 * `boundaries/no-unknown` warning to every caller.
 *
 * The exact caps are a contract, not an implementation detail: both callers
 * feed the result to a token-budgeted LLM prompt, and the operator tool's
 * output is what the (legacy) verdict agent reads as evidence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { compactTranscriptToText } from '@/shared/session-transcript.js';

/** A tool result longer than the 300-char cap. */
const LONG_TOOL_RESULT = 'x'.repeat(400);
/** Assistant text longer than the 1200-char cap. */
const LONG_TEXT = 'y'.repeat(1500);

test('compactTranscriptToText keeps short user/assistant text verbatim', () => {
  const text = compactTranscriptToText([
    { role: 'user', content: '修登录页 500' },
    { role: 'assistant', content: '根因是 Nginx 代理超时，已改 upstream。' },
  ]);
  assert.equal(text, '[user] 修登录页 500\n\n[assistant] 根因是 Nginx 代理超时，已改 upstream。');
});

test('compactTranscriptToText truncates tool results to 300 chars', () => {
  const text = compactTranscriptToText([
    { role: 'tool', toolName: 'Write', toolResult: LONG_TOOL_RESULT },
  ]);
  const line = text.split('\n')[0];
  assert.ok(line.startsWith('[tool Write] '), `unexpected line: ${line.slice(0, 40)}`);
  assert.equal(line.length, '[tool Write] '.length + 300);
});

test('compactTranscriptToText truncates user/assistant text to 1200 chars', () => {
  const text = compactTranscriptToText([{ role: 'assistant', content: LONG_TEXT }]);
  assert.equal(text.length, '[assistant] '.length + 1200);
});

test('compactTranscriptToText renders a local command as /name', () => {
  const text = compactTranscriptToText([
    { role: 'user', isLocalCommand: true, commandName: 'model', content: 'ignored' },
  ]);
  assert.equal(text, '[user] /model');
});

test('compactTranscriptToText falls back to kind when role is absent', () => {
  const text = compactTranscriptToText([
    { kind: 'tool', toolName: 'Bash', toolResult: 'ok' },
    { kind: 'assistant', content: 'hi' },
  ]);
  assert.equal(text, '[tool Bash] ok\n\n[assistant] hi');
});

test('compactTranscriptToText defaults an unlabelled message role to "message"', () => {
  const text = compactTranscriptToText([{ content: 'orphan' }]);
  assert.equal(text, '[message] orphan');
});

test('compactTranscriptToText skips blank and whitespace-only content', () => {
  const text = compactTranscriptToText([
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'kept' },
  ]);
  assert.equal(text, '[user] kept');
});

test('compactTranscriptToText returns "(empty transcript)" when nothing survives', () => {
  assert.equal(compactTranscriptToText([]), '(empty transcript)');
  assert.equal(compactTranscriptToText([{ role: 'user', content: '  ' }]), '(empty transcript)');
});

test('compactTranscriptToText truncates an oversized tool result, not the message label', () => {
  const text = compactTranscriptToText([
    { role: 'tool', toolName: 'Bash', toolResult: 'z'.repeat(10_000) },
  ]);
  assert.equal(text.length, '[tool Bash] '.length + 300);
});
