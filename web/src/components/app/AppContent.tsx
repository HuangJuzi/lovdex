import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import InboxPage from '../inbox/InboxPage';
import { Button, Dialog, DialogContent, DialogTitle, ToastStack, useToastStack } from '../../shared/view/ui';
import { refreshInbox, applyInboxEvent, claimUnannouncedImportant, subscribeInbox, getInboxSnapshot } from '../../stores/inboxStore';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
import { api } from '../../utils/api';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export default function AppContent() {
  return <AppContentInner />;
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  // /inbox 复用本组件只为拿到侧边栏；主内容区换成收件箱页。
  // Router 已设 basename，useLocation().pathname 是剥掉 basename 的路径。
  const { pathname } = useLocation();
  const isInboxRoute = pathname === '/inbox';
  // 工作区深链：任务页「Chat/Files/源码管理」跳转用 `?project=<path>&tab=<tab>`。
  const [searchParams] = useSearchParams();
  const projectPathParam = searchParams.get('project') ?? undefined;
  const tabParam = searchParams.get('tab') ?? undefined;
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    openSettings,
    handleSessionSelect,
    handleProjectSelect,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
  } = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
    initialProjectPath: projectPathParam,
    initialTab: tabParam,
  });

  const { setCwd } = useTerminalDrawer();

  // Keep the terminal drawer's starting directory in sync with the project the
  // user is currently in, so opening the terminal lands in that project (not ~).
  useEffect(() => {
    setCwd(selectedProject?.fullPath || selectedProject?.path || null, {
      hostId: selectedProject?.remoteHostId ?? null,
      hostName: selectedProject?.remoteHostName ?? null,
    });
  }, [selectedProject, setCwd]);

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId: selectedSession?.id ?? sessionId ?? null,
    ws,
    sendMessage,
    markSessionProcessing,
  });

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[AppContent] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  // 收件箱：全局实时 toast + 打开页面补推汇总弹窗（spec §10）。
  const { items: toasts, push: pushToast, dismiss: dismissToast } = useToastStack();
  const [summaryOpen, setSummaryOpen] = useState(false);
  // 订阅 store：AppContent 只在自身 state/props 变化时重渲染，而断线补推走的是
  // store 的 refetch。不订阅的话"弹窗已经开着"时补进来的条目不会出现在列表里
  // —— setSummaryOpen(true) 在已开时是 no-op，压根不会触发重渲染。
  const inbox = useSyncExternalStore(subscribeInbox, getInboxSnapshot, getInboxSnapshot);

  // 首挂：拉取收件箱。
  useEffect(() => {
    void refreshInbox();
  }, []);

  // 补推汇总弹窗：只要出现"本次会话还没打扰过的未读重要项"就弹一次。挂在 store
  // 订阅上，于是首挂拉取、断线重连 refetch、实时新告警三条路径都会经过它；claim
  // 自带记账，同一条只打扰一次（实时那条已由 toast 记过账，不会重复汇总）。
  //
  // 手机切后台期间产生的通知只有这条路径能发现：客户端当时没连着，收不到
  // notification_created，重连后的 refetch 只更新列表和角标、不弹任何东西 ——
  // 表现就是"收件箱有、没弹窗"。
  useEffect(() => {
    const announce = () => {
      if (claimUnannouncedImportant().length > 0) setSummaryOpen(true);
    };
    announce();
    return subscribeInbox(announce);
  }, []);

  // 全局实时 toast：新告警（created 且非 info）到达即右上角弹一条，点击跳转。
  useEffect(() => subscribe((event) => {
    const row = applyInboxEvent(event as { kind?: string; payload?: unknown });
    if (row) {
      pushToast({
        id: row.notification_id,
        severity: row.severity,
        title: row.title,
        body: row.body,
        onClick: () => {
          dismissToast(row.notification_id);
          if (row.task_id) navigate(`/task/${row.task_id}`);
          else if (row.session_id) navigate(`/session/${row.session_id}`);
        },
      });
    }
  }), [subscribe, pushToast, dismissToast, navigate]);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar {...sidebarSharedProps} />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarSharedProps} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {isInboxRoute ? (
          <InboxPage />
        ) : (
          <MainContent
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onProjectSelect={handleProjectSelect}
            onProjectsRefresh={refreshProjectsSilently}
            ws={ws}
            sendMessage={sendMessage}
            isMobile={isMobile}
            onMenuClick={() => setSidebarOpen(true)}
            isLoading={isLoadingProjects}
            onInputFocusChange={setIsInputFocused}
            onSessionProcessing={markSessionProcessing}
            onSessionIdle={markSessionIdle}
            processingSessions={processingSessions}
            onNavigateToSession={(targetSessionId: string, options) =>
              navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
            }
            onSessionEstablished={(targetSessionId, context) =>
              registerOptimisticSession({ sessionId: targetSessionId, ...context })
            }
            onShowSettings={openSettings}
            onResumeSession={handleSessionSelect}
            onSwitchToNewSession={(newSessionId, summary) => {
              if (!selectedProject) return;
              const provider =
                (selectedSession?.provider ?? selectedSession?.__provider) as
                  | import('../../types/app').LLMProvider
                  | undefined;
              registerOptimisticSession({
                sessionId: newSessionId,
                provider: provider ?? 'claude',
                project: selectedProject,
                summary,
              });
            }}
            externalMessageUpdate={externalMessageUpdate}
            newSessionTrigger={newSessionTrigger}
          />
        )}
      </div>

      <ToastStack items={toasts} onDismiss={dismissToast} />
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent>
          <DialogTitle>你有未读通知</DialogTitle>
          <div className="mt-2 space-y-1.5">
            {inbox.items.filter((it) => !it.read_at && it.severity !== 'info').slice(0, 8).map((it) => (
              <div key={it.notification_id} className="truncate text-sm">· {it.title}{it.occurrence_count > 1 ? ` ×${it.occurrence_count}` : ''}</div>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSummaryOpen(false)}>知道了</Button>
            <Button size="sm" onClick={() => { setSummaryOpen(false); navigate('/inbox'); }}>去收件箱</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
