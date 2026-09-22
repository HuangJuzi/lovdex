import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarContent from './SidebarContent';
import type { SidebarProjectListProps } from './SidebarProjectList';

const noop = () => {};
const t = ((k: string) => k) as never;

// SidebarContent 的 props 太多，这里只填渲染路径真正会读到的字段；
// 空项目列表会让 SidebarProjectList 走 SidebarProjectsState 分支。
const projectListProps = {
  projects: [],
  filteredProjects: [],
  selectedProject: null,
  selectedSession: null,
  isLoading: false,
  loadingProgress: null,
  expandedProjects: new Set<string>(),
  editingProject: null,
  editingName: '',
  initialSessionsLoaded: new Set<string>(),
  currentTime: new Date(),
  editingSession: null,
  editingSessionName: '',
  deletingProjects: new Set<string>(),
  tasksEnabled: false,
  mcpServerStatus: {} as never,
  getProjectSessions: () => [],
  onLoadMoreSessions: noop,
  loadingMoreProjects: new Set<string>(),
  activeSessions: {},
  attentionSessionIds: new Set<string>(),
  isProjectStarred: () => false,
  onEditingNameChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onNewSession: noop,
  onEditingSessionNameChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  t,
} as unknown as SidebarProjectListProps;

const render = (overrides: { hasExpandedProjects?: boolean } = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SidebarContent
        activeSessionId={null}
        isPWA={false}
        isMobile={false}
        width={288}
        onWidthChange={noop}
        onReset={noop}
        isLoading={false}
        projects={[]}
        runningSessionsCount={0}
        searchFilter=""
        onSearchFilterChange={noop}
        onClearSearchFilter={noop}
        conversationResults={null}
        isSearching={false}
        searchProgress={null}
        onConversationResultClick={noop}
        onRefresh={noop}
        isRefreshing={false}
        onCreateProject={noop}
        onCollapseSidebar={noop}
        updateAvailable={false}
        restartRequired={false}
        releaseInfo={null}
        latestVersion={null}
        onShowVersionModal={noop}
        onShowSettings={noop}
        projectListProps={projectListProps}
        hasExpandedProjects={overrides.hasExpandedProjects ?? false}
        onCollapseAllProjects={noop}
        onRecentSessionSelect={noop}
        t={t}
      />
    </MemoryRouter>,
  );

test('「项目」行渲染出 hover 的新建项目按钮', () => {
  const html = render();
  assert.ok(html.includes('title="新建项目"'));
  assert.ok(html.includes('lucide-folder-plus'));
});

test('「项目」行的箭头在标题之后（在右）', () => {
  const html = render();
  assert.ok(html.includes('>项目</span>'));
  assert.ok(html.indexOf('lucide-chevron-down') > html.indexOf('>项目</span>'));
});

test('新建项目按钮在箭头之前', () => {
  const html = render();
  assert.ok(html.indexOf('title="新建项目"') < html.indexOf('lucide-chevron-down'));
});

test('没有展开项时不渲染「收起全部项目」', () => {
  assert.ok(!render({ hasExpandedProjects: false }).includes('title="收起全部项目"'));
});

test('有展开项时渲染「收起全部项目」', () => {
  assert.ok(render({ hasExpandedProjects: true }).includes('title="收起全部项目"'));
});

test('项目区块收起时不渲染「收起全部项目」（没有可收起的可见对象）', () => {
  // 显示条件是 `hasExpandedProjects && !projectsCollapsed` 两半；
  // 上面两条只动了 hasExpandedProjects，projectsCollapsed 是内部 state
  // （从 localStorage 读初值），这一半不 stub 就测不到。
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  try {
    store.set('lovdex:sidebar:projects-collapsed', '1');
    const html = render({ hasExpandedProjects: true });
    // 条件两半都要成立才渲染；收起时这一半不成立。
    assert.ok(!html.includes('title="收起全部项目"'));
    // 收起的是列表不是入口 —— 新建项目按钮必须还在。
    assert.ok(html.includes('title="新建项目"'));
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  }
});

/**
 * 取出某个动作按钮**自己的 markup 片段**（从它自己的 `class="…"` 到它内部 `<svg>` 结束）。
 *
 * 两个动作按钮同时在 DOM 里，只对整份 html 断言的话，任一按钮带该 class 就能满足 ——
 * 钉不住具体是哪一个。React 按 JSX 里的书写顺序渲染属性，所以按钮的 `class="…"`
 * 一定紧挨在 `title="…"` 之前：按 title 定位再向前回退到最近的 `class="` 即可。
 *
 * 为什么必须圈到 svg 结束而不是只取按钮的 class 属性：图标尺寸类 `!h-3.5 !w-3.5`
 * 挂在**内层 `<svg>`** 上（`<FolderPlus className="!h-3.5 !w-3.5" />`），
 * 按钮自己的 class 里根本没有它。只取 class 属性会漏掉尺寸回归。
 */
const actionSubtree = (html: string, title: string): string => {
  const titleIdx = html.indexOf(`title="${title}"`);
  assert.ok(titleIdx > -1, `找不到 title="${title}" 的动作按钮`);
  const classAttrIdx = html.lastIndexOf('class="', titleIdx);
  assert.ok(classAttrIdx > -1, `title="${title}" 之前没有 class 属性`);
  const svgEnd = html.indexOf('</svg>', titleIdx);
  assert.ok(svgEnd > -1, `title="${title}" 的按钮里没有 svg 图标`);
  return html.slice(classAttrIdx, svgEnd + '</svg>'.length);
};

/** 取出某个动作按钮**自己**的 class 串（不含后代元素）。 */
const classOfAction = (html: string, title: string): string => {
  const subtree = actionSubtree(html, title);
  const match = /^class="([^"]*)"/.exec(subtree);
  assert.ok(match, `title="${title}" 的片段不以 class=" 开头：${subtree.slice(0, 80)}`);
  const cls = match[1];
  // 兜底：确认回退到的确实是动作按钮自己的 class（而不是更靠前的某个元素），
  // 否则下面的断言会在错误的元素上「通过」。
  assert.ok(
    cls.includes('cursor-pointer') && cls.includes('opacity-0'),
    `title="${title}" 前最近的 class 不像动作按钮：${cls}`,
  );
  return cls;
};

test('「新建项目」按钮自己带 !h-3.5 !w-3.5 与 group-focus-within:opacity-100', () => {
  const html = render({ hasExpandedProjects: true });
  // 两个动作按钮同时在 DOM 里，必须取按钮自己的片段才钉得住。
  // 不加 ! 会被 Button 基础类的 `[&_svg]:size-4`（后代选择器，特异度更高）顶成 16px。
  assert.ok(actionSubtree(html, '新建项目').includes('!h-3.5 !w-3.5'));
  // 键盘 Tab 时 group-hover 不触发，没有它焦点会落在 opacity:0 的元素上。
  // 这三条必须落在按钮**自己**的 class 上，不能是后代。
  //
  // `group-focus-within:opacity-100` 还不只是样式断言：它此前只写在
  // SidebarSectionRow 的 JSDoc 注释里，Tailwind 3 的扫描器是**按原始字节正则扫**、
  // 不剥注释，所以那个工具类是靠注释文本才生成的。这里是它第一个真实消费者 ——
  // 断言钉住它，免得注释被改写后工具类静默消失、键盘用户又看不见动作按钮。
  const cls = classOfAction(html, '新建项目');
  assert.ok(cls.includes('group-focus-within:opacity-100'));
  assert.ok(cls.includes('group-hover:opacity-100'));
  assert.ok(cls.includes('touch:opacity-100'));
});

test('「收起全部项目」按钮也带同款显形与尺寸类', () => {
  const html = render({ hasExpandedProjects: true });
  assert.ok(actionSubtree(html, '收起全部项目').includes('!h-3.5 !w-3.5'));
  const cls = classOfAction(html, '收起全部项目');
  assert.ok(cls.includes('group-focus-within:opacity-100'));
  assert.ok(cls.includes('group-hover:opacity-100'));
  assert.ok(cls.includes('touch:opacity-100'));
});

test('两个动作按钮的 class 互不串台', () => {
  // 「新建项目」用 primary 配色、「收起全部项目」用 foreground 配色 —— 取错元素会立刻暴露。
  const html = render({ hasExpandedProjects: true });
  assert.ok(classOfAction(html, '新建项目').includes('hover:bg-primary/20'));
  assert.ok(classOfAction(html, '收起全部项目').includes('hover:bg-foreground/15'));
});
