import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProviderProfileSelector } from './ProviderProfileSelector';

const profiles = {
  p_a: { name: '主账号', values: {} },
  p_b: { name: '备用', values: {} },
};

function render(overrides: Partial<React.ComponentProps<typeof ProviderProfileSelector>> = {}) {
  return renderToStaticMarkup(
    <ProviderProfileSelector
      profiles={profiles}
      selectedId=""
      modified={false}
      onSelect={() => {}}
      onUpdate={() => {}}
      onCreate={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      {...overrides}
    />,
  );
}

test('renders the custom option plus every profile name', () => {
  const html = render();
  assert.match(html, /自定义（不归属任何档）/);
  assert.match(html, /主账号/);
  assert.match(html, /备用/);
  assert.match(html, /保存到该档/);
  assert.match(html, /存为新档/);
  assert.match(html, /重命名/);
  assert.match(html, /删除/);
});

test('marks the selected profile as 已修改 only while modified', () => {
  assert.match(render({ selectedId: 'p_a', modified: true }), /主账号（已修改）/);
  assert.doesNotMatch(render({ selectedId: 'p_a', modified: false }), /已修改/);
  // 没选档时不会把「已修改」挂到任何档名上
  assert.doesNotMatch(render({ selectedId: '', modified: true }), /已修改/);
});

test('disables rename/delete when no profile is selected', () => {
  const none = render({ selectedId: '' });
  assert.match(none, /<button[^>]*disabled=""[^>]*>重命名/);
  assert.match(none, /<button[^>]*disabled=""[^>]*>删除/);
  assert.doesNotMatch(render({ selectedId: 'p_a' }), /<button[^>]*disabled=""[^>]*>删除/);
});

test('保存到该档 is enabled only when a profile is selected AND the form differs from it', () => {
  // 没选档：没有可覆盖的对象，只能走「存为新档」
  assert.match(render({ selectedId: '', modified: true }), /<button[^>]*disabled=""[^>]*>保存到该档/);
  // 选了档但表单与它一致：保存是空操作
  assert.match(render({ selectedId: 'p_a', modified: false }), /<button[^>]*disabled=""[^>]*>保存到该档/);
  // 选了档且已修改：可点
  assert.doesNotMatch(render({ selectedId: 'p_a', modified: true }), /<button[^>]*disabled=""[^>]*>保存到该档/);
  // 整体 disabled（正在保存）时一律不可点
  assert.match(
    render({ selectedId: 'p_a', modified: true, disabled: true }),
    /<button[^>]*disabled=""[^>]*>保存到该档/,
  );
});
