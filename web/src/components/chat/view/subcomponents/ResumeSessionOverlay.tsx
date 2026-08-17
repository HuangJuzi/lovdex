import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../../shared/view/ui/Command';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui/Dialog';
import { api } from '../../../../utils/api';
import type { LLMProvider, ProjectSession } from '../../../../types/app';

interface ResumeSessionOverlayProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  provider: LLMProvider;
  onSelect: (session: ProjectSession) => void;
}

export function ResumeSessionOverlay({
  open,
  onClose,
  projectId,
  provider,
  onSelect,
}: ResumeSessionOverlayProps) {
  const { t } = useTranslation('chat');
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await api.projectSessions(projectId, { limit: 50, offset: 0 });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string | { message?: string };
          };
          const errorPayload = payload.error;
          const message =
            typeof errorPayload === 'string'
              ? errorPayload
              : errorPayload && typeof errorPayload === 'object' && errorPayload.message
                ? errorPayload.message
                : 'Failed to load sessions';
          throw new Error(message);
        }
        const page = (await response.json()) as { sessions?: ProjectSession[] };
        if (cancelled) return;
        setSessions(page.sessions ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load sessions');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const filtered = useMemo(() => {
    return sessions.filter((session) => {
      const p = (session.provider ?? session.__provider) as LLMProvider | undefined;
      return !p || p === provider;
    });
  }, [sessions, provider]);

  const handleSelect = useCallback(
    (session: ProjectSession) => {
      onSelect(session);
      onClose();
    },
    [onSelect, onClose],
  );

  const formatRelativeTime = (iso?: string): string => {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diffMs = Date.now() - then;
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 1) return t('session.resume.time.justNow');
    if (minutes < 60) return t('session.resume.time.mAgo', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t('session.resume.time.hAgo', { count: hours });
    const days = Math.round(hours / 24);
    return t('session.resume.time.dAgo', { count: days });
  };

  const resolveTitle = (session: ProjectSession): string =>
    session.title ?? session.summary ?? session.name ?? t('session.resume.untitled');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[min(70dvh,32rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col gap-3 p-4">
        <DialogTitle>{t('session.resume.title')}</DialogTitle>
        <Command className="flex-1 overflow-hidden">
          <CommandInput placeholder={t('session.resume.searchPlaceholder')} />
          <CommandList>
            {loading && (
              <div className="px-3 py-2 text-sm opacity-70">{t('session.resume.loading')}</div>
            )}
            {error && <div className="px-3 py-2 text-sm text-red-500">{error}</div>}
            {!loading && !error && filtered.length === 0 && (
              <CommandEmpty>{t('session.resume.empty')}</CommandEmpty>
            )}
            {!loading && !error && filtered.length > 0 && (
              <CommandGroup heading={t('session.resume.recentHeading')}>
                {filtered.map((session) => (
                  <CommandItem
                    key={session.id}
                    value={`${session.title ?? session.summary ?? session.name ?? session.id} ${session.id}`}
                    onSelect={() => handleSelect(session)}
                  >
                    <div className="flex w-full flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{resolveTitle(session)}</span>
                      <span className="text-xs opacity-60">
                        {session.messageCount != null
                          ? t('session.resume.messagesCount', { count: session.messageCount })
                          : ''}
                        {formatRelativeTime(
                          session.lastActivity ?? session.updated_at ?? session.created_at,
                        )}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
