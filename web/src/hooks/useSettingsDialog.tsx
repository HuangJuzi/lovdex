import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type SettingsDialogContextValue = {
  /** 模态是否打开。 */
  open: boolean;
  openSettings: () => void;
  closeSettings: () => void;
};

const SettingsDialogContext = createContext<SettingsDialogContextValue | null>(null);

export function SettingsDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSettings = useCallback(() => setOpen(true), []);
  const closeSettings = useCallback(() => setOpen(false), []);
  const value = useMemo<SettingsDialogContextValue>(
    () => ({ open, openSettings, closeSettings }),
    [open, openSettings, closeSettings],
  );
  return <SettingsDialogContext.Provider value={value}>{children}</SettingsDialogContext.Provider>;
}

export function useSettingsDialog(): SettingsDialogContextValue {
  const context = useContext(SettingsDialogContext);
  if (!context) throw new Error('useSettingsDialog must be used within SettingsDialogProvider');
  return context;
}
