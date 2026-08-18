import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useSidebarController } from '../hooks/useSidebarController';
import { useSidebarWidth } from '../../../hooks/useSidebarWidth';
import type { Project, LLMProvider } from '../../../types/app';
import type { MCPServerStatus, SidebarProps } from '../types/types';

import SidebarCollapsed from './subcomponents/SidebarCollapsed';
import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
import type { SidebarProjectListProps } from './subcomponents/SidebarProjectList';

type TaskMasterSidebarContext = {
  setCurrentProject: (project: Project) => void;
  mcpServerStatus: MCPServerStatus;
};

// Simplified edition: version-check, task-master, command-palette and
// tasks-settings features were removed. These stubs keep the sidebar wiring
// intact without depending on the deleted contexts/hooks.
const useVersionCheckStub = () => ({
  updateAvailable: false,
  restartRequired: false,
  latestVersion: null as string | null,
  currentVersion: '',
  releaseInfo: null,
  installMode: 'git' as 'git' | 'npm',
});
const useTaskMasterStub = (): TaskMasterSidebarContext => ({
  setCurrentProject: () => {},
  mcpServerStatus: {} as MCPServerStatus,
});
const usePaletteOpsStub = () => ({ refreshProjects: async () => {} });
const useTasksSettingsStub = () => ({ tasksEnabled: false });

function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  activeSessions,
  attentionSessionIds,
  onProjectSelect,
  onSessionSelect,
  onAssistantSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { updateAvailable, restartRequired, latestVersion, currentVersion, releaseInfo, installMode } = useVersionCheckStub();
  const { preferences, setPreference } = useUiPreferences();
  const { sidebarVisible } = preferences;
  const { setCurrentProject, mcpServerStatus } = useTaskMasterStub();
  const { tasksEnabled } = useTasksSettingsStub();
  const paletteOps = usePaletteOpsStub();

  const {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    runningSessionsCount,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    filteredProjects,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    loadingMoreProjects,
    loadMoreSessionsForProject,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    activeSessions,
    isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onLoadMoreSessions,
    onProjectDelete,
    setCurrentProject,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
  });

  const { width: sidebarWidth, setWidth: setSidebarWidth, resetWidth: resetSidebarWidth } = useSidebarWidth();

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  const handleProjectCreated = (created?: Record<string, unknown>) => {
    void refreshProjects();
    if (!created) {
      return;
    }
    const projectId = typeof created.projectId === 'string' ? created.projectId : undefined;
    if (!projectId) {
      return;
    }
    // The create/clone response carries projectId/displayName/fullPath/path,
    // which satisfies Project's required fields (sessions etc. are optional).
    // Jump straight into a new session for the just-created project so the
    // user lands in it instead of having to hunt for it in the list.
    const project: Project = {
      projectId,
      displayName:
        typeof created.displayName === 'string'
          ? created.displayName
          : typeof created.path === 'string'
            ? created.path
            : '',
      fullPath:
        typeof created.fullPath === 'string'
          ? created.fullPath
          : typeof created.path === 'string'
            ? created.path
            : '',
      path: typeof created.path === 'string' ? created.path : undefined,
      isStarred: Boolean(created.isStarred),
      sessions: [],
    };
    onNewSession(project);
  };

  const projectListProps: SidebarProjectListProps = {
    projects,
    filteredProjects,
    selectedProject,
    selectedSession,
    isLoading,
    loadingProgress,
    expandedProjects,
    editingProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    editingSession,
    editingSessionName,
    deletingProjects,
    tasksEnabled,
    mcpServerStatus,
    getProjectSessions,
    loadingMoreProjects,
    activeSessions,
    attentionSessionIds,
    isProjectStarred,
    onEditingNameChange: setEditingName,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onStartEditingProject: startEditing,
    onCancelEditingProject: cancelEditing,
    onSaveProjectName: (projectName) => {
      void saveProjectName(projectName);
    },
    onDeleteProject: requestProjectDelete,
    onSessionSelect: handleSessionClick,
    onDeleteSession: showDeleteSessionConfirmation,
    onLoadMoreSessions: loadMoreSessionsForProject,
    onNewSession,
    onEditingSessionNameChange: setEditingSessionName,
    onStartEditingSession: (sessionId, initialName) => {
      setEditingSession(sessionId);
      setEditingSessionName(initialName);
    },
    onCancelEditingSession: () => {
      setEditingSession(null);
      setEditingSessionName('');
    },
    onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    t,
  };

  return (
    <>
        <SidebarModals
          projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        deleteConfirmation={deleteConfirmation}
        onCancelDeleteProject={() => setDeleteConfirmation(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        sessionDeleteConfirmation={sessionDeleteConfirmation}
        onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={confirmDeleteSession}
        showVersionModal={showVersionModal}
        onCloseVersionModal={() => setShowVersionModal(false)}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        installMode={installMode}
        t={t}
      />

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          updateAvailable={updateAvailable}
          restartRequired={restartRequired}
          onShowVersionModal={() => setShowVersionModal(true)}
          t={t}
        />
      ) : (
        <>
        <SidebarContent
            activeSessionId={selectedSession?.id ?? null}
            onAssistantSessionSelect={onAssistantSessionSelect}
            isPWA={isPWA}
            isMobile={isMobile}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            onReset={resetSidebarWidth}
            isLoading={isLoading}
            projects={projects}
            runningSessionsCount={runningSessionsCount}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => {
              setSearchFilter('');
              clearConversationResults();
            }}
            conversationResults={conversationResults}
            isSearching={isSearching}
            searchProgress={searchProgress}
            onConversationResultClick={(projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => {
              // `projectId` (DB key) is the canonical identifier post-migration.
              // The server emits null when it can't resolve a project row for
              // the search hit; treat that as "no project" and still navigate
              // to the session so the user can open it from the URL.
              const resolvedProvider = (provider || 'claude') as LLMProvider;
              const project = projectId ? projects.find(p => p.projectId === projectId) : null;
              const searchTarget = { __searchTargetTimestamp: messageTimestamp || null, __searchTargetSnippet: messageSnippet || null };
              const sessionObj = {
                id: sessionId,
                __provider: resolvedProvider,
                __projectId: projectId ?? undefined,
                ...searchTarget,
              };
              if (project) {
                handleProjectSelect(project);
                const sessions = getProjectSessions(project);
                const existing = sessions.find(s => s.id === sessionId);
                if (existing) {
                  handleSessionClick({ ...existing, ...searchTarget }, project.projectId);
                } else {
                  handleSessionClick(sessionObj, project.projectId);
                }
              } else {
                handleSessionClick(sessionObj, projectId ?? '');
              }
            }}
            onRefresh={() => {
              void refreshProjects();
            }}
            isRefreshing={isRefreshing}
            onCreateProject={() => setShowNewProject(true)}
            onCollapseSidebar={handleCollapseSidebar}
            updateAvailable={updateAvailable}
            restartRequired={restartRequired}
            releaseInfo={releaseInfo}
            latestVersion={latestVersion}
            onShowVersionModal={() => setShowVersionModal(true)}
            onShowSettings={onShowSettings}
            projectListProps={projectListProps}
            onRecentSessionSelect={(session, project) => {
              handleProjectSelect(project);
              // provider-badge selection matches `session.__provider ?? session.provider`
              // inside SidebarRecentSessions; guarantee a concrete provider for
              // SessionWithProvider before handing off to the shared click chain.
              const resolvedProvider = session.__provider ?? session.provider ?? 'claude';
              handleSessionClick({ ...session, __provider: resolvedProvider }, project.projectId);
            }}
            t={t}
          />
        </>
      )}

    </>
  );
}

export default Sidebar;
