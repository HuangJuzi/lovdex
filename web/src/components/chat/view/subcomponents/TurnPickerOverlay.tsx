import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '../../../../shared/view/ui/Command';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui/Dialog';

export interface TurnPick {
  id: string;
  summary: string;
  timestamp?: string;
}

interface TurnPickerOverlayProps {
  open: boolean;
  onClose: () => void;
  turns: TurnPick[];
  loading?: boolean;
  error?: string | null;
  title: string;
  emptyLabel: string;
  onSelect: (turn: TurnPick) => void;
}

export function TurnPickerOverlay({
  open, onClose, turns, loading, error, title, emptyLabel, onSelect,
}: TurnPickerOverlayProps) {
  const { t } = useTranslation('chat');

  const handleSelect = useCallback((turn: TurnPick) => {
    onSelect(turn);
    onClose();
  }, [onSelect, onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[min(70dvh,32rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col gap-3 p-4">
        <DialogTitle>{title}</DialogTitle>
        <Command className="flex-1 overflow-hidden">
          <CommandList>
            {loading && (
              <div className="px-3 py-2 text-sm opacity-70">{t('session.resume.loading')}</div>
            )}
            {error && <div className="px-3 py-2 text-sm text-red-500">{error}</div>}
            {!loading && !error && turns.length === 0 && (
              <CommandEmpty>{emptyLabel}</CommandEmpty>
            )}
            {!loading && !error && turns.length > 0 && (
              <CommandGroup heading={title}>
                {turns.map((turn) => (
                  <CommandItem
                    key={turn.id}
                    value={`${turn.summary} ${turn.id}`}
                    onSelect={() => handleSelect(turn)}
                  >
                    <div className="flex w-full flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{turn.summary}</span>
                      {turn.timestamp && (
                        <span className="text-xs opacity-60">{turn.timestamp}</span>
                      )}
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
