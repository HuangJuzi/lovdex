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

test('动作图标带 ! 前缀（否则被 Button 的 [&_svg]:size-4 顶成 16px）', () => {
  // 实测过：`Button` 基础类里的 `[&_svg]:size-4` 是后代选择器，特异度 (0,1,1)，
  // 高于 svg 上的普通 `.h-3\.5` (0,1,0)，所以不加 ! 会渲染成 16px 而不是 14px。
  assert.ok(render({ hasExpandedProjects: true }).includes('!h-3.5 !w-3.5'));
});

test('动作按钮带 group-focus-within:opacity-100（键盘 Tab 时也要显形）', () => {
  // 这条不只是样式断言：`group-focus-within:opacity-100` 此前只写在
  // SidebarSectionRow 的 JSDoc 注释里，Tailwind 3 的扫描器是**按原始字节正则扫**、
  // 不剥注释，所以那个工具类是靠注释文本才生成的。这里是它第一个真实消费者 ——
  // 断言钉住它，免得注释被改写后工具类静默消失、键盘用户又看不见动作按钮。
  assert.ok(render({ hasExpandedProjects: true }).includes('group-focus-within:opacity-100'));
});
