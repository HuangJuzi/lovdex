import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { Folder } from 'lucide-react';

import SidebarSectionRow from './SidebarSectionRow';

const noop = () => {};

test('箭头渲染在标题之后（在右）', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed={false} onToggle={noop} />,
  );
  assert.ok(html.includes('>项目</span>'));
  // 「箭头都在右边」这条需求就靠这一条断言钉住：chevron 必须出现在标题文案之后。
  assert.ok(html.indexOf('lucide-chevron-down') > html.indexOf('>项目</span>'));
});

test('collapsed 时用 chevron-right，title 为「展开 X」', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed onToggle={noop} />,
  );
  assert.ok(html.includes('lucide-chevron-right'));
  assert.ok(!html.includes('lucide-chevron-down'));
  assert.ok(html.includes('展开 项目'));
});

test('展开时 title 为「收起 X」', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed={false} onToggle={noop} />,
  );
  assert.ok(html.includes('收起 项目'));
});

test('actions 渲染进行内动作区，且在箭头之前', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow
      icon={Folder}
      label="项目"
      collapsed={false}
      onToggle={noop}
      actions={<div title="新建项目" />}
    />,
  );
  assert.ok(html.includes('title="新建项目"'));
  assert.ok(html.indexOf('title="新建项目"') < html.indexOf('lucide-chevron-down'));
});
