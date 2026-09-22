import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ModelRankCard } from './ModelRankCard';

const SUMMARY = {
  range: { from: 1_700_000_000_000, to: 1_700_000_600_000 },
  byModel: [
    {
      model: 'm-a',
      tokens: { input: 600, output: 10, cacheRead: 1000, cacheCreation: 0 },
      peakAll: 300,
      peakNew: 120,
      peakInput: 90,
      peakOutput: 30,
      sessions: 2,
      lastUsedAt: 1_700_000_300_000,
    },
  ],
};

test('标题行标注当前口径，且不渲染可交互控件', () => {
  const html = renderToStaticMarkup(
    <ModelRankCard summary={SUMMARY} metric="output" dimension="model" />,
  );
  assert.match(html, /口径：仅输出/, '必须显示当前口径，否则数字变了会莫名其妙');
  assert.doesNotMatch(html, /aria-pressed/, '排行卡片只读，不能有第二个口径控件');
});

test('标注随口径切换而更新', () => {
  const html = renderToStaticMarkup(
    <ModelRankCard summary={SUMMARY} metric="input" dimension="vendor" />,
  );
  assert.match(html, /口径：仅输入/);
});

test('无数据时仍是空态，不抛错', () => {
  const html = renderToStaticMarkup(
    <ModelRankCard summary={null} metric="all" dimension="model" />,
  );
  assert.match(html, /暂无用量数据/);
});
