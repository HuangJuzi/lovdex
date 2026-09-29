import test from 'node:test';
import assert from 'node:assert/strict';

import type { Question } from '../chat/types/types';

import { applyPick, formatAnswers, nextSelection } from './pendingPromptAnswers';

/** 只关心模式的题目替身：这些用例测的是模式分派，不是题面文案。 */
const singleQ = { question: '它', options: [{ label: '甲' }] };
const singleFalseQ = { question: '它', options: [{ label: '甲' }], multiSelect: false };
const multiQ = { question: '它', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] };
const secondQ = { question: '另一题', options: [{ label: '乙' }] };

test('多选：新 label 追加到末尾，保留点击顺序', () => {
  let picks: string[] = [];
  picks = applyPick(picks, '弹窗', multiQ);
  picks = applyPick(picks, '工具栏', multiQ);
  assert.deepEqual(picks, ['弹窗', '工具栏']);
});

test('多选：再点同一个 label 会移除它', () => {
  assert.deepEqual(applyPick(['弹窗', '工具栏'], '弹窗', multiQ), ['工具栏']);
});

test('多选：不改动别的 label 的顺序（聊天页是插入序，不是字典序）', () => {
  assert.deepEqual(applyPick(['b', 'a'], 'c', multiQ), ['b', 'a', 'c']);
});

test('多选：重复点同一个 label 两次回到起点', () => {
  assert.deepEqual(applyPick(applyPick([], '甲', multiQ), '甲', multiQ), []);
});

test('单选：点第二个 label 是替换而不是追加', () => {
  // 这张卡片最容易写错的一处：单选若误走切换，界面照样高亮，但答案会多一项。
  assert.deepEqual(applyPick(['甲'], '乙', singleQ), ['乙']);
  assert.deepEqual(applyPick(['甲'], '乙', singleFalseQ), ['乙']);
});

test('单选：再点已选中的 label 仍是选中它，不会被取消到一个空集合', () => {
  // 聊天页单选走 clear+add，点已选项的结果还是「选中它」；切换式实现会变成空。
  assert.deepEqual(applyPick(['甲', '乙'], '甲', singleQ), ['甲']);
});

test('multiSelect 缺失或为 false 都走单选 —— 只有严格 true 才是多选', () => {
  // 后端/模型传下来的 input 不受本仓库类型约束，`1`、`'true'` 都可能出现
  // （下面两个 cast 就是故意的：它们在类型上不合法，在运行时却到得了这里）。
  const malformed = [{ multiSelect: 1 }, { multiSelect: 'true' }] as unknown as Question[];
  for (const question of [singleQ, singleFalseQ, ...malformed]) {
    assert.deepEqual(
      applyPick(['甲'], '乙', question as Question),
      ['乙'],
      JSON.stringify(question),
    );
  }
});

test('nextSelection：单选点一下即提交（且全部题目都答完时）', () => {
  const questions = [singleQ];
  const result = nextSelection({}, questions, 0, '甲');
  assert.deepEqual(result.picked, { 它: ['甲'] });
  assert.equal(result.submit, true);
});

test('nextSelection：单选点了但别的题还没答，不提交', () => {
  const questions = [singleQ, { question: '另一题', options: [{ label: '丙' }] }];
  const result = nextSelection({}, questions, 0, '甲');
  assert.deepEqual(result.picked, { 它: ['甲'] });
  assert.equal(result.submit, false);
});

test('nextSelection：多选点了**不**提交，必须等确认按钮', () => {
  // 这是多选唯一的意义所在：点一下是「选上」，不是「答完」。
  const result = nextSelection({}, [multiQ], 0, '甲');
  assert.deepEqual(result.picked, { 它: ['甲'] });
  assert.equal(result.submit, false);
});

test('nextSelection：多选已选中一项，再点取消回到空 —— 也不提交', () => {
  const first = nextSelection({}, [multiQ], 0, '甲');
  const second = nextSelection(first.picked, [multiQ], 0, '甲');
  assert.deepEqual(second.picked, { 它: [] });
  assert.equal(second.submit, false);
});

test('nextSelection：越界的题目下标不炸，原样返回且不提交', () => {
  const result = nextSelection({}, [singleQ], 5, '甲');
  assert.deepEqual(result.picked, {});
  assert.equal(result.submit, false);
});

test('formatAnswers：用「逗号 + 空格」连接，与聊天页 join(", ") 逐字一致', () => {
  assert.deepEqual(formatAnswers({ 它: ['弹窗', '工具栏'] }, [multiQ]), { 它: '弹窗, 工具栏' });
  assert.deepEqual(formatAnswers({ 它: ['只有一个'] }, [multiQ]), { 它: '只有一个' });
  assert.deepEqual(formatAnswers({}, [multiQ]), {});
});

test('formatAnswers：没作答的题目不写进结果（不是写成空串）', () => {
  // 混合卡里多选的「提交选择」是静态可点的：此时别的题可能还没作答。若这里
  // 把未答的题写成 ''，后端会拿到一份看着「答过了」的缺项答案。
  const questions = [singleQ, secondQ];
  assert.deepEqual(formatAnswers({ 它: ['甲'] }, questions), { 它: '甲' });
  const both = { 它: ['甲'], 另一题: ['乙'] };
  assert.deepEqual(formatAnswers(both, questions), { 它: '甲', 另一题: '乙' });
});

test('formatAnswers：单选与多选共用同一形状（单选是单元素退化情形）', () => {
  // 钉住前提：哪天有人把单选特化成别的形状（例如包一层数组字面量），两种模式
  // 发出去的答案就分叉了，而聊天页与后端只认这一种。
  assert.deepEqual(formatAnswers({ 它: ['甲'] }, [singleQ]), { 它: '甲' });
  assert.deepEqual(
    formatAnswers(nextSelection({}, [singleQ], 0, '甲').picked, [singleQ]),
    { 它: '甲' },
  );
});
