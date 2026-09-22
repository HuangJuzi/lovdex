import ReactDOM from 'react-dom';
import { AlertTriangle, EyeOff, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../../shared/view/ui';
import ProjectCreationWizard from '../../../project-creation-wizard';
import { CreateTaskDialog } from '../../../tasks/CreateTaskDialog';
import type { Project, Task } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { DeleteProjectConfirmation, SessionDeleteConfirmation } from '../../types/types';

// Simplified edition: settings, version-upgrade, and project-creation-wizard
// modals were removed. The props are retained so upstream callers (Sidebar /
// useProjectsState) stay unchanged; only the delete confirmations render.
type InstallMode = string;

type SidebarModalsProps = {
  projects: Project[];
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showNewProject: boolean;
  onCloseNewProject: () => void;
  onProjectCreated: (project?: Record<string, unknown>) => void;
  showNewTask: boolean;
  onCloseNewTask: () => void;
  onTaskCreated: (task: Task) => void;
  deleteConfirmation: DeleteProjectConfirmation | null;
  onCancelDeleteProject: () => void;
  onConfirmDeleteProject: (deleteData?: boolean) => void;
  sessionDeleteConfirmation: SessionDeleteConfirmation | null;
  onCancelDeleteSession: () => void;
  onConfirmDeleteSession: (hardDelete?: boolean) => void;
  showVersionModal: boolean;
  onCloseVersionModal: () => void;
  releaseInfo: ReleaseInfo | null;
  currentVersion: string;
  latestVersion: string | null;
  installMode: InstallMode;
  t: TFunction;
};

export default function SidebarModals({
  showNewProject,
  onCloseNewProject,
  onProjectCreated,
  showNewTask,
  onCloseNewTask,
  onTaskCreated,
  deleteConfirmation,
  onCancelDeleteProject,
  onConfirmDeleteProject,
  sessionDeleteConfirmation,
  onCancelDeleteSession,
  onConfirmDeleteSession,
  t,
}: SidebarModalsProps) {
  return (
    <>
      {showNewProject &&
        ReactDOM.createPortal(
          <ProjectCreationWizard
            onClose={onCloseNewProject}
            onProjectCreated={onProjectCreated}
          />,
          document.body,
        )}

      {/* 与 TaskBoard 同款常挂用法：`CreateTaskDialog` 的 `open` prop 驱动它自己的
          `useProviderModels` 与表单重置，写死 `open` 会让这两条在侧栏路径上空转。
          代价是侧栏挂载时多打一次 /api/projects 与 /api/providers/installed
          （后者来自 useTaskEngineAvailability，不像 useProviderModels 那样被 open
          门控）；开关弹窗本身不会再重打 /api/projects。侧栏只在 / 、/session/:id 、
          /inbox 挂载，且这几个路由之间切换不会重挂，可以忽略。 */}
      <CreateTaskDialog open={showNewTask} onClose={onCloseNewTask} onCreated={onTaskCreated} />

      {deleteConfirmation &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-warning/10">
                    <AlertTriangle className="h-6 w-6 text-warning" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteProject')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('deleteConfirmation.confirmDelete')}{' '}
                      <span className="font-medium text-foreground">
                        {deleteConfirmation.project.displayName || deleteConfirmation.project.projectId}
                      </span>
                      ?
                    </p>
                    {deleteConfirmation.sessionCount > 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('deleteConfirmation.sessionCount', { count: deleteConfirmation.sessionCount })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onConfirmDeleteProject(false)}
                >
                  <EyeOff className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.archiveProject', 'Archive project')}
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => onConfirmDeleteProject(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteAllData')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeleteProject}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {sessionDeleteConfirmation &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-destructive/10">
                    <AlertTriangle className="h-6 w-6 text-destructive" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteSession')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('deleteConfirmation.confirmDelete')}{' '}
                      <span className="font-medium text-foreground">
                        {sessionDeleteConfirmation.sessionTitle || t('sessions.unnamed')}
                      </span>
                      ?
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {sessionDeleteConfirmation.isArchived
                        ? t('deleteConfirmation.archivedSessionNotice', 'This session is already archived. You can keep it hidden or delete it permanently.')
                        : t('deleteConfirmation.archiveSessionNotice', 'Archive keeps the session out of the active list while preserving its history.')}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                {!sessionDeleteConfirmation.isArchived && (
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onConfirmDeleteSession(false)}
                  >
                    <EyeOff className="mr-2 h-4 w-4" />
                    {t('deleteConfirmation.archiveSession', 'Archive session')}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => onConfirmDeleteSession(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeleteSession}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
