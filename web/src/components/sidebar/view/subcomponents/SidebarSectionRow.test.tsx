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

test('wrapper 带 group（hover 显形的作用域根）与淡紫底', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed={false} onToggle={noop} />,
  );
  // 删掉 group，`group-hover:` 系列全部失效 —— 必须有断言兜住。
  assert.ok(html.includes('class="group '));
  // 「统一成 Lovdex助手 风格」的四条规则之一。
  assert.ok(html.includes('bg-primary/5'));
});

test('className 与自有类合并且不互相吞并', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow
      icon={Folder}
      label="项目"
      collapsed={false}
      onToggle={noop}
      className="border-t border-border/60 pb-2"
    />,
  );
  assert.ok(html.includes('border-t border-border/60 pb-2'));
  // 自有类不能被透传的 className 顶掉。
  assert.ok(html.includes('flex-shrink-0'));
  assert.ok(html.includes('md:px-1.5'));
});

test('展开态在 DOM 里可见（aria-expanded）', () => {
  const collapsedHtml = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed onToggle={noop} />,
  );
  const expandedHtml = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed={false} onToggle={noop} />,
  );
  assert.ok(collapsedHtml.includes('aria-expanded="false"'));
  assert.ok(expandedHtml.includes('aria-expanded="true"'));
});

test('children 渲染在标题行之后、wrapper 之内', () => {
  const html = renderToStaticMarkup(
    <SidebarSectionRow icon={Folder} label="项目" collapsed={false} onToggle={noop}>
      <div title="区块体" />
    </SidebarSectionRow>,
  );
  assert.ok(html.includes('title="区块体"'));
  // 必须在按钮之后（标题行下方）。
  assert.ok(html.indexOf('title="区块体"') > html.indexOf('lucide-chevron-down'));
  // 且仍在 wrapper 内：wrapper 是根元素，它自己的 `</div>` 必须收在 children 之后。
  // 若 children 被渲染成 wrapper 的兄弟节点，children 之后只会剩它自己的闭合标签（1 个）。
  const tail = html.slice(html.indexOf('title="区块体"'));
  assert.equal((tail.match(/<\/div>/g) ?? []).length, 2);
});
