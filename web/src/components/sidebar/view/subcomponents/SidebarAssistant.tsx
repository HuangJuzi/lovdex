import { ChevronDown, ChevronRight, Check, Edit2, MessageSquare, Plus, Settings, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, buttonVariants, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import { createOperatorSession, resetOperatorCreateFlow } from '../../../operators/operatorSession';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { LLMProvider } from '../../../../types/app';
import { ACTIVE_WINDOW_MS, getSessionDotState } from '../../utils/utils';

type OperatorSession = {
  session_id: string;
  summary: string | null;
  updated_at: string;
  created_at: string;
};

const COLLAPSE_KEY = 'lovdex:assistant:sessions-collapsed';

/**
 * Providers offered when creating a new Lovdex助手 session. Mirrors the chat
 * composer's provider list; `claude` is the default (the operator closed tool
 * set is Claude-only, but a session row is valid for every provider).
 */
const PROVIDER_OPTIONS: { id: LLMProvider; name: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'codex', name: 'Codex' },
  { id: 'qoder', name: 'Qoder' },
];

const readStoredProvider = (): LLMProvider => {
  try {
    const stored = localStorage.getItem('selected-provider');
    if (PROVIDER_OPTIONS.some((p) => p.id === stored)) return stored as LLMProvider;
  } catch {
    // SSR / test environment without localStorage
  }
  return 'claude';
};

/**
 * Compact relative time for sidebar rows (matches SidebarSessionItem):
 * <1m, Xm, Xhr, Xd.
 */
const formatCompactSessionAge = (dateString: string, currentTime: Date): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }

  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d`;
};

/**
 * 侧边栏顶部的「Lovdex助手」入口 + 其会话记录列表。
 *
 * Lovdex助手 是一个特殊的 Project（operator 工作区）：项目列表里它的工作区
 * 项目被过滤掉（isOperatorWorkspace），会话只在这里展示。折叠行为参考普通
 * Project 的整行折叠——点击 Lovdex助手 整行展开/收起会话列表，右侧 chevron
 * 指示状态。
 *
 * 会话列表（is_operator=1，按 updated_at 倒序）：
 *  - 每行 hover 出 [✎]（重命名）和 [🗑]（删除）；重命名走 api.renameSession，
 *    删除走 api.deleteSession(hard)。
 *  - 点击行用 SPA navigate 打开 /session/:id（不再整页跳转，避免闪屏）。
 *    operator 工作区项目一直保留在全局 projects state 里（仅侧边栏渲染层
 *    过滤），所以 useProjectsState 的 session 解析可以直接命中，无需 reload。
 *  - `activeSessionId`（当前打开的会话）所在行高亮，提示「正在看哪一个」。
 *
 * 挂载时拉一次 + 窗口重新获焦时刷新。[+] 弹出 provider 选择框，确认后创建
 * 会话并打开；[⚙] → /settings/operator。
 */
type SidebarAssistantProps = {
  activeSessionId?: string | null;
  onOpenSession?: (sessionId: string) => void;
};

export default function SidebarAssistant({ activeSessionId = null, onOpenSession }: SidebarAssistantProps) {
  const navigate = useNavigate();
  /** SPA 打开 Lovdex助手 会话；优先走外部回调（移动端收侧边栏），否则直接 navigate。 */
  const openSession = useCallback((sessionId: string) => {
    if (onOpenSession) {
      onOpenSession(sessionId);
      return;
    }
    navigate(`/session/${sessionId}`);
  }, [navigate, onOpenSession]);
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editContainerRef = useRef<HTMLDivElement>(null);

  // New-session dialog (provider selection). Creation happens only on explicit
  // confirm — the「+」button no longer navigates and no longer POSTs directly.
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>(readStoredProvider);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  function openNewDialog() {
    // Clear any sticky create flow so this confirm always POSTs a fresh session.
    resetOperatorCreateFlow();
    setCreateError(null);
    setNewDialogOpen(true);
  }

  async function confirmCreate() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreateError(null);
    try {
      const result = await createOperatorSession(selectedProvider);
      if (!result.ok) {
        setCreateError(
          result.reason === 'disabled'
            ? '交互式 Lovdex助手已在设置中关闭'
            : result.message ?? '创建 Lovdex助手 会话失败',
        );
        return;
      }
      try {
        localStorage.setItem('selected-provider', selectedProvider);
      } catch {
        // ignore storage failures
      }
      setNewDialogOpen(false);
      openSession(result.sessionId);
    } finally {
      creatingRef.current = false;
    }
  }

  const loadSessions = useCallback(async () => {
    try {
      const res = await api.operator.listSessions();
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { sessions?: OperatorSession[] } };
      setSessions(body?.data?.sessions ?? []);
      setNow(new Date());
    } catch {
      // swallow — the list just stays empty
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const safeLoad = async () => {
      await loadSessions();
      if (cancelled) return;
    };
    void safeLoad();
    const onFocus = () => void safeLoad();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [loadSessions]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  function startEdit(s: OperatorSession) {
    setEditingId(s.session_id);
    setEditingName(s.summary ?? '');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
  }

  async function saveEdit() {
    const id = editingId;
    const name = editingName.trim();
    if (!id) return;
    // Empty rename clears the custom summary → falls back to "新会话".
    setSessions((prev) =>
      prev.map((s) => (s.session_id === id ? { ...s, summary: name || null } : s)),
    );
    setEditingId(null);
    setEditingName('');
    try {
      const res = await api.renameSession(id, name);
      if (!res.ok) {
        console.error('rename operator session failed', res.status);
        await loadSessions();
      }
    } catch (err) {
      console.error('rename operator session failed', err);
      await loadSessions();
    }
  }

  async function deleteSession(sessionId: string) {
    if (!window.confirm('删除该 Lovdex助手 会话？历史对话记录将一并删除，不可恢复。')) return;
    setDeleting((prev) => new Set(prev).add(sessionId));
    setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    try {
      const res = await api.deleteSession(sessionId, true);
      if (!res.ok) {
        console.error('delete operator session failed', res.status);
        await loadSessions();
      }
    } catch (err) {
      console.error('delete operator session failed', err);
      await loadSessions();
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  // Dismiss the inline rename when clicking outside its panel (matches Escape).
  useEffect(() => {
    if (!editingId) return;
    const onPointerDown = (event: MouseEvent) => {
      const container = editContainerRef.current;
      if (container && !container.contains(event.target as Node)) cancelEdit();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [editingId]);

  /** One session row: open-on-click + hover rename/delete, or inline rename form. */
  const renderRow = (s: OperatorSession) => {
    const isEditing = editingId === s.session_id;
    const label = s.summary ?? '新会话';
    // Strong selected indication, matching SidebarSessionItem: the currently
    // open session gets a primary border + tint + left accent bar.
    const isSelected = activeSessionId === s.session_id;
    const sessionTimestamp = s.updated_at || s.created_at;
    const sessionIsActive = now.getTime() - new Date(sessionTimestamp).getTime() < ACTIVE_WINDOW_MS;
    const dotState = getSessionDotState(false, sessionIsActive);
    const dotLabel = dotState === 'active' ? '会话活跃中' : '会话空闲';
    const compactAge = formatCompactSessionAge(sessionTimestamp, now);
    return (
      <div key={s.session_id} className="group/row relative flex items-center">
        {isEditing ? (
          <div ref={editContainerRef} className="flex w-full items-center gap-1 px-1 py-1">
            <input
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void saveEdit();
                else if (e.key === 'Escape') cancelEdit();
              }}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <button
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20"
              onClick={(e) => {
                e.stopPropagation();
                void saveEdit();
              }}
              title="保存"
            >
              <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
            </button>
            <button
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20"
              onClick={(e) => {
                e.stopPropagation();
                cancelEdit();
              }}
              title="取消"
            >
              <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        ) : (
          <>
            <a
              href={`/session/${s.session_id}`}
              className={cn(
                buttonVariants({ variant: 'ghost' }),
                'relative h-auto w-full justify-start rounded-md border bg-card p-2 text-left font-normal transition-all duration-150 hover:bg-muted',
                isSelected
                  ? 'border-primary/50 bg-card font-medium text-card-foreground shadow-[0_3px_0_#d8d5cd,0_6px_16px_rgba(35,33,41,0.07)]'
                  : sessionIsActive
                    ? 'border-green-500/30 bg-green-50/5 hover:bg-green-50/10 dark:bg-green-900/5 dark:hover:bg-green-900/10'
                    : '',
              )}
              // Left-click keeps in-app navigation; Ctrl/Cmd/middle-click and the
              // native right-click menu use the href to open a new tab/window.
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                openSession(s.session_id);
              }}
              title={label}
            >
              {isSelected && (
                <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-primary" />
              )}
              <div className="flex w-full min-w-0 items-center gap-2">
                <span
                  role="status"
                  aria-label={dotLabel}
                  className={cn(
                    'flex-shrink-0 rounded-full',
                    dotState === 'active' && 'h-2 w-2 bg-green-500',
                    dotState === 'idle' && 'h-1.5 w-1.5 bg-amber-400',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('min-w-0 flex-1 truncate text-sm text-foreground', isSelected ? 'font-medium' : 'font-normal')}>{label}</span>
                    {compactAge && (
                      <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground transition-opacity duration-200 group-hover/row:opacity-0">
                        {compactAge}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </a>
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 opacity-0 transition-all duration-200 group-hover/row:opacity-100">
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 text-gray-600 hover:bg-gray-100 dark:bg-gray-900/20 dark:text-gray-400 dark:hover:bg-gray-900/40"
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit(s);
                }}
                title="重命名"
                aria-label="重命名"
              >
                <Edit2 className="h-3 w-3" />
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteSession(s.session_id);
                }}
                disabled={deleting.has(s.session_id)}
                title="删除会话"
                aria-label="删除会话"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const hasSessions = sessions.length > 0;
  const expanded = hasSessions && !collapsed;

  /** Collapsible list body shared by mobile + desktop (container classes differ). */
  const sessionList = (containerCls: string) =>
    expanded ? (
      <div className={cn('overflow-y-auto rounded-lg bg-muted/20 p-1', containerCls)}>
        {sessions.map(renderRow)}
      </div>
    ) : null;

  const chevron = hasSessions ? (
    collapsed ? (
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    ) : (
      <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    )
  ) : null;

  return (
    <div className="md:group group flex-shrink-0 px-2 pt-1.5 md:px-1.5">
      {/* Mobile: 显式行，按钮常驻（触屏无 hover）。点击整行折叠。 */}
      <div className="md:hidden">
        <div
          className="mx-1 flex items-center justify-between rounded-lg bg-primary/5 p-2 transition-all duration-150 active:scale-[0.98]"
          onClick={toggleCollapsed}
          title={hasSessions ? (collapsed ? '展开 Lovdex助手 会话' : '收起 Lovdex助手 会话') : 'Lovdex助手'}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <MessageSquare className="h-4 w-4 flex-shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">Lovdex助手</span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-primary active:scale-90"
              onClick={(e) => {
                e.stopPropagation();
                openNewDialog();
              }}
              title="新建 Lovdex助手 会话"
              aria-label="新建 Lovdex助手 会话"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground active:scale-90"
              onClick={(e) => {
                e.stopPropagation();
                navigate('/settings?tab=operator');
              }}
              title="Lovdex助手 设置"
              aria-label="Lovdex助手 设置"
            >
              <Settings className="h-4 w-4" />
            </button>
            {chevron}
          </div>
        </div>
        {sessionList('mr-1 mb-1 mt-0.5 ml-3 max-h-[28vh] border-l border-border pl-3')}
      </div>

      {/* Desktop: 与 SidebarProjectItem 同款 ghost Button + hover-revealed actions. */}
      <Button
        variant="ghost"
        className={cn(
          'hidden md:flex w-full justify-between p-2 h-auto font-normal hover:bg-muted',
          'bg-primary/5',
        )}
        onClick={toggleCollapsed}
        title={hasSessions ? (collapsed ? '展开 Lovdex助手 会话' : '收起 Lovdex助手 会话') : 'Lovdex助手'}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <MessageSquare className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">
            Lovdex助手
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <div
            role="button"
            tabIndex={0}
            className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-primary/20 hover:text-primary hover:ring-1 hover:ring-primary/40 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              openNewDialog();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                openNewDialog();
              }
            }}
            title="新建 Lovdex助手 会话"
            aria-label="新建 Lovdex助手 会话"
          >
            <Plus className="!h-5 !w-5" />
          </div>
          <div
            role="button"
            tabIndex={0}
            className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-foreground/15 hover:text-foreground hover:ring-1 hover:ring-foreground/30 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              navigate('/settings?tab=operator');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                navigate('/settings?tab=operator');
              }
            }}
            title="Lovdex助手 设置"
            aria-label="Lovdex助手 设置"
          >
            <Settings className="h-3.5 w-3.5" />
          </div>
          {chevron}
        </div>
      </Button>

      {/* Desktop: collapsible Lovdex助手 session history under the row. */}
      {sessionList('ml-3 mt-1 hidden max-h-[40vh] border-l border-border pl-3 md:block')}

      {/* 新建会话：先选 provider，确认后才 createSession（不再在「+」上直接建）。 */}
      <Dialog
        open={newDialogOpen}
        onOpenChange={(open) => {
          if (!creatingRef.current) setNewDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>新建 Lovdex助手 会话</DialogTitle>
          <div className="px-6 pb-2 pt-5">
            <p className="text-sm font-semibold text-foreground">选择 Provider</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              选择运行 Lovdex助手 会话使用的 Provider，确认后创建新会话。
            </p>
          </div>
          <div className="flex flex-col gap-1 px-6 py-2">
            {PROVIDER_OPTIONS.map((option) => {
              const selected = selectedProvider === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSelectedProvider(option.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    selected
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/60 hover:border-border hover:bg-muted',
                  )}
                  aria-pressed={selected}
                >
                  <SessionProviderLogo provider={option.id} className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{option.name}</span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
          {createError && (
            <div className="px-6 pb-2 text-sm text-red-500">{createError}</div>
          )}
          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-6 py-4">
            <Button
              variant="ghost"
              onClick={() => setNewDialogOpen(false)}
              disabled={creatingRef.current}
            >
              取消
            </Button>
            <Button
              variant="chunkyPrimary"
              onClick={() => void confirmCreate()}
              disabled={creatingRef.current}
            >
              {creatingRef.current ? '创建中…' : '创建会话'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
