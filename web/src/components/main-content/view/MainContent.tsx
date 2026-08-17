import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../types/types';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useLinkedTask } from '../../../hooks/useLinkedTask';
import { FilePreviewModal } from '../../file-preview/FilePreviewModal';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { STATUS_META } from '../../tasks/taskStatus';
import { ConvertToTaskDialog } from '../../chat/view/subcomponents/ConvertToTaskDialog';
import { Button } from '../../../shared/view/ui';
import { Eye, RefreshCw } from 'lucide-react';

import MobileMenuButton from './subcomponents/MobileMenuButton';
import MainContentTitle from './subcomponents/MainContentTitle';
import MainContentStateView from './subcomponents/MainContentStateView';
import MainContentTabs from './subcomponents/MainContentTabs';
import ErrorBoundary from './ErrorBoundary';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import FileTree from '../../file-tree/view/FileTree';
import GitPanel from '../../git-panel/view/GitPanel';

// Simplified edition: chat, files and git tabs remain. Shell, task-master,
// browser-use and plugin panels were removed.
function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  onProjectSelect,
  onProjectsRefresh,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  onResumeSession,
  onSwitchToNewSession,
  externalMessageUpdate,
  newSessionTrigger,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const [preview, setPreview] = useState<{ filePath: string; line?: number } | null>(null);

  const navigate = useNavigate();
  const { task: linkedTask } = useLinkedTask(selectedSession?.id ?? null);
  const [convertOpen, setConvertOpen] = useState(false);
  const sessionRunning = selectedSession ? processingSessions.has(selectedSession.id) : false;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen: handleEditorOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({ selectedProject, isMobile });

  // Resolve bare/partial refs (e.g. `foo.ts`) against the project file tree,
  // then open the read-only preview modal.
  const handleFileOpen = useFileOpenResolver(selectedProject, (filePath: string) => {
    setPreview({ filePath });
  });

  return (
    <div className="flex h-full flex-col">
      <header className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <MainContentTabs
          activeTab={activeTab}
          onSelect={(tab) => setActiveTab(tab)}
          className="ml-1 flex-shrink-0"
        />
        {selectedProject && (
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={false}
          />
        )}
        {selectedProject && selectedSession && !linkedTask && (
          <Button
            variant="chunky"
            size="toolbar"
            className="ml-auto"
            onClick={() => setConvertOpen(true)}
            title="转为任务"
            aria-label="转为任务"
          >
            <RefreshCw />
            {/* 移动端（<640px）只留图标 */}
            <span className="hidden sm:inline">转为任务</span>
          </Button>
        )}
        {selectedProject && linkedTask && (
          <Button
            variant="chunky"
            size="toolbar"
            className="ml-auto"
            onClick={() => navigate(`/task/${linkedTask.task_id}`)}
            title="查看任务"
            aria-label="查看任务"
          >
            {/* 眼睛颜色 = 任务状态色（待办黄/进行中蓝/评审紫/完成绿），不再单独画状态圆点 */}
            <Eye style={{ color: STATUS_META[linkedTask.status].color }} />
            {/* 移动端（<640px）只留状态色眼睛图标 */}
            <span className="hidden sm:inline">查看任务</span>
          </Button>
        )}
      </header>

      {isLoading ? (
        <MainContentStateView mode="loading" isMobile={isMobile} />
      ) : !selectedProject ? (
        <MainContentStateView mode="empty" isMobile={isMobile} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className={`flex min-h-0 min-w-[200px] flex-1 flex-col overflow-hidden ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <div className="h-full">
              <ErrorBoundary showDetails>
                <ChatInterface
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                  ws={ws}
                  sendMessage={sendMessage}
                  onFileOpen={handleFileOpen}
                  onInputFocusChange={onInputFocusChange}
                  onSessionProcessing={onSessionProcessing}
                  onSessionIdle={onSessionIdle}
                  processingSessions={processingSessions}
                  onNavigateToSession={onNavigateToSession}
                  onSessionEstablished={onSessionEstablished}
                  onShowSettings={onShowSettings}
                  onResumeSession={onResumeSession}
                  onSwitchToNewSession={onSwitchToNewSession}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  sendByCtrlEnter={sendByCtrlEnter}
                  externalMessageUpdate={externalMessageUpdate}
                  newSessionTrigger={newSessionTrigger}
                  onShowAllTasks={null}
                  linkedTaskModel={linkedTask ? (linkedTask.executor_model ?? null) : undefined}
                />
              </ErrorBoundary>
            </div>
          </div>

          {activeTab === 'files' && (
            <div className="h-full min-w-0 flex-1 overflow-hidden">
              <FileTree selectedProject={selectedProject} onFileOpen={handleEditorOpen} />
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full min-w-0 flex-1 overflow-hidden">
              <GitPanel
                selectedProject={selectedProject}
                isMobile={isMobile}
                onFileOpen={handleEditorOpen}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
              />
            </div>
          )}

          <EditorSidebar
            editingFile={editingFile}
            isMobile={isMobile}
            editorExpanded={editorExpanded}
            editorWidth={editorWidth}
            hasManualWidth={hasManualWidth}
            resizeHandleRef={resizeHandleRef}
            onResizeStart={handleResizeStart}
            onCloseEditor={handleCloseEditor}
            onToggleEditorExpand={handleToggleEditorExpand}
            projectPath={selectedProject?.fullPath}
            fillSpace={activeTab === 'files'}
          />
        </div>
      )}

      <FilePreviewModal
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
          }
        }}
        projectId={selectedProject?.projectId}
        filePath={preview?.filePath}
        line={preview?.line}
      />

      <ConvertToTaskDialog
        session={selectedSession}
        projectPath={selectedProject?.fullPath ?? ''}
        isRunning={sessionRunning}
        open={convertOpen}
        onOpenChange={setConvertOpen}
      />
    </div>
  );
}

export default React.memo(MainContent);
