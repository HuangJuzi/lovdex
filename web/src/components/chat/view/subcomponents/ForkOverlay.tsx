import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui/Dialog';
import { api } from '../../../../utils/api';

interface ForkOverlayProps {
  open: boolean;
  onClose: () => void;
  appId: string;
  summary: string;
  onSwitchToNewSession: (newSessionId: string, summary: string) => void;
}

export function ForkOverlay({ open, onClose, appId, summary, onSwitchToNewSession }: ForkOverlayProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const res = await api.forkSession(appId, {});
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? 'Fork failed');
        if (cancelled) return;
        onSwitchToNewSession(body.newSessionId, summary);
        onClose();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Fork failed');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, appId, summary, onSwitchToNewSession, onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-w-md flex-col gap-3 p-4">
        <DialogTitle>{t('session.fork.title')}</DialogTitle>
        {busy && <div className="text-sm opacity-70">{t('session.fork.busy')}</div>}
        {error && <div className="text-sm text-red-500">{error}</div>}
      </DialogContent>
    </Dialog>
  );
}
