import { type ReactNode, useState } from 'react';
import { ChevronsDownUp, Folder, FolderPlus, MessageSquare, Search } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';

import SidebarAssistant from './SidebarAssistant';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarRecentSessions from './SidebarRecentSessions';
import SidebarResizeHandle from './SidebarResizeHandle';
import SidebarScheduledEntry from './SidebarScheduledEntry';
import SidebarInboxEntry from './SidebarInboxEntry';
import SidebarSectionRow from './SidebarSectionRow';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-warning/30 px-0.5 text-foreground">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

type SidebarContentProps = {
  /** Currently open session id (URL / selection), used to highlight the Lovdex助手 row. */
  activeSessionId: string | null;
  onAssistantSessionSelect?: (sessionId: string) => void;
  isPWA: boolean;
  isMobile: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onReset: () => void;
  isLoading: boolean;
  projects: Project[];
  runningSessionsCount: number;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  // Conversation result clicks pass back the DB projectId (or null when the
  // server couldn't resolve it). Consumers must handle the null case.
  onConversationResultClick: (projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  /** 侧栏顶部的「新建任务」入口：就地打开新建任务弹窗。 */
  onCreateTask: () => void;
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  projectListProps: SidebarProjectListProps;
  /** 是否有 Project 处于展开态 —— 决定「全部收起」按钮是否出现。 */
  hasExpandedProjects: boolean;
  /** 一键收起所有已展开的 Project。 */
  onCollapseAllProjects: () => void;
  /** 点击「最近会话」里某条会话：打开该会话对话。 */
  onRecentSessionSelect: (session: ProjectSession, project: Project) => void;
  t: TFunction;
};

export default function SidebarContent({
  activeSessionId,
  onAssistantSessionSelect,
  isPWA,
  isMobile,
  width,
  onWidthChange,
  onReset,
  isLoading,
  projects,
  runningSessionsCount,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  conversationResults,
  isSearching,
  searchProgress,
  onConversationResultClick,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCreateTask,
  onCollapseSidebar,
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  onShowSettings,
  projectListProps,
  hasExpandedProjects,
  onCollapseAllProjects,
  onRecentSessionSelect,
  t,
}: SidebarContentProps) {
  // 项目列表整体折叠：与 Lovdex助手 / 最近会话同级的整行入口，收起时整个
  // 项目列表一起隐藏。折叠状态持久化，避免切到 /tasks 等独立路由再回来时
  // 被重置为展开。
  const [projectsCollapsed, setProjectsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lovdex:sidebar:projects-collapsed') === '1';
    } catch {
      return false;
    }
  });

  const showConversationSearch = searchFilter.trim().length >= 2;
  const hasPartialResults = Boolean(conversationResults && conversationResults.results.length > 0);

  return (
    <div
      className="relative flex h-full flex-col bg-card md:w-72 md:select-none"
      style={isMobile ? {} : { width }}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        isLoading={isLoading}
        projectsCount={projects.length}
        runningSessionsCount={runningSessionsCount}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateTask={onCreateTask}
        onCollapseSidebar={onCollapseSidebar}
        t={t}
      />

      <SidebarAssistant
        activeSessionId={activeSessionId}
        onOpenSession={onAssistantSessionSelect}
      />

      <SidebarSectionRow
        icon={Folder}
        label="项目"
        collapsed={projectsCollapsed}
        onToggle={() =>
          setProjectsCollapsed((prev) => {
            const next = !prev;
            try {
              localStorage.setItem('lovdex:sidebar:projects-collapsed', next ? '1' : '0');
            } catch {
              // ignore storage failures
            }
            return next;
          })
        }
        actions={
          <>
            {/* 结构对齐 SidebarAssistant 的「新建会话 +」：外层已经是 <button>，
                内层再用真 <button> 是非法嵌套，所以用 div role="button"；
                点击必须 stopPropagation，否则会连带把整行折叠掉。
                图标用 `!h-3.5 !w-3.5`（带 !）—— Button 基础类里的 `[&_svg]:size-4`
                是后代选择器，特异度高于 svg 上的普通 `h-3.5`，不加 ! 会渲染成 16px。
                `group-focus-within:opacity-100` 也不能省：Tab 进动作区时 group-hover
                不触发，焦点会落在 opacity:0 的元素上。 */}
            <div
              role="button"
              tabIndex={0}
              className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-primary/20 hover:text-primary hover:ring-1 hover:ring-primary/40 group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onCreateProject();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onCreateProject();
                }
              }}
              title="新建项目"
              aria-label="新建项目"
            >
              <FolderPlus className="!h-3.5 !w-3.5" />
            </div>
            {/* 文案硬编码中文，与紧邻的「项目」「展开 项目 / 收起 项目」一致 ——
                仓库只 bundle 了 en locale，这一区块本来就是硬编码中文。
                区块整体收起时列表被 hidden，此时按钮没有可收起的可见对象，一并藏掉。 */}
            {hasExpandedProjects && !projectsCollapsed && (
              <div
                role="button"
                tabIndex={0}
                className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-foreground/15 hover:text-foreground hover:ring-1 hover:ring-foreground/30 group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onCollapseAllProjects();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCollapseAllProjects();
                  }
                }}
                title="收起全部项目"
                aria-label="收起全部项目"
              >
                <ChevronsDownUp className="!h-3.5 !w-3.5" />
              </div>
            )}
          </>
        }
      />

      <ScrollArea className={cn('flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2', projectsCollapsed && 'hidden')}>
        {showConversationSearch && (
          <div className="mb-2 border-b border-border/60 pb-2">
            {isSearching && !hasPartialResults ? (
              <div className="px-4 py-8 text-center md:py-6">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                </div>
                <p className="text-sm text-muted-foreground">{t('search.searching')}</p>
                {searchProgress && (
                  <p className="mt-1 text-xs text-muted-foreground/60">
                    {t('search.projectsScanned', { count: searchProgress.scannedProjects })}/{searchProgress.totalProjects}
                  </p>
                )}
              </div>
            ) : !isSearching && conversationResults && conversationResults.results.length === 0 ? (
              <div className="px-4 py-8 text-center md:py-6">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                  <Search className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('search.noResults')}</h3>
                <p className="text-sm text-muted-foreground">{t('search.tryDifferentQuery')}</p>
              </div>
            ) : hasPartialResults ? (
              <div className="space-y-3 px-2">
                <div className="flex items-center justify-between px-1">
                  <p className="text-xs text-muted-foreground">
                    {t('search.matches', { count: conversationResults!.totalMatches })}
                  </p>
                  {isSearching && searchProgress && (
                    <div className="flex items-center gap-1.5">
                      <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary" />
                      <p className="text-3xs text-muted-foreground/60">
                        {searchProgress.scannedProjects}/{searchProgress.totalProjects}
                      </p>
                    </div>
                  )}
                </div>
                {isSearching && searchProgress && (
                  <div className="mx-1 h-0.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/60 transition-all duration-300"
                      style={{ width: `${Math.round((searchProgress.scannedProjects / searchProgress.totalProjects) * 100)}%` }}
                    />
                  </div>
                )}
                {conversationResults!.results.map((projectResult) => (
                  <div key={projectResult.projectName} className="space-y-1">
                    <div className="flex items-center gap-1.5 px-1 py-1">
                      <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs font-normal text-foreground">
                        {projectResult.projectDisplayName}
                      </span>
                    </div>
                    {projectResult.sessions.map((session) => (
                      <button
                        key={`${projectResult.projectId ?? projectResult.projectName}-${session.sessionId}`}
                        className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                        onClick={() => onConversationResultClick(
                          // Pass the DB projectId (preferred) so the parent can
                          // cross-reference with the loaded projects list.
                          projectResult.projectId,
                          session.sessionId,
                          session.provider || session.matches[0]?.provider || 'claude',
                          session.matches[0]?.timestamp,
                          session.matches[0]?.snippet
                        )}
                      >
                        <div className="mb-1 flex items-center gap-1.5">
                          <MessageSquare className="h-3 w-3 flex-shrink-0 text-primary" />
                          <span className="truncate text-xs font-normal text-foreground">
                            {session.sessionSummary}
                          </span>
                          {session.provider && session.provider !== 'claude' && (
                            <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-4xs uppercase text-muted-foreground">
                              {session.provider}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1 pl-4">
                          {session.matches.map((match, idx) => (
                            <div key={idx} className="flex items-start gap-1">
                              <span className="mt-0.5 flex-shrink-0 text-3xs font-normal uppercase text-muted-foreground/60">
                                {match.role === 'user' ? 'U' : 'A'}
                              </span>
                              <HighlightedSnippet
                                snippet={match.snippet}
                                highlights={match.highlights}
                              />
                            </div>
                          ))}
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <SidebarProjectList {...projectListProps} />
      </ScrollArea>

      <SidebarRecentSessions projects={projects} onRecentSessionSelect={onRecentSessionSelect} />

      <SidebarScheduledEntry />

      <SidebarInboxEntry />

      <SidebarFooter
        updateAvailable={updateAvailable}
        restartRequired={restartRequired}
        releaseInfo={releaseInfo}
        latestVersion={latestVersion}
        onShowVersionModal={onShowVersionModal}
        onShowSettings={onShowSettings}
        t={t}
      />
      {!isMobile && (
        <SidebarResizeHandle
          width={width}
          onWidthChange={onWidthChange}
          onReset={onReset}
        />
      )}
    </div>
  );
}
