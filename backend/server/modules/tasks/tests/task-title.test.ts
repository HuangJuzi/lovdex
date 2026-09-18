import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FALLBACK_TITLE,
  TITLE_MAX_GRAPHEMES,
  TITLE_PROMPT_MAX_CHARS,
  buildTitleUserPrompt,
  deriveFallbackTitle,
  raceTaskTitle,
  sanitizeGeneratedTitle,
  shouldApplyGeneratedTitle,
  truncateGraphemes,
} from '@/modules/tasks/services/task-title.js';

// ---------------------------------------------------------------------------
// truncateGraphemes
// ---------------------------------------------------------------------------

test('truncateGraphemes leaves a short string untouched', () => {
  assert.equal(truncateGraphemes('修复登录超时', 10), '修复登录超时');
});

test('truncateGraphemes counts an emoji as one glyph', () => {
  assert.equal(truncateGraphemes('😀😀😀😀', 2), '😀😀');
});

test('truncateGraphemes never leaves a lone surrogate behind', () => {
  // 10 个 emoji 每个占 2 个 UTF-16 码元；按 slice 切会在第 5 个字符中间断开。
  const out = truncateGraphemes('😀😀😀😀😀😀😀😀😀😀', 5);
  assert.equal(out, '😀😀😀😀😀');
  assert.equal([...out].length, 5);
  assert.ok(!out.includes('�'));
});

test('truncateGraphemes keeps a combining mark attached to its base', () => {
  // é 作为 e + U+0301 组合序列时是一个字素，按码点切会切出裸组合符。
  const out = truncateGraphemes('ééé', 2);
  assert.equal(out, 'éé');
});

// ---------------------------------------------------------------------------
// deriveFallbackTitle —— description 拿不到模型结果时的本地兜底
// ---------------------------------------------------------------------------

test('deriveFallbackTitle uses a single short line verbatim', () => {
  assert.equal(deriveFallbackTitle('修复登录页的报错'), '修复登录页的报错');
});

test('deriveFallbackTitle takes the first non-empty line and ignores the rest', () => {
  assert.equal(deriveFallbackTitle('\n\n  给看板加筛选  \n更多细节在后面'), '给看板加筛选');
});

test('deriveFallbackTitle collapses internal whitespace on the picked line', () => {
  assert.equal(deriveFallbackTitle('fix    the\tlogin\t bug'), 'fix the login bug');
});

test('deriveFallbackTitle truncates long lines to 50 glyphs with an ellipsis', () => {
  const out = deriveFallbackTitle('长'.repeat(80));
  assert.equal([...out].length, 51);
  assert.ok(out.endsWith('…'));
});

test('deriveFallbackTitle falls back to 未命名任务 for a blank description', () => {
  assert.equal(deriveFallbackTitle('   \n\t '), FALLBACK_TITLE);
  assert.equal(deriveFallbackTitle(''), FALLBACK_TITLE);
  assert.equal(deriveFallbackTitle(null), FALLBACK_TITLE);
  assert.equal(deriveFallbackTitle(undefined), FALLBACK_TITLE);
});

// ---------------------------------------------------------------------------
// buildTitleUserPrompt
// ---------------------------------------------------------------------------

test('buildTitleUserPrompt embeds the description and the length rule', () => {
  const prompt = buildTitleUserPrompt({ prompt: '把任务面板的筛选做成表格视图' });
  assert.match(prompt, /把任务面板的筛选做成表格视图/);
  assert.match(prompt, new RegExp(String(TITLE_MAX_GRAPHEMES)));
});

test('buildTitleUserPrompt caps the description at 2000 code points', () => {
  const prompt = buildTitleUserPrompt({ prompt: '长'.repeat(TITLE_PROMPT_MAX_CHARS + 500) });
  assert.equal(prompt.match(/长/g)?.length, TITLE_PROMPT_MAX_CHARS);
});

test('buildTitleUserPrompt truncates by code point, not UTF-16 unit', () => {
  // 2001 个 emoji：按 slice 会在第 2000 位留下孤立代理项（U+D83D）再送进提示词。
  const prompt = buildTitleUserPrompt({ prompt: '😀'.repeat(TITLE_PROMPT_MAX_CHARS + 1) });
  assert.equal(prompt.match(/😀/g)?.length, TITLE_PROMPT_MAX_CHARS);
  assert.ok(!prompt.includes('\uD83D\uD83D'));
});

test('buildTitleUserPrompt tolerates a missing description', () => {
  assert.equal(typeof buildTitleUserPrompt({}), 'string');
  assert.equal(typeof buildTitleUserPrompt({ prompt: null }), 'string');
});

// ---------------------------------------------------------------------------
// sanitizeGeneratedTitle —— 宽容清洗模型输出
// ---------------------------------------------------------------------------

test('sanitizeGeneratedTitle passes a clean title through', () => {
  assert.equal(sanitizeGeneratedTitle('修复登录超时'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips a three-line code fence', () => {
  assert.equal(sanitizeGeneratedTitle('```\n修复登录超时\n```'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips a language-tagged fence', () => {
  assert.equal(sanitizeGeneratedTitle('```text\n重构任务面板筛选\n```'), '重构任务面板筛选');
});

test('sanitizeGeneratedTitle strips a single-line fence', () => {
  assert.equal(sanitizeGeneratedTitle('```修复登录超时```'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips wrapping quotes', () => {
  assert.equal(sanitizeGeneratedTitle('"修复登录超时"'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('「修复登录超时」'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('“修复登录超时”'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('『修复登录超时』'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips trailing punctuation', () => {
  assert.equal(sanitizeGeneratedTitle('修复登录超时。'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('修复登录超时！'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('修复登录超时, '), '修复登录超时');
});

test('sanitizeGeneratedTitle keeps the first non-empty line only', () => {
  assert.equal(sanitizeGeneratedTitle('修复登录超时\n\n说明：因为超时配置错了'), '修复登录超时');
});

test('sanitizeGeneratedTitle collapses internal whitespace', () => {
  // 输入必须短于字素上限，否则截断会把「折叠空白」这件事盖掉。
  assert.equal(sanitizeGeneratedTitle('修复   登录\t超时'), '修复 登录 超时');
});

test('sanitizeGeneratedTitle truncates to the glyph cap', () => {
  const out = sanitizeGeneratedTitle('修复登录超时并顺带重构整个任务面板的筛选逻辑');
  assert.equal([...out!].length, TITLE_MAX_GRAPHEMES);
  assert.equal(out, '修复登录超时并顺带重');
});

test('sanitizeGeneratedTitle strips punctuation newly exposed by truncation', () => {
  // 「重构任务面板，筛选，排序」截到 10 字素正好停在逗号上；先剥标点再截断会把它留下。
  assert.equal(sanitizeGeneratedTitle('重构任务面板，筛选，排序'), '重构任务面板，筛选');
});

test('sanitizeGeneratedTitle rejects unusable output', () => {
  assert.equal(sanitizeGeneratedTitle(''), null);
  assert.equal(sanitizeGeneratedTitle('   \n\t '), null);
  assert.equal(sanitizeGeneratedTitle('""'), null);
  assert.equal(sanitizeGeneratedTitle('「」'), null);
  assert.equal(sanitizeGeneratedTitle('。。。'), null);
});

test('sanitizeGeneratedTitle rejects non-strings', () => {
  assert.equal(sanitizeGeneratedTitle(null), null);
  assert.equal(sanitizeGeneratedTitle(undefined), null);
  assert.equal(sanitizeGeneratedTitle(42), null);
  assert.equal(sanitizeGeneratedTitle({ title: 'x' }), null);
});

// ---------------------------------------------------------------------------
// raceTaskTitle —— 阻塞窗口 + 迟到结果留给后台
// ---------------------------------------------------------------------------

test('raceTaskTitle returns the model title when it beats the blocking window', async () => {
  const { title, background } = await raceTaskTitle(Promise.resolve('修复登录超时'), '首行兜底', 200);
  assert.equal(title, '修复登录超时');
  assert.equal(background, null);
});

test('raceTaskTitle falls back and hands the pending promise to the background', async () => {
  let resolveLate: (v: string | null) => void = () => {};
  const pending = new Promise<string | null>((resolve) => {
    resolveLate = resolve;
  });
  const { title, background } = await raceTaskTitle(pending, '首行兜底', 20);
  assert.equal(title, '首行兜底');
  assert.ok(background, 'timed out but the in-flight promise must be handed back');

  // 迟到回来的同一个 promise（不是重发一次请求）解析出模型标题。
  resolveLate('修复登录超时');
  assert.equal(await background, '修复登录超时');
});

test('raceTaskTitle falls back with no background when the model request fails fast', async () => {
  const { title, background } = await raceTaskTitle(Promise.reject(new Error('relay 挂了')), '首行兜底', 200);
  assert.equal(title, '首行兜底');
  assert.equal(background, null);
});

test('raceTaskTitle falls back with no background when the model returns nothing', async () => {
  const { title, background } = await raceTaskTitle(Promise.resolve(null), '首行兜底', 200);
  assert.equal(title, '首行兜底');
  assert.equal(background, null);
});

test('raceTaskTitle background may still reject without an unhandled rejection', async () => {
  let rejectLate: (e: Error) => void = () => {};
  const pending = new Promise<string | null>((_resolve, reject) => {
    rejectLate = reject;
  });
  const { title, background } = await raceTaskTitle(pending, '首行兜底', 20);
  assert.equal(title, '首行兜底');
  assert.ok(background);

  rejectLate(new Error('迟到的失败'));
  // 契约：raceTaskTitle 自己接管这个 reject，消费方拿到的是 null 而不是未捕获异常。
  assert.equal(await background, null);
});

// ---------------------------------------------------------------------------
// shouldApplyGeneratedTitle —— 回写 CAS
// ---------------------------------------------------------------------------

test('shouldApplyGeneratedTitle allows the write-back while the placeholder stands', () => {
  assert.equal(shouldApplyGeneratedTitle({ status: 'todo', title: '首行兜底' }, '首行兜底'), true);
});

test('shouldApplyGeneratedTitle yields when the user renamed the task meanwhile', () => {
  assert.equal(shouldApplyGeneratedTitle({ status: 'todo', title: '用户改的名字' }, '首行兜底'), false);
});

test('shouldApplyGeneratedTitle yields for an archived task', () => {
  assert.equal(shouldApplyGeneratedTitle({ status: 'archived', title: '首行兜底' }, '首行兜底'), false);
});

test('shouldApplyGeneratedTitle yields when the task is gone', () => {
  assert.equal(shouldApplyGeneratedTitle(null, '首行兜底'), false);
  assert.equal(shouldApplyGeneratedTitle(undefined, '首行兜底'), false);
});
