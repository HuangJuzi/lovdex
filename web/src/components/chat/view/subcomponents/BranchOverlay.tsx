import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TurnPickerOverlay, type TurnPick } from './TurnPickerOverlay';
import { api } from '../../../../utils/api';

interface BranchOverlayProps {
  open: boolean;
  onClose: () => void;
  appId: string;
  turns: TurnPick[];
  onSwitchToNewSession: (newSessionId: string, summary: string) => void;
}

export function BranchOverlay({ open, onClose, appId, turns, onSwitchToNewSession }: BranchOverlayProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSelect(turn: TurnPick) {
    setBusy(true);
    setError(null);
    try {
      // strip composite suffix (_0, _text, etc.) down to bare provider uuid
      const bareId = turn.id.replace(/_.*$/, '');
      const res = await api.forkSession(appId, { upToMessageId: bareId });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? 'Branch failed');
      onSwitchToNewSession(body.newSessionId, turn.summary);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Branch failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <TurnPickerOverlay
      open={open}
      onClose={onClose}
      turns={turns}
      loading={busy}
      error={error}
      title={t('session.branch.title')}
      emptyLabel={t('session.branch.empty')}
      onSelect={handleSelect}
    />
  );
}
