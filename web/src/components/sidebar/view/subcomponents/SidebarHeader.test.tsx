import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

test('桌面与移动端顶部按钮都指向「新建任务」', () => {
  const html = render(false);
  // 桌面/移动是 CSS 切换（hidden md:block / md:hidden），不是条件渲染 ——
  // SSR 拿到的两段 markup 是同一份，所以这里只断言整份文档，不假装能区分两端。
  // 计数 = 桌面 title + 移动 title + 移动 aria-label；少一个说明有按钮漏改了。
  assert.equal((html.match(/tooltips\.createTask/g) ?? []).length, 3);
  assert.ok(!html.includes('tooltips.createProject'));

  // 上面那条注释是本测试只断言一份 markup 的**前提**。前提本身也要钉住：
  // 一旦有人把桌面/移动改成条件渲染（而非 CSS），两份 markup 就会分叉，
  // 「一份等于两份」的推理失效，必须回来把两端拆成独立断言。
  assert.equal(render(true), html, '桌面/移动 markup 不再相同 —— 本测试的前提破了，请拆成两端各自断言');
});

test('顶部按钮不再出现 FolderPlus 图标', () => {
  // FolderPlus 留给「项目」行的新建项目按钮。
  assert.ok(!render(false).includes('lucide-folder-plus'));
});

// `t` 桩把 key 原样回显，上面两条只钉住「传了哪个 key」—— key 拼错、或
// en/sidebar.json 里漏了这一条，测试照样绿，而 UI 会渲染出裸 key。
// 拿真实 bundle 解析一次才算把洞补上（同 permissionModeLabels.i18n.test.ts）。
const SIDEBAR_BUNDLE = fileURLToPath(new URL('../../../../i18n/locales/en/sidebar.json', import.meta.url));

const resolveKey = (root: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>(
    (node, part) => (node as Record<string, unknown> | undefined)?.[part],
    root,
  );

test('tooltips.createTask 在 en sidebar bundle 里能解析出非空文案', () => {
  const bundle = JSON.parse(readFileSync(SIDEBAR_BUNDLE, 'utf8')) as Record<string, unknown>;
  const value = resolveKey(bundle, 'tooltips.createTask');
  assert.equal(typeof value, 'string', 'sidebar.tooltips.createTask is missing or not a string');
  assert.ok((value as string).trim().length > 0, 'sidebar.tooltips.createTask resolves to an empty string');
});
