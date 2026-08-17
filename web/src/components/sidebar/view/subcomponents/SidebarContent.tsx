import { type ReactNode } from 'react';
import { Folder, MessageSquare, Search } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';

import SidebarAssistant from './SidebarAssistant';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarResizeHandle from './SidebarResizeHandle';
import SidebarScheduledEntry from './SidebarScheduledEntry';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
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
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  projectListProps: SidebarProjectListProps;
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
  onCollapseSidebar,
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  onShowSettings,
  projectListProps,
  t,
}: SidebarContentProps) {
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
        onCreateProject={onCreateProject}
        onCollapseSidebar={onCollapseSidebar}
        t={t}
      />

      <SidebarAssistant
        activeSessionId={activeSessionId}
        onOpenSession={onAssistantSessionSelect}
      />

      <SidebarScheduledEntry />

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
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
                      <p className="text-[10px] text-muted-foreground/60">
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
                            <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                              {session.provider}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1 pl-4">
                          {session.matches.map((match, idx) => (
                            <div key={idx} className="flex items-start gap-1">
                              <span className="mt-0.5 flex-shrink-0 text-[10px] font-normal uppercase text-muted-foreground/60">
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
