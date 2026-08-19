import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';
import { ResumeSessionOverlay } from './subcomponents/ResumeSessionOverlay';
import { BranchOverlay } from './subcomponents/BranchOverlay';
import { ForkOverlay } from './subcomponents/ForkOverlay';
import { RewindOverlay } from './subcomponents/RewindOverlay';
import type { TurnPick } from './subcomponents/TurnPickerOverlay';

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  onResumeSession,
  onSwitchToNewSession,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
  linkedTaskModel,
  onSessionModelChanged,
}: ChatInterfaceProps) {
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  // Per-session accumulated stream text. A single shared buffer corrupted
  // concurrent streams (session B's text leaked into session A's row and a
  // session B `stream_end` wiped A's buffer). Keying by session also lets the
  // same flush path serve non-active sessions instead of flooding them with
  // one row per 24-char delta chunk.
  const accumulatedStreamRef = useRef<Map<string, string>>(new Map());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current.clear();
  }, []);

  const {
    provider,
    setProvider,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    qoderModel,
    setQoderModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels,
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
    linkedTaskModel,
  });

  // Wraps the provider-state model change so the owner can write a session-
  // scoped selection back to the session's linked task (if any). Session-scoped
  // only: a default-scope pick (no session id) just changes the local default
  // and must not touch any task.
  const handleSelectProviderModel = useCallback<
    (provider: Parameters<typeof selectProviderModel>[0], model: string, sessionId?: string | null) => ReturnType<typeof selectProviderModel>
  >((_targetProvider, model, sessionId) => {
    return selectProviderModel(_targetProvider, model, sessionId).then((result) => {
      if (result.scope === 'session' && result.model && sessionId) {
        onSessionModelChanged?.(result.model, sessionId);
      }
      return result;
    });
  }, [selectProviderModel, onSessionModelChanged]);

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    handleLoadMore,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    resumeOverlayOpen,
    setResumeOverlayOpen,
    branchOverlayOpen,
    setBranchOverlayOpen,
    forkOverlayOpen,
    setForkOverlayOpen,
    rewindOverlayOpen,
    setRewindOverlayOpen,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    openFilePicker,
    getRootProps,
    getInputProps,
    getImageInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    showModelsModal,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    claudeModel,
    codexModel,
    currentProviderEffort,
    opencodeModel,
    qoderModel,
    isLoading: isProcessing,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  // Workflow card actions: hand off to Claude via a normal chat message so it
  // invokes Workflow({scriptPath}) / Workflow({scriptPath, resumeFromRunId}).
  const handleWorkflowRerun = useCallback((scriptPath: string) => {
    const sid = currentSessionId ?? selectedSession?.id;
    if (!sid) return;
    sendMessage({
      type: 'chat.send',
      sessionId: sid,
      content: `请用 scriptPath \`${scriptPath}\` 重跑这个 workflow(不带 resumeFromRunId)。`,
      options: { includePartialMessages: true },
    });
  }, [currentSessionId, selectedSession, sendMessage]);

  const handleWorkflowResume = useCallback((scriptPath: string, runId: string) => {
    const sid = currentSessionId ?? selectedSession?.id;
    if (!sid) return;
    sendMessage({
      type: 'chat.send',
      sessionId: sid,
      content: `请用 scriptPath \`${scriptPath}\` 和 resumeFromRunId \`${runId}\` 续跑这个 workflow。`,
      options: { includePartialMessages: true },
    });
  }, [currentSessionId, selectedSession, sendMessage]);

  const handleWorkflowEdit = useCallback((scriptPath: string) => {
    const sid = currentSessionId ?? selectedSession?.id;
    if (!sid) return;
    void (async () => {
      let content = '';
      try {
        const res = await fetch(`/api/sessions/${sid}/workflow-script?path=${encodeURIComponent(scriptPath)}`);
        if (res.ok) {
          const body = await res.json();
          content = body.content || '';
        }
      } catch { /* fall through to path-only message */ }
      const snippet = content
        ? `\n\n当前脚本内容:\n\`\`\`js\n${content}\n\`\`\``
        : '';
      sendMessage({
        type: 'chat.send',
        sessionId: sid,
        content: `请编辑 workflow 脚本 \`${scriptPath}\` 并(如合理)用 scriptPath 重跑。${snippet}`,
        options: { includePartialMessages: true },
      });
    })();
  }, [currentSessionId, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  // Hooks must run unconditionally on every render — this memo was previously
  // declared AFTER the `!selectedProject` early return, which changed the hook
  // order when switching between the empty state and a real session.
  const turns: TurnPick[] = useMemo(
    () =>
      chatMessages
        .filter((m) => m.id && !m.isToolUse && !m.isCompactSummary)
        .map((m) => ({
          id: m.id as string,
          summary: (m.content || m.displayText || '').slice(0, 80) || '(turn)',
          timestamp:
            typeof m.timestamp === 'string'
              ? m.timestamp
              : m.timestamp instanceof Date
                ? m.timestamp.toISOString()
                : String(m.timestamp),
        })),
    [chatMessages],
  );

  // The currently-selected model for the active provider, resolved to its
  // human label from the live catalog (falls back to the raw value before the
  // catalog loads). Drives the composer's click-to-change model indicator.
  const currentModelValue =
    provider === 'codex'
      ? codexModel
      : provider === 'opencode'
        ? opencodeModel
        : provider === 'qoder'
          ? qoderModel
          : claudeModel;
  const currentModelLabel = useMemo(() => {
    const option = providerModelCatalog[provider]?.OPTIONS.find((o) => o.value === currentModelValue);
    const label = option?.label || currentModelValue;
    // The Claude "default" pseudo-model reads oddly as a bare word; give it a
    // friendlier surface label without touching the stored value.
    return label === 'default' ? 'Default' : label;
  }, [providerModelCatalog, provider, currentModelValue]);

  if (!selectedProject) {
    const selectedProviderLabel =
      provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : provider === 'qoder'
              ? t('messageTypes.qoder', { defaultValue: 'Qoder' })
              : t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          qoderModel={qoderModel}
          setQoderModel={setQoderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={false}
          isTaskMasterInstalled={false}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          onLoadMore={handleLoadMore}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          getWorkflowState={sessionStore.getWorkflowState}
          onWorkflowEdit={handleWorkflowEdit}
          onWorkflowRerun={handleWorkflowRerun}
          onWorkflowResume={handleWorkflowResume}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={(nextEffort) => setStoredProviderEffort(provider, nextEffort)}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          modelLabel={currentModelLabel}
          onShowModelPicker={showModelsModal}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim()) || attachedFiles.length > 0 || attachedImages.length > 0}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          attachedFiles={attachedFiles}
          onRemoveFile={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          openFilePicker={openFilePicker}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          getImageInputProps={getImageInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            provider:
              provider === 'codex'
                ? t('messageTypes.codex')
                : provider === 'opencode'
                    ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                    : provider === 'qoder'
                        ? t('messageTypes.qoder', { defaultValue: 'Qoder' })
                    : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={handleSelectProviderModel}
      />
      <ResumeSessionOverlay
        open={resumeOverlayOpen}
        onClose={() => setResumeOverlayOpen(false)}
        projectId={selectedProject?.projectId ?? ''}
        provider={provider}
        onSelect={(session) => onResumeSession?.(session)}
      />
      <BranchOverlay
        open={branchOverlayOpen}
        onClose={() => setBranchOverlayOpen(false)}
        appId={currentSessionId || selectedSession?.id || ''}
        turns={turns}
        onSwitchToNewSession={(newSessionId, summary) =>
          onSwitchToNewSession?.(newSessionId, summary)
        }
      />
      <ForkOverlay
        open={forkOverlayOpen}
        onClose={() => setForkOverlayOpen(false)}
        appId={currentSessionId || selectedSession?.id || ''}
        summary={selectedSession?.summary ?? ''}
        onSwitchToNewSession={(newSessionId, summary) =>
          onSwitchToNewSession?.(newSessionId, summary)
        }
      />
      <RewindOverlay
        open={rewindOverlayOpen}
        onClose={() => setRewindOverlayOpen(false)}
        appId={currentSessionId || selectedSession?.id || ''}
        turns={turns}
        onSwitchToNewSession={(newSessionId, summary) =>
          onSwitchToNewSession?.(newSessionId, summary)
        }
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
