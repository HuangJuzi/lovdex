import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarHeader from './SidebarHeader';

const noop = () => {};
// 直接把 key 回显出来，断言就不依赖 en locale 的具体措辞。
const t = ((k: string) => k) as never;

const render = (isMobile: boolean) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SidebarHeader
        isPWA={false}
        isMobile={isMobile}
        isLoading={false}
        projectsCount={1}
        runningSessionsCount={0}
        searchFilter=""
        onSearchFilterChange={noop}
        onClearSearchFilter={noop}
        onRefresh={noop}
        isRefreshing={false}
        onCreateTask={noop}
        onCollapseSidebar={noop}
        t={t}
      />
    </MemoryRouter>,
  );

test('桌面顶部按钮指向「新建任务」', () => {
  const html = render(false);
  assert.ok(html.includes('tooltips.createTask'));
  assert.ok(!html.includes('tooltips.createProject'));
});

test('移动端顶部按钮也指向「新建任务」', () => {
  const html = render(true);
  assert.ok(html.includes('tooltips.createTask'));
  assert.ok(!html.includes('tooltips.createProject'));
});

test('顶部按钮不再出现 FolderPlus 图标', () => {
  // FolderPlus 留给「项目」行的新建项目按钮。
  assert.ok(!render(false).includes('lucide-folder-plus'));
  assert.ok(!render(true).includes('lucide-folder-plus'));
});
