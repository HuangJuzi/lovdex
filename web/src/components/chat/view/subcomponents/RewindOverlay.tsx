import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TurnPickerOverlay, type TurnPick } from './TurnPickerOverlay';
import { api } from '../../../../utils/api';

interface RewindOverlayProps {
  open: boolean;
  onClose: () => void;
  appId: string;
  turns: TurnPick[];
  onSwitchToNewSession: (newSessionId: string, summary: string) => void;
}

export function RewindOverlay({ open, onClose, appId, turns, onSwitchToNewSession }: RewindOverlayProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSelect(turn: TurnPick) {
    setBusy(true);
    setError(null);
    try {
      // strip composite suffix (_0, _text, etc.) down to bare provider uuid
      const bareId = turn.id.replace(/_.*$/, '');
      const res = await api.rewindSession(appId, { upToMessageId: bareId, turnTimestamp: turn.timestamp });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? 'Rewind failed');
      const warning = body.warnings?.length ? t('session.rewind.fileSkipped') : null;
      if (warning) setError(warning);
      onSwitchToNewSession(body.newSessionId, turn.summary);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rewind failed');
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
      title={t('session.rewind.title')}
      emptyLabel={t('session.rewind.empty')}
      onSelect={handleSelect}
    />
  );
}
